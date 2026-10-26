// Local browser QA. All staff, OAuth strings and CRM records are synthetic.
const express=require('express'),helmet=require('helmet'),path=require('node:path');
const {fixture,oauth}=require('./spravka-admin-harness.cjs');
const {createSpravkaHandler,authorized,GROUPS}=require('../../lib/bitrix-spravka');
const root=path.join(__dirname,'../..'),port=Number(process.env.PORT||4317);
(async()=>{
  const h=await fixture({after(){}},{requestOrigin:`http://127.0.0.1:${port}`}),app=express();
  app.use(helmet({contentSecurityPolicy:{directives:{scriptSrc:["'self'","'unsafe-inline'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'","data:"]}}}));
  app.use(express.urlencoded({extended:false}));app.use(express.json());
  h.env.SPRAVKA_PASSWORD='qa-reserve-password-only-123';
  const fields={code:{title:'Кодовое обозначение'},ufCrm21EventAddr:{title:'Адрес'}};
  const statuses=[{ENTITY_ID:'DYNAMIC_1036_STAGE_1',STATUS_ID:'REAL',NAME:'Реализация'},
    ...Object.entries(GROUPS).flatMap(([key,names])=>names.map((NAME,i)=>({ENTITY_ID:'DEAL_STAGE',STATUS_ID:key+i,NAME})))];
  const items=[{id:301,code:'26_10_10-11',title:'ТЕСТ Краснодар',stageId:'REAL',ufCrm21EventAddr:'(Краснодар), центр'},
    {id:323,code:'26_11_07-08',title:'ТЕСТ Москва',stageId:'REAL',ufCrm21EventAddr:'г. Москва, центр'}];
  process.env.B24_WEBHOOK_URL='https://interpain.bitrix24.ru/rest/1/fixture-only';
  const report=createSpravkaHandler({env:h.env,cacheTtl:()=>h.app.cacheTtl(),
    authorize:(req,env,ctx)=>authorized(req,env)||h.app.authorize(req,ctx),
    revalidate:(req,env)=>authorized(req,env)||h.app.revalidate(req),
    clientFactory:()=>({call:async()=>({result:{fields}}),list:async method=>method==='crm.status.list'?statuses:method==='crm.item.list'?items:[]})});
  app.post('/spravka/bitrix',(req,res)=>h.app.entry(req,res));
  app.post('/spravka/bitrix/report',(req,res)=>h.app.openReport(req,res));
  app.all('/api/spravka/bitrix/admin/:action',(req,res)=>h.app.admin(req,res));
  app.post('/api/spravka/bitrix/logout',(req,res)=>h.app.logout(req,res));
  app.all('/api/spravka',report);
  app.get('/spravka',(_req,res)=>res.sendFile(path.join(root,'spravka.html')));
  app.use('/assets',express.static(path.join(root,'assets')));
  app.post('/qa/control',(req,res)=>{
    if(req.body.gate!==undefined)h.env.SPRAVKA_B24_ENABLED=req.body.gate?'1':'0';
    if(req.body.admin!==undefined)h.state.admin=req.body.admin;
    if(req.body.unavailable!==undefined)h.state.unavailable=req.body.unavailable;
    if(req.body.restart)h.restart();
    res.json({ok:true});
  });
  app.get('/qa',(_req,res)=>{
    const form=id=>`<form method="post" action="/spravka/bitrix?DOMAIN=interpain.bitrix24.ru">
      <input type="hidden" name="AUTH_ID" value="${oauth(id)}"><input type="hidden" name="APPLICATION_TOKEN" value="${h.record.applicationToken}">
      <input type="hidden" name="member_id" value="${h.record.memberId}"><input type="hidden" name="AUTH_EXPIRES" value="3600">
      <button>${id==='17'?'Открыть управление (тест)':'Открыть как сотрудник 19 (тест)'}</button></form>`;
    res.type('html').send(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Тест сервера управления</title><h1>Только синтетические данные</h1>${form('17')}${form('19')}<a href="/spravka">Резервный вход</a></html>`);
  });
  app.listen(port,'127.0.0.1',()=>console.log(`Admin QA fixture listening on ${port}`));
})().catch(e=>{console.error(e);process.exit(1)});
