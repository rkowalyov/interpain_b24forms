'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { REQUEST_TIMEOUT_MS, remaining, within } = require('./spravka-deadline');
const { withFrameReady } = require('./bitrix-spravka-frame');
const { settingsStore, installationHash, validateSettings, userId } = require('./bitrix-spravka-settings');

const PORTAL = 'interpain.bitrix24.ru';
const ORIGIN = `https://${PORTAL}`;
const MAX_AGE = 50 * 60 * 1000;
const failure = (status, message) => Object.assign(new Error(message), { status, publicMessage: message });
const denied = () => failure(403, 'Нет доступа к приложению справки. Обратитесь к администратору.');
const unavailable = () => failure(503, 'Не удалось проверить доступ в Битрикс24. Повторите попытку или используйте резервный вход.');
const equal = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest()
);

function sessionCors(legacyCors) {
  // These POSTs use explicit, unguessable credentials, not ambient cookies.
  // They must not inherit the unrelated lead-form origin allowlist.
  return (req, res, next) =>
    /^\/(?:spravka\/bitrix(?:\/report)?|api\/spravka\/bitrix\/(?:logout|admin(?:\/.*)?))\/?$/i.test(req.path)
    ? next() : legacyCors(req, res, next);
}

function fileStore(directory) {
  const resolved = path.resolve(directory);
  const root = path.resolve(__dirname, '..');
  if (!path.isAbsolute(directory) || resolved === root || resolved.startsWith(root + path.sep)) {
    throw failure(503, 'Хранилище приложения должно находиться вне каталога сайта.');
  }
  const filename = path.join(resolved, 'installation.json');
  async function privateDirectory() {
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory() || (stat.mode & 0o077)) throw unavailable();
  }
  return {
    async read() {
      try {
        await privateDirectory();
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077)) throw unavailable();
        const record = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (!record.applicationToken || !record.clientId || !record.memberId || !record.appId) throw unavailable();
        return record;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw unavailable();
      }
    },
    async create(record) {
      // No TOFU from anonymous input: caller must first prove portal/app/admin identity.
      // Existing records, including broken or rotated records, are never overwritten.
      try {
        await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
        await privateDirectory();
        await fs.writeFile(filename, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw unavailable();
      }
      return this.read();
    }
  };
}

