const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,response,oauth}=require('./fixtures/spravka-admin-harness.cjs');
const {installationHash}=require('../lib/bitrix-spravka-settings');
const {authorized}=require('../lib/bitrix-spravka');
const bearer=boot=>({headers:{authorization:`Bearer ${boot.session}`}});
async function save(h,b,value){return h.admin(b,'settings',{method:'PUT',body:value});}
async function allow(h,b,ids=['17','19'],enabled=true){
  const current=(await h.admin(b,'state')).body.settings;
  return save(h,b,{...current,enabled,allowedUserIds:ids});
}

test('administrator management works with server gate off; no implicit report access or OAuth in HTML',async t=>{
  const h=await fixture(t),b=await h.entry();
  assert.equal(b.res.code,200);assert.match(b.session,/^b24a\.[\w-]{43}$/);
  assert.ok(!b.res.body.includes(oauth('17'))&&!b.res.body.includes(h.record.applicationToken));
  assert.ok(!b.res.body.includes('demo-1'));assert.equal(await h.app.authorize(bearer(b)),false);
  const state=await h.admin(b,'state');assert.equal(state.code,200);
  assert.deepEqual(state.body.settings,h.defaults());assert.equal(state.body.serverEnabled,false);
  assert.equal((await allow(h,b,['19'],false)).code,200);
  const enabled=await allow(h,b,['19'],true);assert.equal(enabled.code,409);
  assert.equal((await h.admin(b,'report',{method:'POST'})).code,403);
  assert.equal((await h.entry('19')).res.code,403);
});

test('real directory method uses minimal user_brief fields, name search, internal/active filters and pagination',async t=>{
  const h=await fixture(t),b=await h.entry();
  const page1=await h.admin(b,'employees'),page2=await h.admin(b,'employees',{query:{start:'50'}});
  assert.equal(page1.code,200);assert.equal(page1.body.users.length,50);assert.equal(page1.body.next,50);
  assert.equal(page2.body.users.length,5);assert.equal(page2.body.next,null);
  assert.deepEqual(Object.keys(page1.body.users[0]).sort(),['id','name','position']);
  const found=await h.admin(b,'employees',{query:{query:'Тестовый 153'}});
  assert.deepEqual(found.body.users.map(u=>u.id),[]);
  await h.admin(b,'employees',{query:{query:'Тестовый 152'}});
  const params=h.state.calls.at(-1).params;
  assert.equal(params.get('FILTER[ACTIVE]'),'true');assert.equal(params.get('FILTER[USER_TYPE]'),'employee');
  assert.equal(params.get('FILTER[NAME_SEARCH]'),'Тестовый 152');
  assert.ok(![...params.values()].includes('EMAIL'));
  for(const query of [{start:'-1'},{start:'1.5'},{query:['bad']},{query:'x'.repeat(101)},{selected:'yes'}])
    assert.equal((await h.admin(b,'employees',{query})).code,400);
});

test('directory refuses inactive/extranet users, repeated cursors and token-bearing upstream errors',async t=>{
  const h=await fixture(t),b=await h.entry();
  for(const poison of [
    {ID:'19',ACTIVE:false,USER_TYPE:'employee'},
    {ID:'19',ACTIVE:true,USER_TYPE:'extranet'},
    {ID:'0',ACTIVE:true,USER_TYPE:'employee'}
  ]){h.state.poison=poison;assert.equal((await h.admin(b,'employees')).code,503);}
  h.state.poison=null;h.state.badCursor=true;assert.equal((await h.admin(b,'employees')).code,503);
  h.state.badCursor=false;h.state.unavailable=true;
  const res=await h.admin(b,'employees');assert.equal(res.code,503);
  assert.ok(!JSON.stringify(res.body).includes('SECRET'));
});

