// Loaded only by shutdown-preload.mjs in a test-owned server process.
import assert from 'node:assert/strict';
import {appendFile} from 'node:fs/promises';
import {Fault} from '../../dist/files.js';

const mode=process.env.WE_TEST_WINDOW_STATE;
let present=mode!=='absent';
const identity={handle:'123',processId:123,startTime:'123',processPath:'test-engine',className:'test-preview'};
export async function record(value) {await appendFile(process.env.WE_TEST_TRACE,JSON.stringify(value)+'\n')}
export async function nativeAvailable() {return true}
export async function nativeCall(operation,request={},timeoutMs=8000) {
  await record({operation,request,timeoutMs});
  if(operation==='baseline') return {handles:[]};
  if(operation==='absent') {
    if(mode==='unavailable') throw new Fault('NATIVE_CAPTURE_TIMEOUT','Injected enumeration failure');
    if(present) throw new Fault('WINDOW_CLOSE_TIMEOUT','Window still exists');
    return {state:'window-absent'};
  }
  if(operation==='find') {
    if(mode==='absent') {
      await new Promise(resolve=>setTimeout(resolve,timeoutMs));
      throw new Fault('WINDOW_NOT_FOUND','No test window appeared');
    }
    if(mode==='unavailable') throw new Fault('NATIVE_CAPTURE_TIMEOUT','Injected enumeration failure');
    if(mode==='not-owned') throw new Fault('WINDOW_NOT_OWNED','Injected replacement window');
    assert.deepEqual(request.baseline,[]);
    return {identity};
  }
  if(operation==='verify') {assert.deepEqual(request.expected,identity);return {identity}}
  throw new Error('Unexpected native operation: '+operation);
}
export async function cli(args) {
  await record({operation:'cli',args});
  if(args[1]==='openWallpaper') throw new Fault('CLI_FAILED','Injected CLI failure after registry persistence');
  assert.equal(args[1],'closeWallpaper');
  assert.match(args[3],/^WE-MCP-[a-f0-9-]{36}$/);
  present=false;
  return {stdout:'',stderr:''};
}
export function pngInfo() {throw new Error('Capture is outside this shutdown fixture')}
