const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBitrixSpravkaApp, fileStore, sessionCors } = require('../lib/bitrix-spravka-app');
const { createSpravkaHandler, authorized } = require('../lib/bitrix-spravka');

const clientId = 'local.fixture-client';
const oauth = 'fixture-oauth-not-a-real-token-12345';
const appToken = 'fixture-application-token-123456';
const memberId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
function response() {
  return { code:200, headers: {'X-Frame-Options':'SAMEORIGIN','Content-Security-Policy':"default-src 'self'; frame-ancestors 'self'"},
    setHeader(k,v){this.headers[k]=v;},getHeader(k){return this.headers[k];},removeHeader(k){delete this.headers[k];},
    status(code){this.code=code;return this;},type(){return this;},send(body){this.body=body;return this;},
    json(body){this.body=body;return this;},end(){return this;} };
}
function request(body = {}) {
  return { method:'POST', query:{DOMAIN:'interpain.bitrix24.ru'}, headers:{},
    body:{AUTH_ID:oauth,APPLICATION_TOKEN:appToken,member_id:memberId,AUTH_EXPIRES:'3600',...body} };
}
function harness(overrides = {}) {
  const env = {SPRAVKA_B24_CLIENT_ID:clientId,SPRAVKA_B24_ENABLED:'1',...overrides.env};
  const state = {record:null,admin:true,revoked:false,unavailable:false,code:clientId,installed:true,user:'17',active:true,calls:[],...overrides.state};
  const store = { read:async()=>state.record, create:async record => (state.record ||= record) };
  let clock = 100000;
  const app = createBitrixSpravkaApp({env,store,now:()=>clock,fetchImpl:async(url,options)=>{
    state.calls.push({url,options});
    assert.ok(url.startsWith('https://interpain.bitrix24.ru/rest/'));
    assert.equal(options.redirect,'error');
    assert.equal(new URLSearchParams(options.body).get('auth'),oauth);
    if (state.unavailable) throw new Error(`private failure ${oauth}`);
    const method = url.split('/').pop();
    const result = method==='app.info.json'?{ID:8,CODE:state.code,STATUS:'L',INSTALLED:state.installed}:
      method==='user.current.json'?{ID:state.user,ACTIVE:state.active}:state.admin;
    return {ok:!state.revoked,status:state.revoked?401:200,text:async()=>JSON.stringify(
      state.revoked?{error:'user_access_error',error_description:oauth}:{result})};
  }});
  return {app,state,env,advance:ms=>{clock+=ms;}};
}
async function login(h, req = request()) {
  const res=response(); await h.app.entry(req,res); return res;
}
function sessionOf(res) {
  const found=/window\.SPRAVKA_BITRIX=({"session":"[^"]+"})/.exec(res.body);
  assert.ok(found, 'Only an authenticated entry emits a browser session');
  return JSON.parse(found[1]).session;
}
const sessionRequest = token => ({method:'GET',headers:{authorization:`Bearer ${token}`}});

test('browser logout revokes a real session despite an unrelated restricted lead-origin list',async t=>{
  const express=require('express'),cors=require('cors');
  const h=harness(),token=sessionOf(await login(h));
  assert.equal(await h.app.authorize(sessionRequest(token)),true);
  const app=express();
  app.use(sessionCors(cors({origin:(origin,done)=>done(
    origin==='https://another-allowed-site.example'?null:new Error('Origin rejected'),true
  )})));
  app.post('/api/spravka/bitrix/logout',h.app.logout);
  app.post('/api/lead',(_req,res)=>res.sendStatus(204));
  app.use((_error,_req,res,_next)=>res.sendStatus(403));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close()});
  const root=`http://127.0.0.1:${server.address().port}`;
  const res=await fetch(root+'/api/spravka/bitrix/logout',{method:'POST',
    headers:{Origin:'https://forms.eduinterpain.ru',Authorization:`Bearer ${token}`}});
  assert.equal(res.status,204);assert.equal(res.headers.get('access-control-allow-origin'),null);
  assert.equal(await h.app.authorize(sessionRequest(token)),false);
  const lead=await fetch(root+'/api/lead',{method:'POST',headers:{Origin:'https://forms.eduinterpain.ru'}});
  assert.equal(lead.status,403);
});