test('settings persist across a fresh application process and stale revisions cannot overwrite them',async t=>{
  const h=await fixture(t),b=await h.entry();
  const original=(await h.admin(b,'state')).body.settings;
  const saved=await save(h,b,{...original,allowedUserIds:['19'],cacheSeconds:300});assert.equal(saved.code,200);
  assert.equal(saved.body.settings.revision,1);assert.equal(await h.app.cacheTtl(),300000);
  assert.equal((await save(h,b,original)).code,409);
  h.restart();assert.equal((await h.admin(b,'state')).code,401);
  const fresh=await h.entry();
  assert.deepEqual((await h.admin(fresh,'state')).body.settings,saved.body.settings);
  assert.deepEqual((await h.admin(fresh,'employees',{query:{selected:'1'}})).body.users.map(u=>u.id),['19']);
});

test('server rejects unvalidated employee IDs, invalid schema and CSRF/origin/method tampering',async t=>{
  const h=await fixture(t),b=await h.entry();
  assert.equal((await allow(h,b,['9999'],false)).code,400);
  assert.equal((await save(h,b,{...h.defaults(),password:'change'})).code,400);
  const calls=h.state.calls.length;
  assert.equal((await h.admin(b,'settings',{method:'PUT',body:h.defaults(),headers:{'x-spravka-csrf':''}})).code,403);
  assert.equal(h.state.calls.length,calls);
  assert.equal((await h.admin(b,'state',{headers:{origin:'https://evil.example'}})).code,403);
  assert.equal((await h.admin(b,'settings',{method:'GET'})).code,405);
  assert.equal((await h.admin(b,'state',{headers:{origin:'https://forms.eduinterpain.ru'}})).code,200);
});

test('only explicitly allowed staff get the common report; removing a user revokes existing grants',async t=>{
  const h=await fixture(t,{enabled:'1'}),b=await h.entry();
  assert.equal((await h.entry('19')).res.code,403);
  assert.equal((await allow(h,b,['19'])).code,200);
  const staff=await h.entry('19');assert.match(staff.session,/^b24\./);
  assert.equal(await h.app.authorize(bearer(staff)),true);
  assert.equal((await h.admin(staff,'state')).code,401);
  assert.equal((await h.admin(b,'report',{method:'POST'})).code,403);
  assert.equal((await allow(h,b,['17'])).code,200);
  assert.equal(await h.app.authorize(bearer(staff)),false);
  // Re-allowing does not resurrect revoked sessions.
  assert.equal((await allow(h,b,['17','19'])).code,200);
  assert.equal(await h.app.authorize(bearer(staff)),false);
});

test('admin report grants do not grant administrative access, disable revokes them but not management',async t=>{
  const h=await fixture(t,{enabled:'1'}),b=await h.entry();await allow(h,b);
  const grant=await h.admin(b,'report',{method:'POST'}),report={session:grant.body.session};
  assert.equal(grant.code,200);assert.equal(await h.app.authorize(bearer(report)),true);
  const html=response();await h.app.openReport({body:{session:report.session}},html);
  assert.equal(html.code,200);assert.ok(html.body.includes(report.session));assert.ok(!html.body.includes(oauth('17')));
  assert.equal((await h.admin(report,'state')).code,401);
  await allow(h,b,['17','19'],false);
  assert.equal(await h.app.authorize(bearer(report)),false);
  assert.equal((await h.admin(b,'state')).code,200);
});

test('administrator rights and installation identity are rechecked on every administrative call',async t=>{
  const h=await fixture(t),b=await h.entry();
  assert.equal((await h.admin(b,'state')).code,200);
  h.state.admin=false;
  assert.equal((await h.admin(b,'employees')).code,403);
  h.state.admin=true;assert.equal((await h.admin(b,'state')).code,401);
  const fresh=await h.entry();h.state.record={...h.record,applicationToken:'different-installation'};
  assert.equal((await h.admin(fresh,'state')).code,403);
});

