// Loopback-only fixture server for browser QA. Never deployed (test/ is excluded).
const express = require('express');
const helmet = require('helmet');
const path = require('node:path');
const {createBitrixSpravkaApp,sessionCors} = require('../../lib/bitrix-spravka-app');
const {createSpravkaHandler,authorized,GROUPS} = require('../../lib/bitrix-spravka');
const root = path.join(__dirname,'../..');
const app = express();
app.use(helmet({contentSecurityPolicy:{directives:{scriptSrc:["'self'","'unsafe-inline'"],styleSrc:["'self'","'unsafe-inline'"]}}}));
app.use(express.urlencoded({extended:false}));
app.use(express.json());
app.use(sessionCors(require('cors')({origin:(origin,done)=>done(
  origin && origin !== 'https://another-allowed-site.example' ? new Error('QA origin rejected') : null,true
)})));
const env={SPRAVKA_PASSWORD:'qa-reserve-password-only-123',SPRAVKA_B24_CLIENT_ID:'local.fixture-client',SPRAVKA_B24_ENABLED:'1'};
const applicationToken='fixture-application-token-123456';
const memberId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const oauth='fixture-oauth-not-a-real-token-12345';
let record={clientId:env.SPRAVKA_B24_CLIENT_ID,appId:'8',memberId,applicationToken};
const bitrix = createBitrixSpravkaApp({env,store:{read:async()=>record,create:async r=>(record ||= r)},
  fetchImpl:async url=>({ok:true,status:200,text:async()=>JSON.stringify({result:url.includes('app.info')?
    {ID:8,CODE:env.SPRAVKA_B24_CLIENT_ID,STATUS:'L',INSTALLED:true}:{ID:17,ACTIVE:true}})})});
const statuses=[{ENTITY_ID:'DYNAMIC_1036_STAGE_1',STATUS_ID:'REAL',NAME:'Реализация'},
  ...Object.entries(GROUPS).flatMap(([key,names])=>names.map((NAME,i)=>({ENTITY_ID:'DEAL_STAGE',STATUS_ID:key+i,NAME})))];
const fields={code:{title:'Кодовое обозначение'},ufCrm21EventAddr:{title:'Адрес'}};
const items=[{id:301,code:'26_10_10-11',title:'ДЕМО — Краснодар',stageId:'REAL',ufCrm21EventAddr:'(Краснодар), центр'},
  {id:323,code:'26_11_07-08',title:'ДЕМО — Москва',stageId:'REAL',ufCrm21EventAddr:'г. Москва, центр'}];
process.env.B24_WEBHOOK_URL='https://interpain.bitrix24.ru/rest/1/fixture-only';
const report=createSpravkaHandler({env,authorize:(req,config,context)=>authorized(req,config)||bitrix.authorize(req,context),
  clientFactory:()=>({call:async()=>({result:{fields}}),list:async method=>
    method==='crm.status.list'?statuses:method==='crm.item.list'?items:[]})});
app.post('/spravka/bitrix',bitrix.entry);
app.post('/api/spravka/bitrix/logout',bitrix.logout);
app.all('/api/spravka',report);
app.get('/spravka',(_req,res)=>res.sendFile(path.join(root,'spravka.html')));
app.use('/assets',express.static(path.join(root,'assets')));
app.get('/qa',(_req,res)=>res.type('html').send(`<!doctype html><html lang="ru"><meta charset="utf-8">
<title>Тест входа Битрикс24</title><h1>Только тестовые данные, не настоящий портал</h1>
<form method="post" action="/spravka/bitrix?DOMAIN=interpain.bitrix24.ru">
<input type="hidden" name="AUTH_ID" value="${oauth}"><input type="hidden" name="APPLICATION_TOKEN" value="${applicationToken}">
<input type="hidden" name="member_id" value="${memberId}"><input type="hidden" name="AUTH_EXPIRES" value="3600">
<button>Открыть справку как сотрудник</button></form><a href="/spravka">Резервный вход</a></html>`));
app.listen(Number(process.env.PORT || 4313),'127.0.0.1',()=>console.log('Bitrix QA fixture listening'));
