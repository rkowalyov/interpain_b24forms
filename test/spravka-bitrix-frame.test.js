const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { FRAME_READY_SCRIPT, withFrameReady } = require('../lib/bitrix-spravka-frame');

const portal = 'https://interpain.bitrix24.ru';
const sid = 'a'.repeat(32);
const source = FRAME_READY_SCRIPT.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');

function run(name, { standalone = false, blocked = false } = {}) {
  const calls = [];
  const parent = { postMessage(message, target) {
    if (blocked) throw new Error('Presentation messaging blocked');
    calls.push({ message: JSON.parse(JSON.stringify(message)), target });
  }};
  const window = { name, parent };
  if (standalone) window.parent = window;
  // No browser storage, DOM, OAuth, network, or incoming message channel exists.
  vm.runInNewContext(source, { window }, { timeout: 100 });
  return calls;
}

test('native frame announces readiness only to the pinned HTTPS portal, with no auth callback', () => {
  assert.deepEqual(run(`interpain.bitrix24.ru|1|${sid}`), [{
    message: { method: 'getInitData', params: {}, callback: false, appSid: sid },
    target: portal
  }]);
  assert.doesNotMatch(FRAME_READY_SCRIPT, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|AUTH_ID|APPLICATION_TOKEN|installFinish|setInstall/);
});

test('standalone, foreign, malformed and insecure frame contexts emit nothing', () => {
  assert.deepEqual(run(`interpain.bitrix24.ru|1|${sid}`, { standalone: true }), []);
  for (const name of [
    '', null, 'another.bitrix24.ru|1|' + sid,
    'interpain.bitrix24.ru.evil.invalid|1|' + sid,
    `interpain.bitrix24.ru|0|${sid}`,
    `interpain.bitrix24.ru|1|${sid}|extra`,
    'interpain.bitrix24.ru|1|<script>',
    'interpain.bitrix24.ru|1|' + 'a'.repeat(31),
    'interpain.bitrix24.ru|1|' + 'z'.repeat(32)
  ]) assert.deepEqual(run(name), [], String(name));
});

test('presentation bridge failure is contained and does not throw into report code', () => {
  assert.deepEqual(run(`interpain.bitrix24.ru|1|${sid}`, { blocked: true }), []);
});

test('bridge is added after charset, before report body; implicit-head status/error pages also work', () => {
  for (const html of [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>Report</body></html>',
    '<!doctype html><html lang="ru"><meta charset="utf-8"><h1>Status</h1></html>'
  ]) {
    const result = withFrameReady(html);
    assert.equal(result.replace(FRAME_READY_SCRIPT, ''), html);
    assert.equal(result.split('id="spravka-bitrix-frame-ready"').length, 2);
    assert.ok(result.indexOf('charset=') < result.indexOf('id="spravka-bitrix-frame-ready"'));
    if (html.includes('</head>')) {
      assert.ok(result.indexOf('id="spravka-bitrix-frame-ready"') < result.indexOf('</head>'));
    }
  }
});

test('portal readiness contract needs a matching frame SID; no callback means no OAuth response', () => {
  let connected = false, overlay = true, oauthReplies = 0;
  function receive(origin, data) {
    if (origin !== 'https://forms.eduinterpain.ru' || data.appSid !== sid) return;
    connected = true; overlay = false;
    // Matches the portal's callback:false -> BX.DoNothing branch.
    if (data.callback) oauthReplies++;
  }
  receive('https://evil.invalid', run(`interpain.bitrix24.ru|1|${sid}`)[0].message);
  assert.equal(connected, false);
  const [{ message }] = run(`interpain.bitrix24.ru|1|${sid}`);
  receive('https://forms.eduinterpain.ru', message);
  assert.equal(connected, true);
  assert.equal(overlay, false);
  assert.equal(oauthReplies, 0);
});
