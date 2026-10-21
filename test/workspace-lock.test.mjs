import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Projects } from '../dist/projects.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'we-mcp-lock-'));
  const workspace = path.join(directory,'data'), config = path.join(directory,'config.json');
  await fs.writeFile(config,JSON.stringify({workspace}));
  const clients=[];
  t.after(async()=>{for (const client of clients.reverse()) await client.close();await fs.rm(directory,{recursive:true,force:true})});
  return {directory,workspace,config,lock:path.join(workspace,'server.lock'),connect:()=>connect(config,clients)};
}
async function connect(config,clients) {
  const transport = new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url)),'--config',config],stderr:'pipe'});
  const client = new Client({name:'workspace-lock-test',version:'1'});
  transport.stderr?.resume();
  clients.push(client);
  await client.connect(transport);
  return {client,transport};
}
async function diagnose(client) {
  const result=await client.callTool({name:'we_workspace_diagnose',arguments:{}});
  assert.equal(result.isError,undefined);
  return result.structuredContent;
}

test('legacy empty lock remains reachable through MCP without changing the workspace',async t=>{
  const {workspace,connect,lock}=await fixture(t);
  await fs.mkdir(lock,{recursive:true});
  const before=await fs.stat(lock);
  const {client}=await connect();
  const tools=(await client.listTools()).tools;
  assert.equal(tools.length,14);
  assert.equal(tools.find(tool=>tool.name==='we_workspace_diagnose').annotations.readOnlyHint,true);
  const report=await diagnose(client);
  assert.equal(report.mode,'diagnostic');
  assert.equal(report.lock.state,'present');
  assert.equal(report.lock.owner,null);
  assert.equal(report.holder.state,'unknown');
  assert.equal(report.recovery.available,false);
  assert.match(report.lock.fingerprint,/^[a-f0-9]{64}$/);
  const previewId='11111111-1111-4111-8111-111111111111',projectId='managed/blocked';
  const blockedTools=[
    ['we_project_list',{}],['we_project_create',{name:'blocked',title:'Blocked'}],
    ['we_environment_probe',{}],['we_preview_close',{previewId}],
    ['we_project_inspect',{projectId}],['we_project_validate',{projectId}],
    ['we_project_apply',{projectId,expectedRevision:'a'.repeat(64),changes:[{path:'note.txt',content:'blocked'}]}],
    ['we_project_restore',{projectId,checkpointId:previewId,expectedRevision:'a'.repeat(64)}],
    ['we_preview_open',{projectId}],['we_preview_set_properties',{previewId,properties:{}}],
    ['we_preview_move_mouse',{previewId,x:0.5,y:0.5}],['we_preview_observe',{previewId}],
    ['we_publish_prepare',{projectId,intent:'new'}]
  ];
  assert.deepEqual(new Set(blockedTools.map(([name])=>name)),new Set(tools.filter(tool=>tool.name!=='we_workspace_diagnose').map(tool=>tool.name)));
  for (const [name,args] of blockedTools) {
    const result=await client.callTool({name,arguments:args});
    assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'WORKSPACE_LOCKED');
  }
  await client.close();
  assert.deepEqual(await fs.readdir(workspace),['server.lock']);
  assert.deepEqual(await fs.readdir(lock),[]);
  const after=await fs.stat(lock);assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
});

test('a second real MCP session identifies the owner and cannot unlock or take over after it exits',async t=>{
  const {workspace,lock,connect}=await fixture(t);
  const first=await connect();
  const owned=await diagnose(first.client);
  assert.equal(owned.mode,'owner');assert.equal(owned.lock.owner.pid,first.transport.pid);
  assert.equal(owned.lock.owner.host,os.hostname());
  if (process.platform==='win32') {
    assert.match(owned.lock.owner.processStartTime,/^\d{15,20}$/);
    assert.equal(owned.holder.state,'alive');
  }
  const raw=await fs.readFile(path.join(lock,'owner.json'),'utf8');
  const second=await connect();
  const blocked=await diagnose(second.client);
  assert.equal(blocked.mode,'diagnostic');assert.equal(blocked.lock.fingerprint,owned.lock.fingerprint);
  if (process.platform==='win32') assert.equal(blocked.holder.state,'alive');
  // Simulate only the OS query denial in an isolated child, without altering the service/runtime environment.
  const queryDenied=`
    import {createRequire,syncBuiltinESMExports} from 'node:module';
    const cp=createRequire(import.meta.url)('node:child_process');
    cp.execFile=(...args)=>queueMicrotask(()=>args.at(-1)(Object.assign(new Error('simulated query denial'),{code:'EACCES'})));
    syncBuiltinESMExports();
    const {WorkspaceLock}=await import(${JSON.stringify(new URL('../dist/workspace.js',import.meta.url).href)});
    console.log(JSON.stringify(await new WorkspaceLock(${JSON.stringify(workspace)}).diagnose()));
  `;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',queryDenied],{timeout:5000,windowsHide:true});
  const unknown=JSON.parse(stdout);
  assert.equal(unknown.holder.state,'unknown');assert.equal(unknown.recovery.available,false);
  await second.client.close();
  assert.equal(await fs.readFile(path.join(lock,'owner.json'),'utf8'),raw);
  const created=await first.client.callTool({name:'we_project_create',arguments:{name:'still-owner',title:'Still owner'}});
  assert.equal(created.isError,undefined);
  const waiting=await connect();
  await first.client.close();
  await assert.rejects(fs.access(lock),{code:'ENOENT'});
  const absent=await diagnose(waiting.client);
  assert.equal(absent.mode,'diagnostic');assert.equal(absent.lock.state,'absent');assert.equal(absent.holder.state,'none');
  assert.equal((await waiting.client.callTool({name:'we_project_list',arguments:{}})).structuredContent.error.code,'WORKSPACE_LOCKED');
  await waiting.client.close();
  const next=await connect();
  const reopened=await diagnose(next.client);
  assert.equal(reopened.mode,'owner');assert.notEqual(reopened.lock.owner.sessionId,owned.lock.owner.sessionId);
  assert.equal((await next.client.callTool({name:'we_project_list',arguments:{}})).structuredContent.total,1);
  await next.client.close();await assert.rejects(fs.access(path.join(workspace,'server.lock')),{code:'ENOENT'});
});

