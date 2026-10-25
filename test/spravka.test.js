const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GROUPS, buildReport, createClient, createSpravkaHandler } = require('../lib/bitrix-spravka');

const base = 'https://interpain.bitrix24.ru/rest/1/fixture-only';
const statuses = [
  { ENTITY_ID: 'DYNAMIC_1036_STAGE_61', STATUS_ID: 'DT1036_61:REAL', NAME: 'Реализация' },
  { ENTITY_ID: 'DYNAMIC_1036_STAGE_61', STATUS_ID: 'DT1036_61:NEW', NAME: 'Планирование' },
  ...Object.entries(GROUPS).flatMap(([key, labels]) =>
    labels.map((NAME, i) => ({ ENTITY_ID: 'DEAL_STAGE_1', STATUS_ID: `${key}${i}`, NAME })))
];
const fields = { code: { title: 'Кодовое обозначение' }, ufCrm21EventAddr: { title: 'Место проведения мероприятия' } };
const items = [
  { id: 323, code: '26_11_07-08', title: 'ИЛБ под УЗ навигацией', stageId: 'DT1036_61:REAL', ufCrm21EventAddr: 'г. Москва, Учебный центр' },
  { id: 301, code: '26_10_10-11', title: 'ИЛБ под УЗ навигацией (Краснодар)', stageId: 'DT1036_61:REAL', ufCrm21EventAddr: '(Краснодар), центр' },
  { id: 99, code: '00_01', title: 'Не включать', stageId: 'DT1036_61:NEW' }
];
function fixture({ overrideItems = items, overrideStatuses = statuses } = {}) {
  const deals = Object.keys(GROUPS).flatMap(group => GROUPS[group].map((_, index) => ({
    ID: `${group}-${index}`, STAGE_ID: `${group}${index}`, UF_CRM_DEAL_1738519959225: '323'
  })));
  deals.push(deals[0]); // Duplicate page entry must not inflate counts.
  deals.push({ ID: 'wrong-event', STAGE_ID: 'paid0', UF_CRM_DEAL_1738519959225: '999' });
  deals.push({ ID: 'wrong-stage', STAGE_ID: 'NEW', UF_CRM_DEAL_1738519959225: '323' });
  return {
    call: async () => ({ result: { fields } }),
    list: async (method, params) => {
      if (method === 'crm.status.list') return overrideStatuses;
      if (method === 'crm.item.list') {
        assert.deepEqual(params.filter, { '@stageId': ['DT1036_61:REAL'] });
        return overrideItems;
      }
      assert.deepEqual(params.filter['@UF_CRM_DEAL_1738519959225'], ['323', '301']);
      return deals;
    }
  };
}

test('exact selection, strict code ordering, city, links, all four counts, duplicates and zero rows', async () => {
  const report = await buildReport(fixture(), {}, base);
  assert.deepEqual(report.events.map(event => event.code), ['26_10_10-11', '26_11_07-08']);
  assert.equal(report.events[0].city, 'Краснодар');
  assert.equal(report.events[0].title, 'ИЛБ под УЗ навигацией (Краснодар)');
  assert.equal(report.events[1].url, 'https://interpain.bitrix24.ru/page/meropriyatiya/meropriyatiya/type/1036/details/323/');
  assert.deepEqual(report.events[1].counts, { paid: 1, checkIndividual: 1, checkCompany: 2, declined: 3 });
  assert.deepEqual(Object.values(report.events[0].counts), [0, 0, 0, 0]);
  assert.equal(JSON.stringify(report).includes('fixture-only'), false);
});

test('missing stage or code fails explicitly, not as zero counts', async () => {
  await assert.rejects(buildReport(fixture({ overrideStatuses: statuses.slice(0, -1) }), {}, base), /Не успешно отучились/);
  await assert.rejects(buildReport(fixture({ overrideItems: [{ ...items[0], code: '' }] }), {}, base), /не заполнено/);
});

test('empty events produces empty successful report', async () => {
  const report = await buildReport(fixture({ overrideItems: [] }), {}, base);
  assert.deepEqual(report.events, []);
});

test('non-arrival UI semantic annotation can be absent in CRM NAME', async () => {
  const renamed = statuses.map(stage => ({ ...stage, NAME: stage.NAME.replace(' (проигранная)', '') }));
  const report = await buildReport(fixture({ overrideStatuses: renamed }), {}, base);
  assert.equal(report.events[1].counts.declined, 3);
});

test('pagination reads every page and rejects repeated cursor', async () => {
  let calls = 0;
  const client = createClient(base, async (_url, options) => {
    const params = JSON.parse(options.body);
    calls++;
    return { ok: true, json: async () => params.start === 0 ?
      { result: { items: [{ id: 1 }] }, next: 50 } :
      { result: { items: [{ id: 2 }] } } };
  });
  assert.deepEqual(await client.list('crm.item.list', {}, 'items'), [{ id: 1 }, { id: 2 }]);
  assert.equal(calls, 2);
  const looping = createClient(base, async () => ({ ok: true, json: async () => ({ result: [], next: 0 }) }));
  await assert.rejects(looping.list('crm.deal.list'), /повторил страницу/);
});

test('upstream error descriptions never expose webhook secret', async () => {
  const client = createClient(base, async () => ({
    ok: false, json: async () => ({ error: 'failure', error_description: base })
  }));
  await assert.rejects(client.call('crm.status.list'), error => !error.message.includes('fixture-only'));
});

function response() {
  return { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
test('fail closed when password is not configured; unauthorized calls never reach CRM', async () => {
  const res = response();
  await createSpravkaHandler({ env: {} })({ method: 'GET', headers: {} }, res);
  assert.equal(res.code, 503);
  const guarded = createSpravkaHandler({ env: { SPRAVKA_PASSWORD: 'fixture-password-123' },
    clientFactory: () => { throw new Error('CRM must not be called'); } });
  const denied = response();
  await guarded({ method: 'GET', headers: {} }, denied);
  assert.equal(denied.code, 401);
  assert.equal(denied.headers['Cache-Control'], 'no-store, private');
  const wrong = response();
  await guarded({ method: 'GET', headers: { authorization: `Basic ${Buffer.from('report:wrong').toString('base64')}` } }, wrong);
  assert.equal(wrong.code, 401);
});

test('authenticated handler caches results; explicit refresh bypasses cache', async () => {
  process.env.B24_WEBHOOK_URL = base;
  let scans = 0;
  const handler = createSpravkaHandler({
    env: { SPRAVKA_PASSWORD: 'fixture-password-123' },
    clientFactory: () => { scans++; return fixture(); }
  });
  const req = { method: 'GET', headers: { authorization: `Basic ${Buffer.from('report:fixture-password-123').toString('base64')}` }, query: {} };
  const first = response(); await handler(req, first);
  assert.equal(first.code, 200);
  const second = response(); await handler(req, second);
  assert.equal(second.code, 200); assert.equal(scans, 1);
  const fresh = response(); await handler({ ...req, query: { refresh: '1' } }, fresh);
  assert.equal(fresh.code, 200); assert.equal(scans, 2);
});
