import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cdp, endpoint, findTarget } from '../dist/cdp.js';

test('CEF discovers the owned IPv6 preview beside an unrelated IPv4 desktop and connects on that address',async t => {
  const previous={fetch:globalThis.fetch,WebSocket:globalThis.WebSocket};
  t.after(()=>Object.assign(globalThis,previous));
  const directory=path.resolve('owned-preview'),url=pathToFileURL(path.join(directory,'index.html')).href;
  const owned={id:'preview',type:'page',url,webSocketDebuggerUrl:'ws://localhost:9223/devtools/page/preview'};
  let ipv4=[{...owned,id:'desktop',url:pathToFileURL(path.resolve('desktop','index.html')).href}];
  let ipv6=[owned],connected;
  globalThis.fetch=async address=>{
    const list=new URL(address).hostname==='[::1]'?ipv6:ipv4;
    if(list instanceof Error)throw list;
    if(typeof list==='string')return new Response(list);
    return new Response(JSON.stringify(list));
  };
  globalThis.WebSocket=class extends EventTarget {
    constructor(address){super();connected=new URL(address);queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
    close(){this.dispatchEvent(new Event('close'))}
  };
  let target=await findTarget(9223,directory);
  assert.ok(target,'Owned preview is present only on the IPv6 listener.');
  const cdp=await Cdp.connect(9223,target,100);
  assert.equal(connected.hostname,'[::1]');assert.equal(connected.port,'9223');cdp.close();
  // Explicit IPv6 must also survive a direct connection without discovery metadata.
  const direct=await Cdp.connect(9223,{...owned,webSocketDebuggerUrl:'ws://[::1]:9223/devtools/page/preview'},100);
  assert.equal(connected.hostname,'[::1]');direct.close();
  ipv4=[owned];ipv6=[];
  target=await findTarget(9223,directory);
  const v4=await Cdp.connect(9223,target,100);assert.equal(connected.hostname,'127.0.0.1');v4.close();
  ipv6=[{...owned,id:'another'}];
  await assert.rejects(findTarget(9223,directory),{code:'AMBIGUOUS_TARGET'});
  ipv4=new Error('No IPv4 listener');
  assert.equal((await findTarget(9223,directory)).id,'another');
  assert.deepEqual(await endpoint(9223,'/json/list'),ipv6);
  ipv6=[];assert.equal(await findTarget(9223,directory),undefined);
  ipv6={invalid:true};await assert.rejects(findTarget(9223,directory),{code:'CEF_PROTOCOL'});
  ipv4=[owned];
  for(const invalid of [[null],[{id:'bad'}],'{', ' '.repeat(2*1024*1024+1)]) {
    ipv6=invalid;
    await assert.rejects(findTarget(9223,directory));
  }
  ipv4=new Error('No IPv4 listener');
  ipv6=new Error('No IPv6 listener');await assert.rejects(findTarget(9223,directory),/No IPv4 listener/);
});

test('CEF session handles replies, bounded logs, protocol errors, timeouts and disconnects',async t => {
  const previous = globalThis.WebSocket;
  let socket;
  class FakeSocket extends EventTarget {
    constructor() { super(); socket=this; queueMicrotask(()=>this.dispatchEvent(new Event('open'))); }
    send(text) { this.last=JSON.parse(text); }
    close() { this.dispatchEvent(new Event('close')); }
    message(value) { this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)})); }
  }
  globalThis.WebSocket = FakeSocket; t.after(()=>{globalThis.WebSocket=previous});
  const target = {id:'owned',type:'page',url:'file:///owned/index.html',webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/owned'};
  for(const webSocketDebuggerUrl of ['ws://example.com:9223/devtools/page/owned','ws://127.0.0.1:9224/devtools/page/owned','wss://[::1]:9223/devtools/page/owned','ws://user:password@[::1]:9223/devtools/page/owned']) {
    await assert.rejects(Cdp.connect(9223,{...target,discoveryHost:'[::1]',webSocketDebuggerUrl},100),{code:'UNSAFE_CEF_ENDPOINT'});
  }
  const cdp = await Cdp.connect(9223,target,40);
  const response = cdp.call('Runtime.enable'); socket.message({id:socket.last.id,result:{enabled:true}});
  assert.deepEqual(await response,{enabled:true});
  const unsupported = cdp.call('Page.notSupported'); socket.message({id:socket.last.id,error:{message:'Method not found'}});
  await assert.rejects(unsupported,{code:'CDP_ERROR'});
  for(let i=0;i<205;i++) socket.message({method:'Runtime.consoleAPICalled',params:{i}});
  const logs = cdp.logs(); assert.equal(logs.entries.length,200); assert.equal(logs.truncated,true); assert.equal(logs.cursor,205);
  assert.equal(cdp.logs(204).entries.length,1);
  socket.message({method:'Runtime.exceptionThrown',params:{text:'x'.repeat(20000)}});
  assert.equal(cdp.logs(205).entries[0].params.truncated,true);
  await assert.rejects(cdp.call('Page.captureScreenshot'),{code:'CDP_TIMEOUT'});
  const pending = cdp.call('Runtime.evaluate'); cdp.close();
  await assert.rejects(pending,{code:'CEF_DISCONNECTED'});
});