test('unknown, malformed, oversized and linked lock metadata stay unknown and are preserved',async t=>{
  const {directory,workspace,lock,connect}=await fixture(t);
  await fs.mkdir(lock,{recursive:true});
  const {client}=await connect();
  const ownerFile=path.join(lock,'owner.json');
  for (const contents of ['not-json','{}','x'.repeat(8193)]) {
    await fs.writeFile(ownerFile,contents);
    const report=await diagnose(client);
    assert.equal(report.mode,'diagnostic');assert.equal(report.holder.state,'unknown');assert.equal(report.recovery.available,false);
    assert.equal(await fs.readFile(ownerFile,'utf8'),contents);
  }
  const recorded={version:1,service:'wallpaper-engine-mcp',sessionId:'11111111-1111-4111-8111-111111111111',pid:process.pid,host:os.hostname(),platform:process.platform,processStartTime:'000000000000000',workspace,createdAt:new Date().toISOString()};
  await fs.writeFile(ownerFile,JSON.stringify(recorded));
  if (process.platform==='win32') assert.equal((await diagnose(client)).holder.state,'pid-reused'); // Simulated start-identity mismatch, not actual OS PID recycling.
  for (const changes of [{host:'foreign-host.invalid'}, {processStartTime:null}, {workspace:directory}]) {
    await fs.writeFile(ownerFile,JSON.stringify({...recorded,...changes}));
    assert.equal((await diagnose(client)).holder.state,'unknown');
  }
  await fs.unlink(ownerFile);
  const outside=path.join(directory,'outside');await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'keep.txt'),'untouched');
  await fs.symlink(outside,ownerFile,process.platform==='win32'?'junction':'dir');
  assert.equal((await diagnose(client)).lock.state,'unsafe');
  await client.close();
  assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'untouched');
  assert.equal((await fs.lstat(ownerFile)).isSymbolicLink(),true);
  assert.deepEqual(await fs.readdir(workspace),['server.lock']);
});

test('ownership checks protect direct project calls and refuse to release a modified lock',async t=>{
  const {workspace,lock}=await fixture(t);
  const config={workspace,projectRoots:[],timeoutMs:1000};
  const owner=new Projects(config),outsider=new Projects(config);
  await owner.init();
  await assert.rejects(outsider.init(),{code:'WORKSPACE_LOCKED'});
  await assert.rejects(outsider.create('forbidden','Forbidden'),{code:'WORKSPACE_LOCKED'});
  await outsider.unlock();
  const record=await fs.readFile(path.join(lock,'owner.json'),'utf8');
  await fs.writeFile(path.join(lock,'owner.json'),record.replace(JSON.parse(record).sessionId,'11111111-1111-4111-8111-111111111111'));
  const changed=await fs.readFile(path.join(lock,'owner.json'),'utf8');
  await assert.rejects(owner.list(),{code:'WORKSPACE_OWNERSHIP_LOST'});
  await assert.rejects(owner.unlock(),{code:'WORKSPACE_OWNERSHIP_LOST'});
  assert.equal(await fs.readFile(path.join(lock,'owner.json'),'utf8'),changed);
});

test('a crashed owned test server is diagnosable but never automatically reclaimed',async t=>{
  const {lock,connect}=await fixture(t);
  const first=await connect();
  const original=await diagnose(first.client);
  const second=await connect();
  const raw=await fs.readFile(path.join(lock,'owner.json'),'utf8');
  process.kill(first.transport.pid,'SIGKILL'); // Only the child created by this test.
  await first.client.close();
  const after=await diagnose(second.client);
  assert.equal(after.mode,'diagnostic');assert.equal(after.lock.fingerprint,original.lock.fingerprint);
  if (process.platform==='win32') assert.equal(after.holder.state,'exited');
  assert.equal(after.recovery.available,false);
  await second.client.close();
  assert.equal(await fs.readFile(path.join(lock,'owner.json'),'utf8'),raw);
});