test('pairing needs the pinned app and portal administrator; OAuth never reaches HTML',async()=>{
  const h=harness(),res=await login(h);
  assert.equal(res.code,200);
  const token=sessionOf(res);
  assert.match(token,/^b24\.[\w-]{43}$/);
  assert.ok(!res.body.includes(oauth)&&!res.body.includes(appToken));
  assert.equal(h.state.record.applicationToken,appToken);
  assert.equal(res.headers['X-Frame-Options'],undefined);
  assert.match(res.headers['Content-Security-Policy'],/frame-ancestors https:\/\/interpain\.bitrix24\.ru/);
  assert.equal(res.headers['Cache-Control'],'no-store, private');
  assert.equal(res.headers['Referrer-Policy'],'no-referrer');
  assert.equal(await h.app.authorize(sessionRequest(token)),true);
});

test('first pairing by an ordinary employee or a different OAuth app fails closed',async()=>{
  for(const state of [{admin:false},{code:'another.app'},{active:false}]) {
    const h=harness({state}),res=await login(h);
    assert.equal(res.code,403); assert.equal(h.state.record,null);
    assert.ok(!res.body.includes(oauth));
  }
});

test('after administrator pairing an allowed non-admin can obtain a session without re-pairing',async()=>{
  const h=harness();await login(h);
  const record=h.state.record;
  h.state.admin=false;h.state.user='19';h.state.calls=[];
  const token=sessionOf(await login(h));
  assert.equal(h.state.record,record);
  assert.ok(!h.state.calls.some(call=>call.url.includes('user.admin')));
  assert.equal(await h.app.authorize(sessionRequest(token)),true);
});

test('entry rejects spoofed portal, missing/array credentials and an unconfigured app before REST',async()=>{
  for(const req of [
    {...request(),query:{DOMAIN:'evil.invalid'}},
    request({DOMAIN:'evil.invalid'}),
    request({AUTH_ID:['value']}),
    request({member_id:''})
  ]) {
    const h=harness(); const res=await login(h,req);
    assert.equal(res.code,403); assert.equal(h.state.calls.length,0);
  }
  const h=harness({env:{SPRAVKA_B24_CLIENT_ID:''}}),res=await login(h);
  assert.equal(res.code,503);assert.equal(h.state.calls.length,0);
});

test('forged or rotated application token/member ID never overwrites an installation',async()=>{
  const h=harness(); await login(h);
  const original={...h.state.record}; h.state.calls=[];
  for(const body of [{APPLICATION_TOKEN:'another-token-that-is-long-enough'},{member_id:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}]) {
    assert.equal((await login(h,request(body))).code,403);
  }
  assert.deepEqual(h.state.record,original);assert.equal(h.state.calls.length,0);
});

test('disabled integration can be paired safely but never emits a report session',async()=>{
  const h=harness({env:{SPRAVKA_B24_ENABLED:'0'}}),res=await login(h);
  assert.equal(res.code,200);assert.match(res.body,/пока выключен/);
  assert.ok(h.state.record);assert.ok(!res.body.includes('SPRAVKA_BITRIX='));
  assert.equal(await h.app.authorize(sessionRequest('b24.'+'a'.repeat(43))),false);
});

test('all Bitrix entry outcomes announce frame readiness without granting report access',async()=>{
  for (const config of [
    {env:{SPRAVKA_B24_ENABLED:'0'}},
    {},
    {state:{admin:false}},
    {env:{SPRAVKA_B24_CLIENT_ID:''}},
    {state:{unavailable:true}}
  ]) {
    const h=harness(config),res=await login(h);
    assert.match(res.body,/id="spravka-bitrix-frame-ready"/);
    assert.ok(!res.body.includes(oauth)&&!res.body.includes(appToken));
    assert.equal(res.headers['X-Frame-Options'],undefined);
    assert.match(res.headers['Content-Security-Policy'],/frame-ancestors https:\/\/interpain\.bitrix24\.ru/);
    if (config.env?.SPRAVKA_B24_ENABLED==='0' || res.code!==200) {
      assert.ok(!res.body.includes('window.SPRAVKA_BITRIX='));
      const req=sessionRequest('b24.'+'a'.repeat(43));
      if (config.env?.SPRAVKA_B24_CLIENT_ID==='') {
        await assert.rejects(h.app.authorize(req),error=>error.status===503);
      } else {
        assert.equal(await h.app.authorize(req),false);
      }
    }
  }
});

test('uninstalled app cannot receive a usable report session',async()=>{
  const h=harness({state:{installed:false}}),res=await login(h);
  assert.equal(res.code,403);assert.ok(!res.body.includes('SPRAVKA_BITRIX='));
});

