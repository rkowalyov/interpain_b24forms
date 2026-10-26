'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { REQUEST_TIMEOUT_MS, remaining, within } = require('./spravka-deadline');

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
  return (req, res, next) => req.method === 'POST' &&
    /^\/(?:spravka\/bitrix|api\/spravka\/bitrix\/logout)\/?$/i.test(req.path)
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
  htmlPath = path.join(__dirname, '..', 'spravka.html')
} = {}) {
  const sessions = new Map();
  let storage;
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
  async function call(method, token, deadline = now() + REQUEST_TIMEOUT_MS) {
    let response, data;
    try {
      data = await within(async () => {
        response = await fetchImpl(`${ORIGIN}/rest/${method}.json`, {
          method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ auth: token }).toString(),
          signal: AbortSignal.timeout(Math.min(8000, remaining(deadline, now)))
        });
        const raw = await response.text();
        if (raw.length > 65536) throw unavailable();
        return JSON.parse(raw);
      }, deadline, now);
    } catch { throw unavailable(); }
    if (data?.error || !response.ok) {
      if (response.status >= 500 || response.status === 429 ||
          ['QUERY_LIMIT_EXCEEDED','OPERATION_TIME_LIMIT'].includes(data?.error)) throw unavailable();
      throw denied();
    }
    if (!data || !Object.hasOwn(data, 'result')) throw unavailable();
    return data.result;
  }
  async function identity(token, { installing = false, deadline } = {}) {
    const app = await call('app.info', token, deadline);
    if (app?.CODE !== clientId() || !/^[1-9]\d*$/.test(String(app.ID)) || app.STATUS !== 'L') throw denied();
    if (!installing && app.INSTALLED !== true) throw denied();
    const user = await call('user.current', token, deadline);
    if (!/^[1-9]\d*$/.test(String(user?.ID)) ||
        [false,0,'0','N', 'false'].includes(user.ACTIVE)) throw denied();
    return { appId: String(app.ID), userId: String(user.ID) };
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

  async function entry(req, res) {
    headers(res);
    try {
      configured();
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
      const actor = await identity(body.AUTH_ID, { installing: !record });
      if (!record) {
        if (await call('user.admin', body.AUTH_ID) !== true) throw denied();
        record = await store().create({ ...candidate, appId: actor.appId });
      }
      if (!record || record.clientId !== candidate.clientId || record.memberId !== candidate.memberId ||
          record.appId !== actor.appId || !equal(record.applicationToken, candidate.applicationToken)) throw denied();
      if (env.SPRAVKA_B24_ENABLED !== '1') {
        return res.status(200).type('html').send('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Настройка справки</title><h1>Приложение подготовлено</h1><p>Авторизация администратора проверена, привязка приложения сохранена. Доступ к справке через приложение пока выключен.</p><p>Настройте список сотрудников в доступах приложения. После отдельного подтверждения можно включить интеграцию на сервере.</p><p><a href="/spravka" target="_blank" rel="noopener noreferrer">Резервный вход по паролю</a></p></html>');
      }
      // When self-managed installation is off, INSTALLED must already be true.
      // Revalidate after first pairing; never expose a report from an unfinished app.
      if (pairing) await identity(body.AUTH_ID);
      prune();
      if (sessions.size >= 512) throw unavailable();
      const token = `b24.${crypto.randomBytes(32).toString('base64url')}`;
      const seconds = Number(body.AUTH_EXPIRES);
      const ttl = Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_AGE, seconds * 1000) : MAX_AGE;
      const key = sessionKey(token);
      sessions.set(key, { ...actor, token: body.AUTH_ID, expires: now() + ttl });
      try {
        const html = await fs.readFile(htmlPath, 'utf8');
        const script = `<script>window.SPRAVKA_BITRIX=${JSON.stringify({ session: token })};</script>`;
        return res.status(200).type('html').send(html.replace('<script id="spravka-text">', script + '<script id="spravka-text">'));
      } catch (error) { sessions.delete(key); throw error; }
    } catch (error) {
      return res.status(error.status || 503).type('html').send(
        '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Вход в справку</title><h1>Вход через Битрикс24 недоступен</h1>' +
        `<p>${error.status === 403 ? 'Нет доступа к приложению справки. Обратитесь к администратору.' : 'Интеграция ещё не настроена или Битрикс24 временно недоступен.'}</p>` +
        '<p><a href="/spravka" target="_blank" rel="noopener noreferrer">Открыть резервный вход по паролю</a></p></html>'
      );
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
      if (actor.userId !== session.userId || actor.appId !== session.appId || session.expires <= now()) {
        sessions.delete(key); return false;
      }
      return true;
    } catch (error) {
      if (error.status === 403) { sessions.delete(key); return false; }
      throw error;
    }
  }
  function logout(req, res) {
    const token = bearer(req);
    if (token) sessions.delete(sessionKey(token));
    res.setHeader('Cache-Control','no-store');
    return res.status(204).end();
  }
  return { entry, authorize, logout };
}
module.exports = { createBitrixSpravkaApp, fileStore, sessionCors };