function createBitrixSpravkaApp({
  env = process.env, fetchImpl = global.fetch, now = Date.now, store: suppliedStore,
  policyStore: suppliedPolicyStore, requestOrigin = 'https://forms.eduinterpain.ru',
  htmlPath = path.join(__dirname, '..', 'spravka.html'),
  adminHtmlPath = path.join(__dirname, '..', 'spravka-admin.html')
} = {}) {
  const sessions = new Map();
  let storage;
  let policies;
  const policyStore = () => policies ||= suppliedPolicyStore || settingsStore(
    env.SPRAVKA_B24_STATE_DIR || '/var/lib/interpain-spravka-bitrix'
  );
  const policy = record => policyStore().read(installationHash(record));
  const clientId = () => String(env.SPRAVKA_B24_CLIENT_ID || '').trim();
  function configured() {
    if (!/^[a-zA-Z0-9_.-]{4,200}$/.test(clientId())) {
      throw failure(503, 'Вход через Битрикс24 ещё не настроен. Резервный вход по паролю доступен.');
    }
  }
  function store() {
    if (!storage) storage = suppliedStore || fileStore(env.SPRAVKA_B24_STATE_DIR || '/var/lib/interpain-spravka-bitrix');
    return storage;
  }
  async function callEnvelope(method, token, deadline = now() + REQUEST_TIMEOUT_MS, params = {}) {
    let response, data;
    try {
      data = await within(async () => {
        response = await fetchImpl(`${ORIGIN}/rest/${method}.json`, {
          method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...params, auth: token }).toString(),
          signal: AbortSignal.timeout(Math.min(8000, remaining(deadline, now)))
        });
        const raw = await response.text();
        if (raw.length > 262144) throw unavailable();
        return JSON.parse(raw);
      }, deadline, now);
    } catch { throw unavailable(); }
    if (data?.error || !response.ok) {
      if (response.status >= 500 || response.status === 429 ||
          ['QUERY_LIMIT_EXCEEDED','OPERATION_TIME_LIMIT'].includes(data?.error)) throw unavailable();
      throw denied();
    }
    if (!data || !Object.hasOwn(data, 'result')) throw unavailable();
    return data;
  }
  const call = async (method, token, deadline, params) => (await callEnvelope(method, token, deadline, params)).result;
  const active = value => [true, 1, '1', 'Y', 'true'].includes(value);
  async function identity(token, { installing = false, deadline } = {}) {
    const app = await call('app.info', token, deadline);
    if (app?.CODE !== clientId() || !/^[1-9]\d*$/.test(String(app.ID)) || app.STATUS !== 'L') throw denied();
    if (!installing && app.INSTALLED !== true) throw denied();
    const user = await call('user.current', token, deadline);
    // user.current does not document USER_TYPE; never require an undocumented
    // response field. Internal staff membership is proved using user.get below.
    if (!userId(String(user?.ID)) || !active(user.ACTIVE) ||
        (user.USER_TYPE !== undefined && user.USER_TYPE !== 'employee')) throw denied();
    return { appId: String(app.ID), userId: String(user.ID),
      name: [user.LAST_NAME, user.NAME, user.SECOND_NAME].filter(v => typeof v === 'string').join(' ').slice(0, 250) };
  }
  function headers(res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.removeHeader('X-Frame-Options');
    const previous = String(res.getHeader('Content-Security-Policy') || '');
    const directives = previous.split(';').map(value => value.trim())
      .filter(value => value && !/^frame-ancestors\b/i.test(value));
    res.setHeader('Content-Security-Policy', [...directives, `frame-ancestors ${ORIGIN}`].join('; '));
  }
  function prune() {
    for (const [key, session] of sessions) if (session.expires <= now()) sessions.delete(key);
  }
  const sessionKey = token => crypto.createHash('sha256').update(token).digest('hex');
  const bearer = req => /^Bearer (b24\.[a-zA-Z0-9_-]{43})$/.exec(req.headers?.authorization || '')?.[1];
  const adminBearer = req => /^Bearer (b24a\.[a-zA-Z0-9_-]{43})$/.exec(req.headers?.authorization || '')?.[1];
  const json = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
  function mint(actor, oauth, seconds, record, kind = 'report') {
    prune();
    if (sessions.size >= 512) throw unavailable();
    const token = `${kind === 'admin' ? 'b24a' : 'b24'}.${crypto.randomBytes(32).toString('base64url')}`;
    const ttl = Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_AGE, seconds * 1000) : MAX_AGE;
    const session = { ...actor, kind, token: oauth, expires: now() + ttl, binding: installationHash(record),
      csrf: crypto.randomBytes(32).toString('base64url') };
    sessions.set(sessionKey(token), session);
    return { token, session };
  }
  async function reportHtml(token) {
    const html = await fs.readFile(htmlPath, 'utf8');
    return withFrameReady(html.replace('<script id="spravka-text">',
      `<script>window.SPRAVKA_BITRIX=${json({ session: token })};</script><script id="spravka-text">`));
  }

  async function entry(req, res) {
    headers(res);
    try {
      configured();
      const deadline = now() + REQUEST_TIMEOUT_MS;
      const body = req.body || {};
      const domain = req.query?.DOMAIN ?? body.DOMAIN;
      if (domain !== PORTAL || (body.DOMAIN !== undefined && body.DOMAIN !== PORTAL)) throw denied();
      for (const key of ['AUTH_ID','APPLICATION_TOKEN','member_id']) {
        if (typeof body[key] !== 'string' || !/^[a-zA-Z0-9_.-]{16,2048}$/.test(body[key])) throw denied();
      }
      const candidate = {
        clientId: clientId(), memberId: body.member_id, applicationToken: body.APPLICATION_TOKEN
      };
      let record = await store().read();
      const pairing = !record;
      if (record && (record.clientId !== candidate.clientId ||
          record.memberId !== candidate.memberId || !equal(record.applicationToken, candidate.applicationToken))) throw denied();
      const actor = await identity(body.AUTH_ID, { installing: !record, deadline });
      const isAdmin = await call('user.admin', body.AUTH_ID, deadline) === true;
      if (!record) {
        if (!isAdmin) throw denied();
        record = await store().create({ ...candidate, appId: actor.appId });
      }
      if (!record || record.clientId !== candidate.clientId || record.memberId !== candidate.memberId ||
          record.appId !== actor.appId || !equal(record.applicationToken, candidate.applicationToken)) throw denied();
      // When self-managed installation is off, INSTALLED must already be true.
      // Revalidate after first pairing; never expose a report from an unfinished app.
      if (pairing) await identity(body.AUTH_ID, { deadline });
      if (!isAdmin) {
        const settings = await policy(record);
        if (env.SPRAVKA_B24_ENABLED !== '1' || !settings.enabled || !settings.allowedUserIds.includes(actor.userId)) throw denied();
        const staff = await employees({token: body.AUTH_ID}, {ids:[actor.userId],deadline});
        if (staff.users.length !== 1 || staff.users[0].id !== actor.userId) throw denied();
      }
      const { token, session } = mint(actor, body.AUTH_ID, Number(body.AUTH_EXPIRES), record, isAdmin ? 'admin' : 'report');
      try {
        if (!isAdmin) return res.status(200).type('html').send(await reportHtml(token));
        const html = await fs.readFile(adminHtmlPath, 'utf8');
        return res.status(200).type('html').send(withFrameReady(html.replace('/* SPRAVKA_ADMIN_BOOTSTRAP */',
          `window.SPRAVKA_ADMIN=${json({ session: token, csrf: session.csrf })};`)));
      } catch (error) { sessions.delete(sessionKey(token)); throw error; }
    } catch (error) {
      return res.status(error.status || 503).type('html').send(withFrameReady(
        '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Вход в справку</title><h1>Вход через Битрикс24 недоступен</h1>' +
        `<p>${error.status === 403 ? 'Нет доступа к приложению справки. Обратитесь к администратору.' : 'Интеграция ещё не настроена или Битрикс24 временно недоступен.'}</p>` +
        '<p><a href="/spravka" target="_blank" rel="noopener noreferrer">Открыть резервный вход по паролю</a></p></html>'
      ));
    }
  }
  async function authorize(req, { deadline = now() + REQUEST_TIMEOUT_MS } = {}) {
    const token = bearer(req);
    if (!token || env.SPRAVKA_B24_ENABLED !== '1') return false;
    configured(); prune();
    const key = sessionKey(token), session = sessions.get(key);
    if (!session) return false;
    try {
      // Never cache this check: Bitrix24 user_access_error must precede report cache.
      const actor = await identity(session.token, { deadline });
      if (session.kind !== 'report' || actor.userId !== session.userId || actor.appId !== session.appId || session.expires <= now()) {
        sessions.delete(key); return false;
      }
      const record = await store().read();
      if (!record || installationHash(record) !== session.binding) { sessions.delete(key); return false; }
      const settings = await policy(record);
      if (!settings.enabled || !settings.allowedUserIds.includes(actor.userId)) { sessions.delete(key); return false; }
      const staff = await employees(session, {ids:[actor.userId],deadline});
      if (staff.users.length !== 1 || staff.users[0].id !== actor.userId) { sessions.delete(key); return false; }
      return true;
    } catch (error) {
      if (error.status === 403) { sessions.delete(key); return false; }
      throw error;
    }
  }
  function logout(req, res) {
    const token = bearer(req) || adminBearer(req);
    if (token) sessions.delete(sessionKey(token));
    res.setHeader('Cache-Control','no-store');
    return res.status(204).end();
  }
  async function revalidate(req) {
    // Local final gate: an administrator may revoke a grant during a long scan.
    // OAuth was already checked for this request; do not repeat network calls.
    prune();
    const token = bearer(req), session = token && sessions.get(sessionKey(token));
    if (env.SPRAVKA_B24_ENABLED !== '1' || !session || session.kind !== 'report') return false;
    const record = await store().read();
    if (!record || installationHash(record) !== session.binding) return false;
    const settings = await policy(record);
    return settings.enabled && settings.allowedUserIds.includes(session.userId);
  }
  async function adminSession(req, deadline) {
    configured(); prune();
    const token = adminBearer(req), session = token && sessions.get(sessionKey(token));
    if (!session || session.kind !== 'admin') throw failure(401, 'Заново откройте приложение в Битрикс24.');
    if (req.headers?.origin && req.headers.origin !== requestOrigin) throw denied();
    if (!['GET','HEAD'].includes(req.method) && !equal(req.headers?.['x-spravka-csrf'] || '', session.csrf)) throw denied();
    try {
      const actor = await identity(session.token, { deadline });
      const record = await store().read();
      if (actor.userId !== session.userId || actor.appId !== session.appId || session.expires <= now() ||
          !record || installationHash(record) !== session.binding ||
          await call('user.admin', session.token, deadline) !== true) throw denied();
      return { session, record, actor };
    } catch (e) {
      if (e.status === 403) sessions.delete(sessionKey(token));
      throw e;
    }
  }
  async function employees(session, { start = 0, query = '', ids, deadline }) {
    const params = { start: String(start), sort: 'ID', order: 'ASC',
      'FILTER[ACTIVE]': 'true', 'FILTER[USER_TYPE]': 'employee' };
    ['ID','NAME','LAST_NAME','SECOND_NAME','WORK_POSITION','ACTIVE','USER_TYPE'].forEach((f,i) => params[`select[${i}]`] = f);
    if (query) params['FILTER[NAME_SEARCH]'] = query;
    if (ids) {
      if (!ids.length) return { users: [], next: null };
      ids.forEach((id,i) => params[`FILTER[ID][${i}]`] = id);
    }
    const data = await callEnvelope('user.get', session.token, deadline, params);
    if (!Array.isArray(data.result) || data.result.length > 50) throw unavailable();
    const users = data.result.map(user => {
      if (!userId(String(user.ID)) || !active(user.ACTIVE) || user.USER_TYPE !== 'employee') throw unavailable();
      return { id: String(user.ID),
        name: [user.LAST_NAME,user.NAME,user.SECOND_NAME].filter(v=>typeof v==='string').join(' ').slice(0,250) || `Сотрудник №${user.ID}`,
        position: typeof user.WORK_POSITION === 'string' ? user.WORK_POSITION.slice(0,250) : '' };
    });
    let next = data.next == null ? null : Number(data.next);
    if (next === null && Number(data.total) > start + users.length) next = start + users.length;
    if (next !== null && (!Number.isSafeInteger(next) || next <= start || next > 100000 || !users.length)) throw unavailable();
    if (new Set(users.map(u=>u.id)).size !== users.length) throw unavailable();
    return { users, next };
  }
  async function admin(req, res) {
    headers(res);
    try {
      const deadline = now() + REQUEST_TIMEOUT_MS;
      const { session, record, actor } = await adminSession(req, deadline);
      const action = req.params?.action;
      const current = await policy(record);
      if (action === 'state' && req.method === 'GET') {
        let version = null;
        try {
          const meta = JSON.parse(await fs.readFile(path.join(__dirname,'..','release.json'),'utf8'));
          if (/^[a-f0-9]{40}$/.test(meta.commit)) version = meta.commit;
        } catch {}
        return res.json({ settings: current, serverEnabled: env.SPRAVKA_B24_ENABLED === '1', actor,
          portal: PORTAL, appId: record.appId, version,
          canOpenReport: env.SPRAVKA_B24_ENABLED === '1' && current.enabled && current.allowedUserIds.includes(actor.userId) });
      }
      if (action === 'employees' && req.method === 'GET') {
        const start = Number(req.query?.start ?? 0), query = req.query?.query ?? '';
        if (!Number.isSafeInteger(start) || start < 0 || start > 100000 ||
            typeof query !== 'string' || query.length > 100 ||
            (req.query?.selected !== undefined && req.query.selected !== '1')) throw failure(400,'Некорректный запрос сотрудников.');
        return res.json(await employees(session, { start, query, ids: req.query?.selected === '1' ? current.allowedUserIds : undefined, deadline }));
      }
      if (action === 'settings' && req.method === 'PUT') {
        const next = validateSettings(req.body);
        if (next.enabled && env.SPRAVKA_B24_ENABLED !== '1') throw failure(409, 'Вход пока выключен на сервере. Требуется отдельно согласованное включение.');
        if (next.revision !== current.revision) throw failure(409, 'Настройки изменились. Обновите страницу.');
        // Never trust browser-provided names or IDs, including inactive/extranet users.
        let start = 0; const found = new Set();
        do {
          const page = await employees(session, { start, ids: next.allowedUserIds, deadline });
          for (const user of page.users) {
            if (!next.allowedUserIds.includes(user.id) || found.has(user.id)) throw unavailable();
            found.add(user.id);
          }
          start = page.next;
        } while (start !== null);
        if (found.size !== next.allowedUserIds.length) throw failure(400, 'Список содержит недоступного или уволенного сотрудника. Обновите список.');
        // Staff validation can take several pages; prove admin rights again
        // immediately before the compare-and-swap write.
        await adminSession(req, deadline);
        const saved = await policyStore().write(session.binding, next.revision, next);
        // Revoke now, not only at the next request. Admin access is independent.
        for (const [key, other] of sessions) if (other.kind === 'report' &&
            (!saved.enabled || !saved.allowedUserIds.includes(other.userId))) sessions.delete(key);
        return res.json({ settings: saved });
      }
      if (action === 'report' && req.method === 'POST') {
        if (env.SPRAVKA_B24_ENABLED !== '1' || !current.enabled || !current.allowedUserIds.includes(actor.userId)) {
          throw Object.assign(failure(403, 'Вход в справку выключен или вас нет в сохранённом списке доступа.'), { code: 'REPORT_NOT_ALLOWED' });
        }
        const grant = mint(actor, session.token, (session.expires-now())/1000, record);
        return res.json({ session: grant.token });
      }
      if (action === 'check' && req.method === 'POST') {
        return res.json({ ok: true, checkedAt: new Date(now()).toISOString(), appId: actor.appId, userId: actor.userId });
      }
      res.setHeader('Allow', action === 'settings' ? 'PUT' : ['check','report'].includes(action) ? 'POST' : 'GET');
      return res.status(405).json({ error: 'Метод не поддерживается.' });
    } catch (e) {
      return res.status(e.status || 503).json({ error: e.publicMessage || 'Не удалось обработать запрос приложения.',
        ...(e.code === 'REPORT_NOT_ALLOWED' ? { code: e.code } : {}) });
    }
  }
  async function openReport(req, res) {
    headers(res);
    try {
      const token = req.body?.session;
      if (typeof token !== 'string' || !await authorize({ headers: { authorization: `Bearer ${token}` } })) throw denied();
      return res.type('html').send(await reportHtml(token));
    } catch (e) { return res.status(e.status || 503).type('html').send(withFrameReady(
      '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Доступ к справке</title><h1>Справка недоступна</h1><p>Заново откройте приложение или используйте <a href="/spravka" target="_blank" rel="noopener noreferrer">резервный вход</a>.</p></html>'
    )); }
  }
  async function cacheTtl() {
    // Cache tuning cannot break the independent Basic login when state is offline.
    try { const record = await store().read(); return record ? (await policy(record)).cacheSeconds * 1000 : 60000; }
    catch { return 60000; }
  }
  return { entry, authorize, revalidate, logout, admin, openReport, cacheTtl };
}
module.exports = { createBitrixSpravkaApp, fileStore, sessionCors };
