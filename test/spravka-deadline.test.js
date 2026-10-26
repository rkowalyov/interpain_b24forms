const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createClient,createSpravkaHandler,GROUPS}=require('../lib/bitrix-spravka');
const {createBitrixSpravkaApp}=require('../lib/bitrix-spravka-app');
const {REQUEST_TIMEOUT_MS}=require('../lib/spravka-deadline');

const env={SPRAVKA_PASSWORD:'fixture-password-never-production'};
const fields={code:{title:'Кодовое обозначение'},ufCrm21EventAddr:{title:'Адрес'}};
const statuses=[{ENTITY_ID:'DYNAMIC_1036_STAGE_1',STATUS_ID:'REAL',NAME:'Реализация'},
  ...Object.entries(GROUPS).flatMap(([key,names])=>names.map((NAME,i)=>({ENTITY_ID:'DEAL_STAGE',STATUS_ID:key+i,NAME})))];
function response(){return {code:200,headers:{},setHeader(k,v){this.headers[k]=v},getHeader(k){return this.headers[k]},
  removeHeader(k){delete this.headers[k]},status(c){this.code=c;return this},type(){return this},
  send(v){this.body=v;return this},json(v){this.body=v;return this}};}
const request=(kind='fast')=>({method:'GET',headers:{},query:{},kind});
function emptyClient(gate){return {call:async()=>({result:{fields}}),list:async method=>{
  if(method==='crm.status.list'){if(gate)await gate;return statuses;}return [];
}};}
function webhook(t){
  const previous=process.env.B24_WEBHOOK_URL;
  process.env.B24_WEBHOOK_URL='https://interpain.bitrix24.ru/rest/1/fixture-only';
  t.after(()=>{if(previous===undefined)delete process.env.B24_WEBHOOK_URL;else process.env.B24_WEBHOOK_URL=previous;});
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}

test('one 55s deadline includes real OAuth identity and the subsequent CRM scan',async t=>{
  webhook(t);
  let clock=100000,oauthCost=0;
  const appEnv={...env,SPRAVKA_B24_ENABLED:'1',SPRAVKA_B24_CLIENT_ID:'local.fixture-client'};
  const record={clientId:appEnv.SPRAVKA_B24_CLIENT_ID,memberId:'a'.repeat(32),applicationToken:'fixture-application-token',appId:'8'};
  const app=createBitrixSpravkaApp({env:appEnv,now:()=>clock,store:{read:async()=>record},
    fetchImpl:async url=>{
      clock+=oauthCost;
      return {ok:true,status:200,text:async()=>JSON.stringify({result:url.includes('app.info')?
        {ID:8,CODE:appEnv.SPRAVKA_B24_CLIENT_ID,STATUS:'L',INSTALLED:true}:{ID:17,ACTIVE:true}})};
    }});
  const entry=response();
  await app.entry({query:{DOMAIN:'interpain.bitrix24.ru'},body:{
    AUTH_ID:'fixture-oauth-not-real-123456',APPLICATION_TOKEN:record.applicationToken,member_id:record.memberId,AUTH_EXPIRES:'3600'
  }},entry);
  const token=JSON.parse(/window\.SPRAVKA_BITRIX=({"session":"[^"]+"})/.exec(entry.body)[1]).session;
  const start=clock;
  let assignedDeadline,calls=0;
  oauthCost=7000;
  const handler=createSpravkaHandler({env,now:()=>clock,
    authorize:(req,_env,context)=>app.authorize(req,context),
    clientFactory:(base,_fetch,options)=>{
      assignedDeadline=options.deadline;
      return createClient(base,async url=>{
        calls++;clock+=10500;
        const result=url.includes('crm.status.list')?statuses:url.includes('crm.item.fields')?{fields}:
          url.includes('crm.item.list')?{items:[1,2].map(id=>({id,code:'26_'+id,title:'Fixture',stageId:'REAL',ufCrm21EventAddr:'Москва'}))}:[];
        return {ok:true,json:async()=>({result})};
      },options);
    }});
  const res=response();
  await handler({...request(),headers:{authorization:'Bearer '+token}},res);
  assert.equal(assignedDeadline,start+REQUEST_TIMEOUT_MS);
  assert.equal(res.code,504);assert.match(res.body.error,/Истекло время/);
  assert.equal(calls,4);assert.ok(clock-start<65000);
  // Old code returned 200 only after 66.5s; now the scan stops at its common deadline.
});

test('slow authorization leaves less CRM time but a report within the common budget succeeds',async t=>{
  webhook(t);let clock=0,deadline;
  const handler=createSpravkaHandler({env,now:()=>clock,
    authorize:async()=>{clock+=14000;return true},
    clientFactory:(_base,_fetch,options)=>{deadline=options.deadline;return {
      call:async()=>{clock+=10000;return {result:{fields}}},
      list:async method=>{clock+=10000;return method==='crm.status.list'?statuses:[]}
    }}});
  const res=response();await handler(request(),res);
  assert.equal(deadline,55000);assert.equal(clock,44000);assert.equal(res.code,200);
});

test('expired authorization cannot reach even an already-populated report cache',async t=>{
  webhook(t);let clock=0,cost=0,scans=0;
  const handler=createSpravkaHandler({env,now:()=>clock,
    authorize:async()=>{clock+=cost;return true},
    clientFactory:()=>{scans++;return emptyClient()}});
  await handler(request(),response());cost=55001;
  const res=response();await handler(request(),res);
  assert.equal(res.code,503);assert.equal(scans,1);assert.equal(res.body.events,undefined);
});

test('a request waiting for another refresh keeps its own earlier deadline without cancelling the cache',async t=>{
  webhook(t);let clock=0,scans=0;
  const auth=deferred(),crm=deferred(),entered=deferred();
  const handler=createSpravkaHandler({env,now:()=>clock,requestTimeoutMs:10000,
    authorize:req=>req.kind==='slow'?auth.promise:true,
    clientFactory:()=>{scans++;entered.resolve();return emptyClient(crm.promise)}});
  const early=response(),late=response();
  const earlier=handler(request('slow'),early);
  clock=4000;const later=handler(request(),late);await entered.promise;
  clock=6000;auth.resolve(true);await new Promise(setImmediate);
  clock=11000;crm.resolve();await later;await earlier;
  assert.equal(early.code,504);assert.equal(late.code,200);assert.equal(scans,1);
  const cached=response();await handler(request(),cached);assert.equal(cached.code,200);assert.equal(scans,1);
});

test('an unresponsive authorization is bounded by the whole-request timer',async()=>{
  const handler=createSpravkaHandler({env,requestTimeoutMs:20,authorize:()=>new Promise(()=>{})});
  const res=response();await handler(request(),res);assert.equal(res.code,503);
});

test('an unresponsive CRM scan is bounded even when an injected client ignores abort',async t=>{
  webhook(t);
  const handler=createSpravkaHandler({env,requestTimeoutMs:20,authorize:()=>true,
    clientFactory:()=>({list:()=>new Promise(()=>{})})});
  const res=response();await handler(request(),res);assert.equal(res.code,504);
});

test('a hanging response body is included in the CRM deadline',async()=>{
  const client=createClient('https://example.invalid/rest/fixture',async()=>({
    ok:true,json:()=>new Promise(()=>{})
  }),{deadline:Date.now()+20});
  await assert.rejects(client.call('crm.status.list'),error=>error.code==='TIMEOUT');
});
