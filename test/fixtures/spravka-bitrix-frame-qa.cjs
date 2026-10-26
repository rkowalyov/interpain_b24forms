// Synthetic, isolated-browser QA only. No real portal requests or credentials.
const fs = require('node:fs');
const path = require('node:path');
const { createBitrixSpravkaApp } = require('../../lib/bitrix-spravka-app');
const { FRAME_READY_SCRIPT } = require('../../lib/bitrix-spravka-frame');
const root = path.join(__dirname, '../..');
const portal = 'https://interpain.bitrix24.ru';
const forms = 'https://forms.eduinterpain.ru';
const sid = 'a'.repeat(32);
const password = 'fixture-password-not-production';
const basic = 'Basic ' + Buffer.from('report:' + password).toString('base64');
const report = {
  generatedAt: '2026-10-26T17:00:00.000Z', warnings: [],
  events: [301, 323].map((id, i) => ({
    id, code: i ? '26_11_07-08' : '26_10_10-11',
    title: i ? 'ТЕСТ: мероприятие в Москве' : 'ТЕСТ: мероприятие в Краснодаре',
    city: i ? 'Москва' : 'Краснодар',
    url: portal + '/page/meropriyatiya/meropriyatiya/type/1036/details/' + id + '/',
    counts: { paid: i + 4, checkIndividual: 2, checkCompany: 1, declined: 0 }
  }))
};

async function scenario(mode = 'disabled', legacy = false) {
  const env = { SPRAVKA_B24_CLIENT_ID: 'local.fixture-client', SPRAVKA_B24_ENABLED: mode === 'enabled' ? '1' : '0' };
  let record = null;
  const app = createBitrixSpravkaApp({
    env, store: { read: async () => record, create: async value => (record ||= value) },
    fetchImpl: async url => ({
      ok: true, status: 200, text: async () => JSON.stringify({ result:
        url.includes('app.info') ? { ID: 8, CODE: env.SPRAVKA_B24_CLIENT_ID, STATUS: 'L', INSTALLED: true } :
          url.includes('user.current') ? { ID: 17, ACTIVE: true } : true
      })
    })
  });
  const response = {
    code: 200,
    headers: {
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data: https:; frame-ancestors 'self'",
      'Cross-Origin-Resource-Policy': 'same-origin'
    },
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    removeHeader(k) { delete this.headers[k]; }, status(code) { this.code = code; return this; },
    type() { return this; }, send(body) { this.body = body; return this; }
  };
  await app.entry({
    method: 'POST', query: { DOMAIN: mode === 'denied' ? 'foreign.invalid' : 'interpain.bitrix24.ru' },
    headers: {}, body: {
      AUTH_ID: 'fixture-oauth-not-a-real-token-12345', APPLICATION_TOKEN: 'fixture-application-token-123456',
      member_id: 'a'.repeat(32), AUTH_EXPIRES: '3600'
    }
  }, response);
  if (legacy) response.body = response.body.replace(FRAME_READY_SCRIPT, '');
  return { app, response };
}

// Small model of the published AppLayout receiveMessage / availability contract.
// Not a copy of the portal UI and not proof of a production Bitrix smoke test.
function parentHtml({ wrongName = false } = {}) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8">
<title>Изолированная проверка встраивания</title>
<style>body{margin:0;font:14px sans-serif;background:#f3f6f9}header{padding:12px;background:#fff}iframe{border:0;width:100%;height:calc(100vh - 65px)}#overlay{position:fixed;inset:65px 0 0;background:#fff;padding:40px}</style>
<header>Локальная модель протокола, не настоящий портал. <span id="status">Ожидание</span></header>
<iframe id="app" name="${wrongName ? 'foreign.invalid' : 'interpain.bitrix24.ru'}|1|${sid}"></iframe>
<div id="overlay" hidden>Модель: ложная плашка недоступности хоста</div>
<form method="POST" target="${wrongName ? 'foreign.invalid' : 'interpain.bitrix24.ru'}|1|${sid}" action="${forms}/spravka/bitrix?DOMAIN=interpain.bitrix24.ru"><button id="launch">Открыть тестовое приложение</button></form>
<script>
const frame=document.getElementById('app'),overlay=document.getElementById('overlay'),status=document.getElementById('status');
let connected=false;
addEventListener('message',event=>{
 if(event.origin!==${JSON.stringify(forms)}||typeof event.data!=='object'||event.data.appSid!==${JSON.stringify(sid)})return;
 connected=true;overlay.hidden=true;frame.inert=false;status.textContent='Связь установлена';
 // callback:false is BX.DoNothing: no auth response is constructed or posted.
});
document.querySelector('form').addEventListener('submit',()=>{
 setTimeout(()=>{
   if(connected){document.body.dataset.checked='yes';return;}
   fetch(${JSON.stringify(forms)},{mode:'no-cors',credentials:'omit',cache:'no-store'})
    .then(()=>{},()=>{if(!connected){overlay.hidden=false;frame.inert=true;status.textContent='Плашка показана';}})
    .finally(()=>{document.body.dataset.checked='yes';});
 },3000);
});
</script></html>`;
}

module.exports = { scenario, parentHtml, report, root, portal, forms, password, basic };
