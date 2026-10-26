// Synthetic upstream only. Never packaged in a production release.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createBitrixSpravkaApp}=require('../../lib/bitrix-spravka-app');
const {settingsStore,defaults}=require('../../lib/bitrix-spravka-settings');
const response=()=>({code:200,headers:{},setHeader(k,v){this.headers[k]=v},getHeader(k){return this.headers[k]},
  removeHeader(k){delete this.headers[k]},status(c){this.code=c;return this},type(){return this},
  send(body){this.body=body;return this},json(body){this.body=body;return this},end(){return this}});
const oauth=id=>`fixture-oauth-user-${id}-not-real-123456`;
async function fixture(t,{enabled='0',requestOrigin='https://forms.eduinterpain.ru'}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'spravka-admin-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const env={SPRAVKA_B24_CLIENT_ID:'local.fixture-client',SPRAVKA_B24_ENABLED:enabled,SPRAVKA_B24_STATE_DIR:directory};
  let clock=Date.now();
  const state={admin:true,unavailable:false,revoked:new Set(),calls:[],poison:null,
    users:['17','19',...Array.from({length:53},(_,i)=>String(i+100))].map(id=>({
      ID:id,ACTIVE:true,USER_TYPE:'employee',LAST_NAME:'Тестовый',NAME:id,WORK_POSITION:'Учебный отдел (тест)'
    }))};
  const record={clientId:env.SPRAVKA_B24_CLIENT_ID,memberId:'a'.repeat(32),applicationToken:'fixture-application-token-123456',appId:'445'};
  const store={read:async()=>state.record===undefined?record:state.record};
  async function fetchImpl(url,options){
    const params=new URLSearchParams(options.body),token=params.get('auth'),id=/user-(\d+)-/.exec(token)?.[1];
    state.calls.push({method:url.split('/').pop(),params});
    if(state.unavailable)throw new Error('SECRET-UPSTREAM-NEVER-EXPOSE');
    if(state.revoked.has(id))return {ok:false,status:401,text:async()=>JSON.stringify({error:'user_access_error',error_description:token})};
    let result,next,total;
    if(url.includes('app.info'))result={ID:445,CODE:env.SPRAVKA_B24_CLIENT_ID,STATUS:'L',INSTALLED:true};
    else if(url.includes('user.current'))result={ID:id,ACTIVE:!state.inactive,USER_TYPE:state.external?'extranet':undefined,LAST_NAME:'Администратор',NAME:'Тестовый'};
    else if(url.includes('user.admin'))result=id==='17'&&state.admin;
    else if(url.includes('user.get')){
      const ids=[...params].filter(([key])=>key.startsWith('FILTER[ID][')).map(([,value])=>value);
      const search=params.get('FILTER[NAME_SEARCH]')?.toLocaleLowerCase('ru');
      const users=state.users.filter(u=>(!ids.length||ids.includes(u.ID))&&
        (!search||`${u.LAST_NAME} ${u.NAME}`.toLocaleLowerCase('ru').includes(search)));
      const start=Number(params.get('start')||0);total=users.length;
      result=users.slice(start,start+50);
      if(state.poison)result=[state.poison];
      next=start+50<total?start+50:undefined;
      if(state.badCursor)next=start;
    }else throw new Error('Unexpected fixture REST method');
    return {ok:true,status:200,text:async()=>JSON.stringify({result,next,total})};
  }
  const make=()=>createBitrixSpravkaApp({env,store,fetchImpl,requestOrigin,now:()=>clock});
  let app=make();
  async function entry(id='17'){
    const res=response();await app.entry({method:'POST',query:{DOMAIN:'interpain.bitrix24.ru'},headers:{},
      body:{AUTH_ID:oauth(id),AUTH_EXPIRES:'3600',APPLICATION_TOKEN:record.applicationToken,member_id:record.memberId}},res);
    const match=/window\.SPRAVKA_ADMIN=({[^;]+});/.exec(res.body||'');
    if(match)return {res,...JSON.parse(match[1])};
    const report=/window\.SPRAVKA_BITRIX=({"session":"[^"]+"})/.exec(res.body||'');
    return {res,...(report?JSON.parse(report[1]):{})};
  }
  async function admin(boot,action,{method='GET',body,query={},headers={}}={}){
    const res=response();await app.admin({method,params:{action},query,body,headers:{
      authorization:`Bearer ${boot.session}`,'x-spravka-csrf':boot.csrf,...headers}},res);return res;
  }
  return {env,state,record,directory,entry,admin,get app(){return app},restart(){app=make()},
    advance(ms){clock+=ms},policy:settingsStore(directory),defaults};
}
module.exports={fixture,response,oauth};