test('revocation, expiry, logout and changed user invalidate opaque sessions',async()=>{
  for(const mode of ['revoked','expired','logout','changed-user']) {
    const h=harness(),token=sessionOf(await login(h));
    assert.equal(await h.app.authorize(sessionRequest(token)),true);
    if(mode==='revoked')h.state.revoked=true;
    if(mode==='expired')h.advance(50*60*1000+1);
    if(mode==='logout')h.app.logout(sessionRequest(token),response());
    if(mode==='changed-user')h.state.user='18';
    assert.equal(await h.app.authorize(sessionRequest(token)),false,mode);
    h.state.revoked=false;h.state.user='17';
    assert.equal(await h.app.authorize(sessionRequest(token)),false,'Invalid sessions stay invalid');
  }
});

test('each request revalidates access; outages do not leak upstream secrets or consume valid sessions',async()=>{
  const h=harness(),token=sessionOf(await login(h));
  const before=h.state.calls.length;
  assert.equal(await h.app.authorize(sessionRequest(token)),true);
  assert.equal(await h.app.authorize(sessionRequest(token)),true);
  assert.equal(h.state.calls.length-before,4);
  h.state.unavailable=true;
  await assert.rejects(h.app.authorize(sessionRequest(token)),error=>error.status===503&&!error.message.includes(oauth));
  assert.ok(!(await login(h)).body.includes(oauth));
  h.state.unavailable=false;
  assert.equal(await h.app.authorize(sessionRequest(token)),true);
});

test('password fallback is independent of OAuth and access checks precede the shared report cache',async()=>{
  const h=harness(),token=sessionOf(await login(h));
  const env={SPRAVKA_PASSWORD:'existing-reserve-password-123'};
  process.env.B24_WEBHOOK_URL='https://interpain.bitrix24.ru/rest/1/fixture-only';
  let scans=0;
  const {GROUPS}=require('../lib/bitrix-spravka');
  const statuses=[{ENTITY_ID:'DYNAMIC_1036_STAGE_1',STATUS_ID:'REAL',NAME:'Реализация'},
    ...Object.entries(GROUPS).flatMap(([key,names])=>names.map((NAME,i)=>({ENTITY_ID:'DEAL_STAGE',STATUS_ID:key+i,NAME})))];
  const handler=createSpravkaHandler({env,authorize:(req,config)=>authorized(req,config)||h.app.authorize(req),
    clientFactory:()=>{scans++;return{list:async(method)=>method==='crm.status.list'?statuses:[],
      call:async()=>({result:{fields:{code:{title:'Кодовое обозначение'},ufCrm21EventAddr:{title:'Адрес'}}}})};}});
  const basic={method:'GET',headers:{authorization:'Basic '+Buffer.from('report:'+env.SPRAVKA_PASSWORD).toString('base64')}};
  const first=response();await handler(basic,first);assert.equal(first.code,200);
  const shared=response();await handler(sessionRequest(token),shared);assert.equal(shared.code,200);
  assert.equal(shared.body,first.body);assert.equal(scans,1);
  h.state.revoked=true;
  const revoked=response();await handler(sessionRequest(token),revoked);assert.equal(revoked.code,401);
  h.state.unavailable=true;
  const backup=response();await handler(basic,backup);assert.equal(backup.code,200);
  assert.equal(scans,1);
});

test('file store is private, outside the website, rejects symlinks and is create-only',async t=>{
  assert.throws(()=>fileStore(path.join(__dirname,'..','.state')));
  assert.throws(()=>fileStore('relative-path'));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'spravka-b24-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=fileStore(dir),record={clientId,memberId,appId:'8',applicationToken:appToken};
  assert.equal(await store.read(),null);
  await store.create(record);await store.create({...record,applicationToken:'must-not-replace'});
  assert.deepEqual(await store.read(),record);
  assert.equal((await fs.stat(path.join(dir,'installation.json'))).mode&0o777,0o600);
  await fs.chmod(path.join(dir,'installation.json'),0o644);
  await assert.rejects(store.read());
  await fs.chmod(path.join(dir,'installation.json'),0o600);
  await fs.chmod(dir,0o755);
  await assert.rejects(store.read());await assert.rejects(store.create(record));
  await fs.chmod(dir,0o700);
  const linked=dir+'-link';
  await fs.symlink(dir,linked);
  t.after(()=>fs.rm(linked,{force:true}));
  await assert.rejects(fileStore(linked).read());
  await fs.rename(path.join(dir,'installation.json'),path.join(dir,'original.json'));
  await fs.symlink(path.join(dir,'original.json'),path.join(dir,'installation.json'));
  await assert.rejects(store.read());
});
