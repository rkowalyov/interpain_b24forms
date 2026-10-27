const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../spravka.html'),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const result=(status,data={})=>({ok:status>=200&&status<300,status,json:async()=>data});
const empty={events:[],generatedAt:'2026-10-27T12:00:00Z',warnings:[]};

// Execute the actual page scripts. Browser QA additionally checks the real DOM.
function runtime(responses,{bitrix=true}={}){
  const elements=new Map(),calls=[];
  const document={activeElement:null,querySelectorAll:()=>[],createDocumentFragment:()=>element(),
    createElement:()=>element(),getElementById:id=>elements.get(id)};
  function element(){
    return {hidden:false,disabled:false,open:false,value:'',checked:false,children:[],textContent:'',dataset:{},listeners:{},
      classList:{toggle(){}},addEventListener(name,fn){this.listeners[name]=fn},
      setAttribute(){},append(...items){this.children.push(...items)},
      replaceChildren(...items){this.children=items},focus(){document.activeElement=this},
      close(){this.open=false;this.listeners.close?.()},showModal(){this.open=true}};
  }
  for(const tag of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)){
    const e=element();e.hidden=/\shidden(?:\s|>)/.test(tag[0]);elements.set(tag[1],e);
  }
  const sandbox={document,URL,Intl,TextEncoder,AbortSignal,console,btoa:v=>Buffer.from(v,'binary').toString('base64'),
    fetch:async(url,options)=>{calls.push({url,...options});const response=responses.shift();if(response instanceof Error)throw response;return response;}};
  sandbox.window=sandbox;
  if(bitrix)sandbox.SPRAVKA_BITRIX={session:'b24.'+'a'.repeat(43)};
  const context=vm.createContext(sandbox);
  const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  for(const script of scripts)vm.runInContext(script,context);
  return {elements,calls,get:id=>elements.get(id)};
}

for(const status of [401,403]){
  test(`Bitrix ${status} clears sensitive UI and offers fixed, token-free reentry`,async()=>{
    const ui=runtime([result(status,{error:'technical server text'})]);
    ui.get('events').append('old private report');
    ui.get('copy-dialog').open=true;ui.get('copy-content').value='old copied report';
    await flush();
    assert.equal(ui.get('session-ended').hidden,false);
    assert.equal(ui.get('session-title').textContent,status===401?'Сессия завершена':'Доступ не подтверждён');
    assert.equal(ui.get('login').hidden,true);assert.equal(ui.get('report').hidden,true);
    assert.deepEqual(ui.get('events').children,[]);assert.equal(ui.get('copy-content').value,'');
    assert.equal(ui.get('copy-dialog').open,false);assert.equal(ui.get('copy-all').disabled,true);
    assert.match(html,/id="session-reenter" href="https:\/\/interpain\.bitrix24\.ru\/marketplace\/app\/445\/" target="_top"/);
  });
}
test('expired Bitrix session can fall back to independent Basic authentication',async()=>{
  const ui=runtime([result(401),result(200,empty)]);
  await flush();
  ui.get('session-password').listeners.click();
  assert.equal(ui.get('session-ended').hidden,true);assert.equal(ui.get('login').hidden,false);
  ui.get('username').value='report';ui.get('password').value='fixture-password';
  ui.get('login-form').listeners.submit({preventDefault(){}});
  await flush();
  assert.match(ui.calls[1].headers.Authorization,/^Basic /);
  assert.equal(ui.get('report').hidden,false);assert.equal(ui.get('password').value,'');
});
for(const failure of [result(503,{error:'Сервис временно недоступен'}),Object.assign(new Error('Истекло время ожидания'),{name:'TimeoutError'}),new TypeError('Failed to fetch')]){
  test(`upstream/network failure (${failure.status||failure.name}) does not claim expired session`,async()=>{
    const ui=runtime([failure]);await flush();
    assert.equal(ui.get('session-ended').hidden,true);assert.equal(ui.get('report').hidden,false);
    assert.equal(ui.get('notice').hidden,false);
    assert.doesNotMatch(ui.get('notice').textContent,/Сессия завершена/);
  });
}
test('incorrect reserve password retains the password form, not Bitrix reentry screen',async()=>{
  const ui=runtime([result(401,{error:'Неверный пароль'})],{bitrix:false});
  ui.get('username').value='report';ui.get('password').value='wrong';
  ui.get('login-form').listeners.submit({preventDefault(){}});await flush();
  assert.equal(ui.get('session-ended').hidden,true);assert.equal(ui.get('login').hidden,false);
  assert.equal(ui.get('login-error').textContent,'Неверный пароль');
});
