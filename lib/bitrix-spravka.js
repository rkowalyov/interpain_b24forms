const crypto = require('node:crypto');
const { getWebhookBase, extractCityFromVenue } = require('./bitrix-event-api');

const GROUPS = {
  paid: ['Оплачено, Собрать документы'],
  checkIndividual: ['Проверить оплату ФЛ'],
  checkCompany: ['Оформить договор/счет ЮЛ', 'Проверить оплату ЮЛ'],
  declined: ['Не приехали (проигранная)', 'Отмена с возвратом', 'Не успешно отучились']
};

/** @typedef {{id:number, code:string, title:string, city:string, url:string,
 * counts:{paid:number, checkIndividual:number, checkCompany:number, declined:number}}} ReportEvent */
const norm = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru')
  .replace(/ё/g, 'е').replace(/\s*([,/])\s*/g, '$1').replace(/\s+/g, ' ').trim();

function safeEqual(a, b) {
  const digest = value => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function authorized(req, env) {
  const header = req.headers?.authorization || '';
  if (!/^Basic /i.test(header)) return false;
  const value = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = value.indexOf(':');
  if (colon < 0) return false;
  const userOK = safeEqual(value.slice(0, colon), env.SPRAVKA_USERNAME || 'report');
  const passwordOK = safeEqual(value.slice(colon + 1), env.SPRAVKA_PASSWORD);
  return userOK && passwordOK;
}

function reportError(message, code = 'CONFIGURATION_ERROR') {
  return Object.assign(new Error(message), { publicMessage: message, code });
}

function createClient(base, fetchImpl = global.fetch) {
  const deadline = Date.now() + 55000;
  async function call(method, params = {}) {
    if (Date.now() >= deadline) throw reportError('Слишком большой отчёт: превышено время загрузки.', 'TIMEOUT');
    let response;
    try {
      response = await fetchImpl(`${base}/${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(Math.min(12000, deadline - Date.now()))
      });
    } catch {
      throw reportError('Битрикс24 не ответил вовремя. Повторите загрузку.', 'UPSTREAM_UNAVAILABLE');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.error) {
      // Never return upstream descriptions: they may contain webhook URLs.
      throw reportError(`Не удалось прочитать данные Битрикс24 (${method}). Повторите запрос или проверьте настройки интеграции.`, 'UPSTREAM_ERROR');
    }
    return data;
  }
  async function list(method, params = {}, key) {
    const rows = [];
    const seen = new Set();
    let start = 0;
    for (;;) {
      if (seen.has(start)) throw reportError('Битрикс24 повторил страницу данных.', 'PAGINATION_ERROR');
      seen.add(start);
      const data = await call(method, { ...params, start });
      const page = key ? data.result?.[key] : data.result;
      if (!Array.isArray(page)) throw reportError(`Неожиданный ответ ${method}.`, 'RESPONSE_ERROR');
      rows.push(...page);
      if (data.next === undefined || data.next === null) break;
      start = Number(data.next);
      if (!Number.isFinite(start) || start < 0) throw reportError('Некорректная следующая страница.', 'PAGINATION_ERROR');
    }
    return rows;
  }
  return { call, list };
}

function findField(fields, label, override) {
  if (override) {
    if (!fields[override]) throw reportError(`Поле ${override} отсутствует в смарт-процессе.`);
    return override;
  }
  const matches = Object.entries(fields).filter(([, field]) =>
    [field.title, field.formLabel, field.listLabel].some(value => norm(value) === norm(label)));
  if (matches.length !== 1) throw reportError(`Не удалось однозначно определить поле «${label}». Укажите его код в настройках справки.`);
  return matches[0][0];
}

function stageGroups(statuses, env) {
  const deals = statuses.filter(stage => /^DEAL_STAGE(?:_\d+)?$/.test(stage.ENTITY_ID));
  const mapping = {};
  for (const [group, labels] of Object.entries(GROUPS)) {
    const override = env[`SPRAVKA_STAGES_${group.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`];
    if (override) {
      const ids = override.split(',').map(value => value.trim()).filter(Boolean);
      if (!ids.length || ids.some(id => !deals.some(stage => stage.STATUS_ID === id))) {
        throw reportError(`Проверьте коды стадий группы ${group}.`);
      }
      mapping[group] = ids;
      continue;
    }
    mapping[group] = [];
    for (const label of labels) {
      const aliases = [norm(label)];
      // "(проигранная)" can be a UI semantic annotation rather than part of NAME.
      if (label === 'Не приехали (проигранная)') aliases.push(norm('Не приехали'));
      const found = deals.filter(stage => aliases.includes(norm(stage.NAME)));
      if (!found.length) throw reportError(`Не найдена стадия сделок «${label}». Проверьте её название или настройте коды стадий.`);
      mapping[group].push(...found.map(stage => stage.STATUS_ID));
    }
    mapping[group] = [...new Set(mapping[group])];
  }
  const all = Object.values(mapping).flat();
  if (new Set(all).size !== all.length) throw reportError('Одна стадия указана в нескольких группах подсчёта.');
  return mapping;
}

function cleanCity(value) {
  return String(value || '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

async function buildReport(client, env, base) {
  const entityTypeId = Number(env.EVENT_ENTITY_TYPE_ID || 1036);
  const statuses = await client.list('crm.status.list', { order: { ID: 'ASC' } });
  const eventStages = statuses.filter(stage =>
    stage.ENTITY_ID.startsWith(`DYNAMIC_${entityTypeId}_STAGE_`) && norm(stage.NAME) === norm('Реализация')
  ).map(stage => stage.STATUS_ID);
  if (!eventStages.length) throw reportError('Не найдена стадия «Реализация» в мероприятиях.');

  const fieldsResponse = await client.call('crm.item.fields', { entityTypeId });
  const fields = fieldsResponse.result?.fields || {};
  const codeField = findField(fields, 'Кодовое обозначение', env.SPRAVKA_CODE_FIELD);
  const cityField = env.SPRAVKA_CITY_FIELD || null;
  const venueField = env.SPRAVKA_VENUE_FIELD || 'ufCrm21EventAddr';
  if (cityField && !fields[cityField]) throw reportError('Настроенное поле города отсутствует.');
  if (!cityField && !fields[venueField]) throw reportError('Не найдено поле места проведения. Настройте SPRAVKA_CITY_FIELD или SPRAVKA_VENUE_FIELD.');
  const groups = stageGroups(statuses, env);
  const items = await client.list('crm.item.list', {
    entityTypeId,
    filter: { '@stageId': eventStages },
    select: ['id', 'title', 'stageId', codeField, cityField || venueField],
    order: { id: 'ASC' }
  }, 'items');
  const unique = new Map();
  for (const item of items) {
    if (!eventStages.includes(item.stageId)) continue;
    const code = String(item[codeField] || '').trim();
    if (!code) throw reportError(`У мероприятия ID ${item.id} не заполнено «Кодовое обозначение». Справка не сформирована.`);
    const origin = new URL(base).origin;
    unique.set(String(item.id), {
      id: Number(item.id), code, title: String(item.title || `Мероприятие ${item.id}`),
      city: cleanCity(cityField ? item[cityField] : extractCityFromVenue(item[venueField])),
      url: `${origin}/page/meropriyatiya/meropriyatiya/type/${entityTypeId}/details/${item.id}/`,
      counts: { paid: 0, checkIndividual: 0, checkCompany: 0, declined: 0 }
    });
  }
  const warnings = [];
  for (const event of unique.values()) {
    if (!event.city) warnings.push(`Не определён город: ${event.code}.`);
  }
  const linkField = env.SPRAVKA_DEAL_EVENT_FIELD || 'UF_CRM_DEAL_1738519959225';
  const ids = [...unique.keys()];
  const seenDeals = new Set();
  const allStages = Object.values(groups).flat();
  // Scalar equality works on portals that return HTTP 500 for IN on this custom field.
  // Keep stage filtering, full pagination and cross-request deal deduplication.
  for (const eventId of ids) {
    const deals = await client.list('crm.deal.list', {
      filter: { [`=${linkField}`]: eventId, '@STAGE_ID': allStages },
      select: ['ID', 'STAGE_ID', linkField],
      order: { ID: 'ASC' }
    });
    for (const deal of deals) {
      if (seenDeals.has(String(deal.ID))) continue;
      seenDeals.add(String(deal.ID));
      const links = Array.isArray(deal[linkField]) ? deal[linkField] : [deal[linkField]];
      for (const id of new Set(links.map(value => String(value).trim()))) {
        const event = unique.get(id);
        if (!event) continue;
        for (const [group, stages] of Object.entries(groups)) {
          if (stages.includes(deal.STAGE_ID)) event.counts[group]++;
        }
      }
    }
  }
  const events = [...unique.values()].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  return {
    generatedAt: new Date().toISOString(), source: 'bitrix24', events, warnings,
    scope: 'Мероприятия в стадии «Реализация». Количество связанных сделок.',
    stageMapping: groups
  };
}

function createSpravkaHandler({ env = process.env, clientFactory = createClient, authorize = authorized } = {}) {
  let cache = null;
  let cachedAt = 0;
  let pending = null;
  return async function spravkaHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Метод не поддерживается.' });
    }
    if (!env.SPRAVKA_PASSWORD || env.SPRAVKA_PASSWORD.length < 16) {
      return res.status(503).json({ error: 'Справка не настроена: задайте SPRAVKA_PASSWORD длиной не менее 16 символов на сервере.' });
    }
    try {
      if (!await authorize(req, env)) return res.status(401).json({ error: 'Вход не подтверждён. Используйте логин и пароль или заново откройте приложение в Битрикс24.' });
    } catch {
      return res.status(503).json({ error: 'Не удалось проверить доступ в Битрикс24. Резервный вход по паролю остаётся доступен.' });
    }
    const base = getWebhookBase();
    if (!base) return res.status(503).json({ error: 'На сервере не настроен вебхук Битрикс24.' });
    try {
      // A single in-flight refresh prevents duplicate CRM scans.
      const refresh = req.query?.refresh === '1';
      if (!cache || Date.now() - cachedAt > 60000 || refresh) {
        if (!pending) {
          pending = buildReport(clientFactory(base), env, base).then(report => {
            cache = report;
            cachedAt = Date.now();
          }).finally(() => { pending = null; });
        }
        await pending;
      }
      return res.status(200).json(cache);
    } catch (error) {
      return res.status(502).json({ error: error.publicMessage || 'Не удалось сформировать справку. Проверьте серверные настройки.' });
    }
  };
}

module.exports = { GROUPS, buildReport, createClient, createSpravkaHandler, stageGroups, authorized };
