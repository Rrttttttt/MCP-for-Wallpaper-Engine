import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine } from '../dist/engine.js';

// Seed owned sessions instead of launching WE; replies still cross the CDP transport.
// Real event receipt and rendered eyes require the separate engine acceptance.
function fixture(t) {
  const previous={fetch:globalThis.fetch,WebSocket:globalThis.WebSocket};
  const pages=new Map(),sent=[];
  let targets;
  globalThis.fetch=async address=>new Response(JSON.stringify(new URL(address).hostname==='[::1]'?[]:targets??[...pages.values()].map(p=>p.target)));
  class Socket extends EventTarget {
    constructor(url) { super(); this.page=pages.get(new URL(url).pathname.split('/').at(-1)); queueMicrotask(()=>this.dispatchEvent(new Event('open'))); }
    close() { this.dispatchEvent(new Event('close')); }
    send(text) {
      const message=JSON.parse(text),page=this.page;
      sent.push({page:page.target.id,...message});
      let result={},error;
      if(message.method==='Runtime.evaluate') result={result:{type:'string',value:JSON.stringify(page.viewport)}};
      if(message.method==='Input.dispatchMouseEvent') {
        error=page.inputError;
        page.afterInput?.();
      }
      queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:message.id,result,error})})));
    }
  }
  globalThis.WebSocket=Socket;
  const config={projectRoots:[],workspace:path.resolve('mouse-test'),devtoolsPort:9223,timeoutMs:1000};
  const engine=new Engine(config,{});
  function add(id,type='web') {
    const directory=path.join(config.workspace,id),url=pathToFileURL(path.join(directory,'index.html')).href;
    const page={target:{id,type:'page',url,webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/'+id},viewport:{url,readyState:'complete',width:801,height:601}};
    pages.set(id,page);
    engine.previews.set(id,{previewId:id,directory,files:new Map([['project.json',Buffer.from(JSON.stringify({type}))]]),native:false});
    return page;
  }
  t.after(()=>{
    for(const p of engine.previews.values()) p.cdp?.close();
    Object.assign(globalThis,previous);
  });
  return {engine,add,config,sent,inputs:()=>sent.filter(s=>s.method==='Input.dispatchMouseEvent'),targets:value=>{targets=value}};
}

test('mouse input maps the current CSS viewport and stays in the requested preview',async t=>{
  const f=fixture(t),a=f.add('a'); f.add('b');
  const result=await f.engine.moveMouse('a',0.25,0.75);
  assert.deepEqual(result.position,{x:200,y:450});
  assert.equal(result.confirmation,'event-dispatched'); assert.equal(result.visualResponse,'unverified');
  assert.deepEqual(f.inputs().map(i=>({page:i.page,params:i.params})),[{page:'a',params:{type:'mouseMoved',x:200,y:450,button:'none',buttons:0,modifiers:0}}]);
  a.viewport.width=641; a.viewport.height=481;
  assert.deepEqual((await f.engine.moveMouse('a',1,1)).position,{x:640,y:480});
  assert.deepEqual((await f.engine.moveMouse('b',0,0)).position,{x:0,y:0});
  assert.deepEqual(f.inputs().map(i=>i.page),['a','a','b']);
});

test('mouse input refuses invalid coordinates, unsupported previews and missing ownership evidence',async t=>{
  const f=fixture(t),a=f.add('a'); f.add('scene','scene');
  await assert.rejects(f.engine.moveMouse('missing',0,0),{code:'PREVIEW_NOT_FOUND'});
  await assert.rejects(f.engine.moveMouse('scene',0,0),{code:'MOUSE_INPUT_UNSUPPORTED'});
  f.config.devtoolsPort=null;
  await assert.rejects(f.engine.moveMouse('a',0,0),{code:'MOUSE_INPUT_UNSUPPORTED'});
  f.config.devtoolsPort=9223;
  for(const [x,y] of [[-0.01,0],[1.01,0],[NaN,0],[0,Infinity],[0,-1]]) await assert.rejects(f.engine.moveMouse('a',x,y),{code:'INVALID_MOUSE_POSITION'});
  // There is now a cached connection; losing discovery must not reuse it for input.
  f.targets([]);
  await assert.rejects(f.engine.moveMouse('a',0,0),{code:'CEF_TARGET_UNAVAILABLE'});
  f.targets([a.target,{...a.target,id:'duplicate'}]);
  await assert.rejects(f.engine.moveMouse('a',0,0),{code:'AMBIGUOUS_TARGET'});
  f.targets([a.target]); a.viewport.url=pathToFileURL(path.resolve('other','index.html')).href;
  await assert.rejects(f.engine.moveMouse('a',0,0),{code:'TARGET_CHANGED'});
  a.viewport.url=a.target.url;
  for(const viewport of [null,{...a.viewport,width:0},{...a.viewport,height:8193},{...a.viewport,readyState:'loading'}]) {
    const saved=a.viewport; a.viewport=viewport;
    await assert.rejects(f.engine.moveMouse('a',0,0),{code:'CEF_VIEWPORT'});
    a.viewport=saved;
  }
  assert.equal(f.inputs().length,0);
});

test('mouse input reports attempted dispatch when protocol, navigation or viewport verification fails',async t=>{
  const f=fixture(t),a=f.add('a');
  a.inputError={message:'Method not found'};
  await assert.rejects(f.engine.moveMouse('a',0.5,0.5),e=>e.code==='CDP_ERROR'&&e.details.dispatchAttempted===true);
  a.inputError=undefined;
  a.afterInput=()=>{a.viewport.width=800};
  await assert.rejects(f.engine.moveMouse('a',0.5,0.5),e=>e.code==='TARGET_CHANGED'&&e.details.dispatchAttempted===true);
  a.afterInput=()=>{a.viewport.url='https://example.invalid/'};
  await assert.rejects(f.engine.moveMouse('a',0.5,0.5),e=>e.code==='TARGET_CHANGED'&&e.details.dispatchAttempted===true);
  assert.equal(f.inputs().length,3);
});