test('expired, inactive and portal-revoked admin sessions cannot read employees or save settings',async t=>{
  for(const scenario of ['expired','inactive','revoked','external']){
    const h=await fixture(t),b=await h.entry();
    if(scenario==='expired')h.advance(50*60*1000+1);
    if(scenario==='inactive')h.state.inactive=true;
    if(scenario==='revoked')h.state.revoked.add('17');
    if(scenario==='external')h.state.external=true;
    const res=await h.admin(b,'employees');assert.ok([401,403].includes(res.code));
    assert.ok(!JSON.stringify(res.body).includes(oauth('17')));
    assert.equal((await h.admin(b,'state')).code,401);
  }
});

test('access revoked during a CRM scan never receives cached or in-flight data; Basic remains independent',async t=>{
  const {createSpravkaHandler,GROUPS}=require('../lib/bitrix-spravka');
  const h=await fixture(t,{enabled:'1'}),b=await h.entry();await allow(h,b);
  const staff=await h.entry('19');h.env.SPRAVKA_PASSWORD='reserve-password-long-enough';
  const prior=process.env.B24_WEBHOOK_URL;
  process.env.B24_WEBHOOK_URL='https://interpain.bitrix24.ru/rest/1/fixture-only';
  t.after(()=>{if(prior===undefined)delete process.env.B24_WEBHOOK_URL;else process.env.B24_WEBHOOK_URL=prior});
  let release,started;
  const wait=new Promise(resolve=>{release=resolve}),scan=new Promise(resolve=>{started=resolve});
  const statuses=[{ENTITY_ID:'DYNAMIC_1036_STAGE_1',STATUS_ID:'REAL',NAME:'Реализация'},
    ...Object.entries(GROUPS).flatMap(([k,names])=>names.map((NAME,i)=>({ENTITY_ID:'DEAL_STAGE',STATUS_ID:k+i,NAME})))];
  const handler=createSpravkaHandler({env:h.env,
    authorize:(req,env,ctx)=>authorized(req,env)||h.app.authorize(req,ctx),
    revalidate:(req,env)=>authorized(req,env)||h.app.revalidate(req),
    clientFactory:()=>({call:async()=>({result:{fields:{code:{title:'Кодовое обозначение'},ufCrm21EventAddr:{title:'Адрес'}}}}),
      list:async method=>{if(method==='crm.status.list'){started();await wait;return statuses;}return []}})});
  const result=response(),pending=handler({...bearer(staff),method:'GET',query:{}},result);
  await scan;await allow(h,b,['17']);release();await pending;
  assert.equal(result.code,401);assert.equal(result.body.events,undefined);
  h.state.unavailable=true;
  const basic=response();await handler({method:'GET',query:{},headers:{authorization:
    'Basic '+Buffer.from('report:'+h.env.SPRAVKA_PASSWORD).toString('base64')}},basic);
  assert.equal(basic.code,200);
});

test('Basic password and anonymous requests never acquire admin rights or reach upstream',async t=>{
  const h=await fixture(t);
  const basic='Basic '+Buffer.from('report:reserve-password').toString('base64');
  assert.equal(authorized({headers:{authorization:basic}},{SPRAVKA_PASSWORD:'reserve-password'}),true);
  for(const header of [basic,'Bearer b24a.'+'x'.repeat(43),'']){
    const before=h.state.calls.length;
    const res=await h.admin({},'state',{headers:{authorization:header}});
    assert.equal(res.code,401);assert.equal(h.state.calls.length,before);
  }
});

test('corrupted settings fail closed without breaking administrator login or independent Basic password',async t=>{
  const fs=require('node:fs/promises'),path=require('node:path');
  const h=await fixture(t,{enabled:'1'}),b=await h.entry();await allow(h,b);
  const staff=await h.entry('19');
  await fs.writeFile(path.join(h.directory,'settings.json'),'bad-json');
  await assert.rejects(h.app.authorize(bearer(staff)),e=>e.status===503);
  assert.equal((await h.admin(b,'state')).code,503);
  assert.equal((await h.entry()).res.code,200);
  assert.equal(await h.app.cacheTtl(),60000);
  assert.equal(authorized({headers:{authorization:'Basic '+Buffer.from('report:reserve').toString('base64')}},{SPRAVKA_PASSWORD:'reserve'}),true);
});
