const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');

test('Node.js serves /spravka, local font and protected API without external hosting', async t => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), SPRAVKA_PASSWORD: 'local-test-password-123',
      B24_WEBHOOK_URL: 'https://interpain.bitrix24.ru/rest/1/not-real',
      SPRAVKA_B24_CLIENT_ID: '', ALLOWED_ORIGINS:'https://another-allowed-site.example' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local server did not start')), 8000);
    const done = () => clearTimeout(timer);
    child.stdout.on('data', data => {
      if (data.toString().includes('Proxy server listening')) { done(); resolve(); }
    });
    child.on('error', error => { done(); reject(error); });
    child.on('exit', code => { if (code !== null) { done(); reject(new Error(`Server exited ${code}`)); } });
  });
  const root = `http://127.0.0.1:${port}`;
  for (const route of ['/spravka', '/spravka/']) {
    const response = await fetch(root + route);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /СПРАВКА/);
    assert.match(html, /\/assets\/fonts\/GolosText\.ttf/);
    assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com|vercel\.app/i);
  }
  const font = await fetch(root + '/assets/fonts/GolosText.ttf');
  assert.equal(font.status, 200);
  assert.ok((await font.arrayBuffer()).byteLength > 10000);
  const denied = await fetch(root + '/api/spravka');
  assert.equal(denied.status, 401);
  const registration = await fetch(root + '/event-register/?EVNUMBER=323');
  assert.equal(registration.status, 200);
  const health = await fetch(root + '/health');
  assert.deepEqual(await health.json(), { ok: true });
  const source = await fetch(root + '/lib/bitrix-spravka.js');
  assert.equal(source.status, 404);
  const entry = await fetch(root + '/spravka/bitrix', {
    method:'POST', headers:{Origin:'https://interpain.bitrix24.ru','Content-Type':'application/x-www-form-urlencoded'},
    body:'AUTH_ID=fixture-token-never-disclosed'
  });
  assert.equal(entry.status,503);
  assert.equal(entry.headers.get('x-frame-options'),null);
  assert.match(entry.headers.get('content-security-policy'),/frame-ancestors https:\/\/interpain\.bitrix24\.ru/);
  assert.ok(!(await entry.text()).includes('fixture-token-never-disclosed'));
  const original = await fetch(root + '/spravka');
  assert.equal(original.headers.get('x-frame-options'),'SAMEORIGIN');
  assert.match(original.headers.get('content-security-policy'),/frame-ancestors 'self'/);
  const malformed = await fetch(root + '/spravka/bitrix', {
    method:'POST', headers:{'Content-Type':'application/json'},body:'{"AUTH_ID":"fixture-token-never-disclosed",'
  });
  assert.equal(malformed.status,400);
  assert.ok(!(await malformed.text()).includes('fixture-token-never-disclosed'));
  const direct = await fetch(root + '/spravka/bitrix', {redirect:'manual'});
  assert.equal(direct.status,303);assert.equal(direct.headers.get('location'),'/spravka');
  const logout = await fetch(root + '/api/spravka/bitrix/logout',{method:'POST'});
  assert.equal(logout.status,204);
  const browserLogout = await fetch(root + '/api/spravka/bitrix/logout',{
    method:'POST',headers:{Origin:'https://forms.eduinterpain.ru'}
  });
  assert.equal(browserLogout.status,204);
  assert.equal(browserLogout.headers.get('access-control-allow-origin'),null);
  const unrelated = await fetch(root + '/api/lead',{
    method:'POST',headers:{Origin:'https://forms.eduinterpain.ru','Content-Type':'application/json'},body:'{}'
  });
  assert.equal(unrelated.status,500); // The legacy lead origin policy still rejects it.
});
