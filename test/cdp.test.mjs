import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cdp } from '../dist/cdp.js';

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
  await assert.rejects(Cdp.connect(9223,{...target,webSocketDebuggerUrl:'ws://example.com:9223/devtools/page/owned'},100),{code:'UNSAFE_CEF_ENDPOINT'});
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
