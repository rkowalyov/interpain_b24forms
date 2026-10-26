const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the exact pure formatter shipped inline, without an extra public JS route.
const html = fs.readFileSync(path.join(__dirname, '..', 'spravka.html'), 'utf8');
const source = html.match(/<script id="spravka-text">([\s\S]*?)<\/script>/);
assert.ok(source, 'Inline text formatter must be present');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(source[1], sandbox);
const { formatEvent, formatReport, formatSelectedReport } = sandbox.module.exports;
const event = {
  id: 323, code: '26_11_07-08', title: 'ИЛБ под УЗ навигацией (Краснодар)',
  city: 'Краснодар', counts: { paid: 9, checkIndividual: 6, checkCompany: 0, declined: 0 }
};
const data = { generatedAt: '2026-10-26T08:45:00.000Z', events: [event], warnings: [] };

test('single-event copy is exactly the header and four labeled lines, including zeroes', () => {
  assert.equal(formatEvent(event), [
    '323 | 26_11_07-08 | ИЛБ под УЗ навигацией (Краснодар) | Краснодар',
    'Оплачено: 9', 'Проверить ФЛ: 6', 'Проверить ЮЛ: 0', 'Отказались: 0'
  ].join('\n'));
});

test('whole-report copy preserves the loaded order, separates blocks and uses the actual Moscow timestamp', () => {
  const next = { ...event, id: 245, code: '26_12_01-02', title: 'Второе мероприятие' };
  const text = formatReport({ ...data, events: [event, next] });
  assert.match(text, /^СПРАВКА\nМероприятия · стадия «Реализация»\nОбновлено: 26\.10\.2026.*11:45 МСК\n\n323/);
  assert.ok(text.indexOf('323 |') < text.indexOf('245 |'));
  assert.ok(text.includes('\n\n245 |'));
  assert.equal((text.match(/Оплачено:/g) || []).length, 2);
  assert.doesNotMatch(text, /Обновить|Выйти|<button|<article|&nbsp;/);
});

test('missing city and multiline CRM values produce a readable five-line block', () => {
  const text = formatEvent({ ...event, title: '  ИЛБ\nпод\tУЗ  навигацией  ', city: '' });
  assert.equal(text.split('\n').length, 5);
  assert.match(text, /ИЛБ под УЗ навигацией \| Город не указан/);
});

test('only whitelisted report fields are copied; credentials and API settings are never serialized', () => {
  const hidden = { password: 'DO_NOT_COPY_PASSWORD', auth: 'Basic PRIVATE',
    webhook: 'https://private.invalid/rest/secret/', api: 'PRIVATE_API' };
  const text = formatReport({ ...data, ...hidden, events: [{ ...event, ...hidden }] });
  for (const value of Object.values(hidden)) assert.ok(!text.includes(value));
});

test('stale copy has an explicit warning and never substitutes the current time', () => {
  const text = formatReport(data, true);
  assert.match(text, /это предыдущая справка, обновить данные не удалось/);
  assert.match(text, /26\.10\.2026.*11:45 МСК/);
  assert.doesNotMatch(formatReport(data), /предыдущая справка/);
});

test('report notes are retained as plain text without breaking block structure', () => {
  const text = formatReport({ ...data, warnings: ['  Проверить\nгород мероприятия.  '] });
  assert.ok(text.includes('Примечание: Проверить город мероприятия.\n\n323'));
});

test('incorrect counts and malformed reports fail rather than silently fabricating zeroes', () => {
  for (const paid of [-1, 1.5, '9', undefined]) {
    assert.throws(() => formatEvent({ ...event, counts: { ...event.counts, paid } }));
  }
  assert.throws(() => formatReport({ ...data, events: null }));
  assert.throws(() => formatReport({ ...data, generatedAt: 'invalid-date' }));
});

test('empty report formatting does not invent an event or payment lines', () => {
  const text = formatReport({ ...data, events: [] });
  assert.match(text, /^СПРАВКА/);
  assert.doesNotMatch(text, /Оплачено|323/);
});

test('selection copies only chosen events in report order, not selection order', () => {
  const next = { ...event, id: 245, title: 'Другое мероприятие' };
  const third = { ...event, id: 301, title: 'Третье мероприятие' };
  const report = { ...data, events: [event,next,third] };
  const one = formatSelectedReport(report,new Set(['245']));
  assert.ok(one.includes('245 |'));
  assert.ok(!one.includes('323 |') && !one.includes('301 |'));
  const many = formatSelectedReport(report,new Set([301,323]));
  assert.ok(many.indexOf('323 |') < many.indexOf('301 |'));
  assert.ok(!many.includes('245 |'));
});

test('empty and obsolete selections never default to exporting all events', () => {
  for (const selection of [[],new Set(),['999']]) {
    assert.throws(() => formatSelectedReport(data,selection));
  }
  assert.match(formatSelectedReport(data,['323'],true),/предыдущая справка/);
});
