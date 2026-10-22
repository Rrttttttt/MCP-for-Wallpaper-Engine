import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { once, on } from 'node:events';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Projects } from '../dist/projects.js';
import { readTree, revision } from '../dist/files.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'we-mcp-lock-'));
  const workspace = path.join(directory,'data'), config = path.join(directory,'config.json');
  await fs.writeFile(config,JSON.stringify({workspace}));
  const clients=[];
  t.after(async()=>{
    for (const client of clients.reverse()) await client.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'we-mcp-lock-'));
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {directory,workspace,config,lock:path.join(workspace,'server.lock'),connect:(env,preload)=>connect(config,clients,env,preload)};
}
async function connect(config,clients,env,preload) {
  const args=preload?['--import',new URL('./fixtures/recovery-interrupt.mjs',import.meta.url).href]:[];
  const transport = new StdioClientTransport({command:process.execPath,args:[...args,fileURLToPath(new URL('../dist/index.js',import.meta.url)),'--config',config],stderr:'pipe',env});
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
  assert.equal(tools.length,15);
  assert.equal(tools.find(tool=>tool.name==='we_workspace_diagnose').annotations.readOnlyHint,true);
  const report=await diagnose(client);
  assert.equal(report.mode,'diagnostic');
  assert.equal(report.startupIssue.code,'WORKSPACE_LOCKED');
  assert.equal(report.lock.state,'present');
  assert.equal(report.lock.owner,null);
  assert.equal(report.holder.state,'unknown');
  assert.equal(report.recovery.available,false);
  assert.match(report.lock.fingerprint,/^[a-f0-9]{64}$/);
  const refused=await client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:report.lock.fingerprint,confirm:true}});
  assert.equal(refused.structuredContent.error.code,'WORKSPACE_RECOVERY_REFUSED');
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
  assert.deepEqual(new Set(blockedTools.map(([name])=>name)),new Set(tools.filter(tool=>!['we_workspace_diagnose','we_workspace_recover'].includes(tool.name)).map(tool=>tool.name)));
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
  const refused=await second.client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:blocked.lock.fingerprint,confirm:true}});
  assert.equal(refused.structuredContent.error.code,'WORKSPACE_RECOVERY_REFUSED');
  await assert.rejects(fs.access(path.join(workspace,'lock-recoveries')),{code:'ENOENT'});
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
  assert.equal(after.recovery.available,process.platform==='win32');
  await second.client.close();
  assert.equal(await fs.readFile(path.join(lock,'owner.json'),'utf8'),raw);
});

test('explicit MCP recovery archives a crashed owner and grants one new owner', {skip:process.platform!=='win32'},async t=>{
  const {workspace,lock,connect}=await fixture(t);
  const first=await connect();
  const original=await diagnose(first.client);
  const created=await first.client.callTool({name:'we_project_create',arguments:{name:'saved-source',title:'Saved source'}});
  assert.equal(created.isError,undefined);
  const previousRegistry=Buffer.from('[{"previewId":"historical-evidence-only"}]');
  await fs.writeFile(path.join(workspace,'active-previews.json'),previousRegistry);
  const before=await fs.readFile(path.join(lock,'owner.json'));
  const next=await connect();
  process.kill(first.transport.pid,'SIGKILL');await first.client.close();
  const evidence=await diagnose(next.client);
  assert.equal(evidence.holder.state,'exited');
  assert.equal(evidence.recovery.available,true);
  const noConfirmation=await next.client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:original.lock.fingerprint,confirm:false}});
  assert.equal(noConfirmation.isError,true);
  const changed=await next.client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:'0'.repeat(64),confirm:true}});
  assert.equal(changed.structuredContent.error.code,'WORKSPACE_LOCK_CHANGED');
  await assert.rejects(fs.access(path.join(workspace,'lock-recoveries')),{code:'ENOENT'});
  const guard=await holdCoordination(t,workspace);
  try {
    const busy=await next.client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:original.lock.fingerprint,confirm:true}});
    assert.equal(busy.structuredContent.error.code,'WORKSPACE_COORDINATION_BUSY');
    assert.deepEqual(await fs.readFile(path.join(lock,'owner.json')),before);
  } finally { await guard.stop(); }
  const recovered=await next.client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:original.lock.fingerprint,confirm:true}});
  assert.equal(recovered.isError,undefined);
  assert.equal(recovered.structuredContent.state,'recovered');
  assert.equal((await diagnose(next.client)).mode,'owner');
  const archive=recovered.structuredContent.archive;
  assert.deepEqual(await fs.readFile(path.join(archive,'server.lock','owner.json')),before);
  assert.deepEqual(await fs.readFile(path.join(archive,'active-previews.json')),previousRegistry);
  assert.deepEqual(await fs.readFile(path.join(workspace,'active-previews.json')),previousRegistry);
  assert.equal(JSON.parse(await fs.readFile(path.join(archive,'record.json'))).state,'acquired');
  const inspected=await next.client.callTool({name:'we_project_inspect',arguments:{projectId:created.structuredContent.projectId}});
  assert.equal(inspected.structuredContent.revision,created.structuredContent.revision);
  assert.equal((await diagnose(next.client)).startupIssue,null);
  await next.client.close();await assert.rejects(fs.access(lock),{code:'ENOENT'});
});

async function holdCoordination(t,workspace) {
  const script=`
    const {WorkspaceLock}=await import(${JSON.stringify(new URL('../dist/workspace.js',import.meta.url).href)});
    await new WorkspaceLock(process.argv[1]).coordinate(async()=>{
      process.send({holding:true});
      process.stdin.resume();await new Promise(resolve=>process.stdin.once('end',resolve));
    });
    process.disconnect();
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',script,workspace],{stdio:['pipe','ignore','inherit','ipc'],windowsHide:true});
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit=once(child,'exit');child.kill('SIGKILL');await exit;
  }
  t.after(stop);
  assert.deepEqual((await once(child,'message',{signal:AbortSignal.timeout(5000)}))[0],{holding:true});
  return {stop};
}

test('acquisition and release share the cross-process guard, which dies with its owner',{skip:process.platform!=='win32'},async t=>{
  const {workspace,lock}=await fixture(t);
  const config={workspace,projectRoots:[],timeoutMs:1000};
  const owner=new Projects(config);await owner.init();
  const before=await fs.readFile(path.join(lock,'owner.json'));
  const guard=await holdCoordination(t,workspace);
  try {
    await assert.rejects(new Projects(config).init(),{code:'WORKSPACE_COORDINATION_BUSY'});
    await assert.rejects(owner.unlock(),{code:'WORKSPACE_COORDINATION_BUSY'});
    assert.deepEqual(await fs.readFile(path.join(lock,'owner.json')),before);
  } finally { await guard.stop(); }
  await owner.unlock();await assert.rejects(fs.access(lock),{code:'ENOENT'});
});

test('two real MCP recovery requests for one fingerprint grant exactly one owner',{skip:process.platform!=='win32'},async t=>{
  const {workspace,lock,connect}=await fixture(t);
  const first=await connect(),second=await connect(),third=await connect();
  const old=await diagnose(first.client);
  process.kill(first.transport.pid,'SIGKILL');await first.client.close();
  const request=client=>client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:old.lock.fingerprint,confirm:true}});
  const results=await Promise.all([request(second.client),request(third.client)]);
  assert.equal(results.filter(result=>!result.isError).length,1);
  const refused=results.find(result=>result.isError);
  assert.ok(['WORKSPACE_COORDINATION_BUSY','WORKSPACE_LOCK_CHANGED'].includes(refused.structuredContent.error.code));
  const reports=await Promise.all([diagnose(second.client),diagnose(third.client)]);
  assert.equal(reports.filter(report=>report.mode==='owner').length,1);
  assert.equal((await fs.readdir(path.join(workspace,'lock-recoveries'))).length,1);
  const winner=results[0].isError ? third : second,loser=results[0].isError ? second : third;
  await loser.client.close();
  assert.equal(JSON.parse(await fs.readFile(path.join(lock,'owner.json'))).pid,winner.transport.pid);
  const contender=await connect();assert.equal((await diagnose(contender.client)).mode,'diagnostic');
  await contender.client.close();await winner.client.close();
  await assert.rejects(fs.access(lock),{code:'ENOENT'});
});

test('a known exited v1 owner is still refused because it did not use the recovery protocol',{skip:process.platform!=='win32'},async t=>{
  const {workspace,lock,connect}=await fixture(t);
  const first=await connect();
  process.kill(first.transport.pid,'SIGKILL');await first.client.close();
  const file=path.join(lock,'owner.json'),record=JSON.parse(await fs.readFile(file));
  record.version=1;delete record.coordination;
  const raw=JSON.stringify(record);await fs.writeFile(file,raw);
  const next=await connect(),diagnostic=await diagnose(next.client);
  assert.equal(diagnostic.holder.state,'exited');assert.equal(diagnostic.recovery.reason,'LEGACY_LOCK_PROTOCOL');
  const result=await next.client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:diagnostic.lock.fingerprint,confirm:true}});
  assert.equal(result.structuredContent.error.code,'WORKSPACE_RECOVERY_REFUSED');
  await next.client.close();assert.equal(await fs.readFile(file,'utf8'),raw);
  await assert.rejects(fs.access(path.join(workspace,'lock-recoveries')),{code:'ENOENT'});
});

test('archive setup failure preserves the original lock and keeps the caller diagnostic',{skip:process.platform!=='win32'},async t=>{
  const {workspace,lock,connect}=await fixture(t);
  const first=await connect(),next=await connect();
  const old=await diagnose(first.client),raw=await fs.readFile(path.join(lock,'owner.json'));
  process.kill(first.transport.pid,'SIGKILL');await first.client.close();
  await fs.writeFile(path.join(workspace,'lock-recoveries'),'preserve this unrelated file');
  const result=await next.client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:old.lock.fingerprint,confirm:true}});
  assert.equal(result.structuredContent.error.code,'WORKSPACE_RECOVERY_INCOMPLETE');
  assert.equal(result.structuredContent.error.details.phase,'preparing');
  assert.equal(result.structuredContent.error.details.mode,'diagnostic');
  assert.equal((await diagnose(next.client)).mode,'diagnostic');
  assert.deepEqual(await fs.readFile(path.join(lock,'owner.json')),raw);
  assert.equal(await fs.readFile(path.join(workspace,'lock-recoveries'),'utf8'),'preserve this unrelated file');
});

test('unsupported pipe settings are visible through MCP before any lock is created',{skip:process.platform!=='win32'},async t=>{
  const {workspace,lock,connect}=await fixture(t);
  const {client}=await connect({...process.env,NODE_PENDING_PIPE_INSTANCES:'1'});
  const report=await diagnose(client);
  assert.equal(report.mode,'diagnostic');assert.equal(report.lock.state,'absent');
  assert.equal(report.startupIssue.code,'WORKSPACE_COORDINATION_UNAVAILABLE');
  assert.equal((await client.callTool({name:'we_project_list',arguments:{}})).structuredContent.error.code,'WORKSPACE_LOCKED');
  await client.close();await assert.rejects(fs.access(lock),{code:'ENOENT'});
  assert.deepEqual(await fs.readdir(workspace),[]);
});

async function recoveryFixture(t,point,action='kill') {
  const f=await fixture(t),first=await f.connect();
  const source=await first.client.callTool({name:'we_project_create',arguments:{name:'crash-source',title:'Recovery crash source'}});
  assert.equal(source.isError,undefined);
  const projectId=source.structuredContent.projectId;
  const edit=await first.client.callTool({name:'we_project_apply',arguments:{projectId,expectedRevision:source.structuredContent.revision,changes:[{path:'note.txt',content:'Keep this source and checkpoint'}]}});
  assert.equal(edit.isError,undefined);assert.ok(edit.structuredContent.checkpointId);
  const registry=Buffer.from('[{"previewId":"11111111-1111-4111-8111-111111111111","windowName":"historical-evidence-only"}]');
  await fs.writeFile(path.join(f.workspace,'active-previews.json'),registry);
  const owner=await fs.readFile(path.join(f.lock,'owner.json'));
  const baseline={};
  for(const name of ['projects','checkpoints','origins']) baseline[name]=revision(await readTree(path.join(f.workspace,name)));
  const config=await fs.readFile(f.config);
  process.kill(first.transport.pid,'SIGKILL');await first.client.close();
  const recovering=await f.connect({...process.env,WE_TEST_RECOVERY_WORKSPACE:f.workspace,WE_TEST_RECOVERY_POINT:point,WE_TEST_RECOVERY_ACTION:action},true);
  const evidence=await diagnose(recovering.client);
  assert.equal(evidence.holder.state,'exited');assert.equal(evidence.recovery.available,true);
  async function unchanged() {
    for(const [name,hash] of Object.entries(baseline)) assert.equal(revision(await readTree(path.join(f.workspace,name))),hash,name);
    assert.deepEqual(await fs.readFile(f.config),config);
    assert.deepEqual(await fs.readFile(path.join(f.workspace,'active-previews.json')),registry);
  }
  return {...f,recovering,evidence,owner,registry,projectId,revision:edit.structuredContent.revision,unchanged,
    recover:()=>recovering.client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:evidence.lock.fingerprint,confirm:true}})};
}
async function reachedCheckpoint(transport,point) {
  let text='';
  for await(const [chunk] of on(transport.stderr,'data',{signal:AbortSignal.timeout(15000)})) {
    text+=String(chunk);
    if(text.includes('WE_TEST_RECOVERY_POINT:'+point+'\n')) return;
  }
  throw new Error('Recovery process ended before checkpoint '+point);
}

const crashCases=[
  {point:'prepared-temporary',audit:null,current:'old',copied:false,moved:false},
  {point:'audit-prepared',audit:'prepared',current:'old',copied:false,moved:false},
  {point:'registry-copied',audit:'prepared',current:'old',copied:true,moved:false},
  {point:'lock-renamed',audit:'prepared',current:'absent',copied:true,moved:true},
  {point:'audit-archived',audit:'archived',current:'absent',copied:true,moved:true},
  {point:'new-lock-directory',audit:'archived',current:'empty',copied:true,moved:true},
  {point:'partial-owner',audit:'archived',current:'partial',copied:true,moved:true},
  {point:'owner-written',audit:'archived',current:'new',copied:true,moved:true},
  {point:'acquired-temporary',audit:'archived',current:'new',copied:true,moved:true},
  {point:'audit-acquired',audit:'acquired',current:'new',copied:true,moved:true}
];

test('recovery process kills at ten filesystem boundaries preserve evidence and never grant an unowned session writes',{skip:process.platform!=='win32'},async t=>{
  for(const scenario of crashCases) await t.test(scenario.point,async t=>{
    const f=await recoveryFixture(t,scenario.point);
    const checkpoint=reachedCheckpoint(f.recovering.transport,scenario.point);
    const outcome=f.recover().then(result=>({result}),error=>({error}));
    await checkpoint;
    // Even the gaps without a directory lock remain protected while the recoverer lives.
    await assert.rejects(new Projects({workspace:f.workspace,projectRoots:[],timeoutMs:1000}).init(),{code:'WORKSPACE_COORDINATION_BUSY'});
    const recoveringPid=f.recovering.transport.pid;
    process.kill(recoveringPid,'SIGKILL');await f.recovering.client.close();
    assert.ok((await outcome).error,'A killed recovery cannot return a successful MCP response');
    const recoveries=path.join(f.workspace,'lock-recoveries');
    const entries=await fs.readdir(recoveries);assert.equal(entries.length,1);
    const archive=path.join(recoveries,entries[0]),saved=await readTree(archive);
    if(scenario.audit) assert.equal(JSON.parse(saved.get('record.json')).state,scenario.audit);
    else assert.equal(saved.has('record.json'),false);
    if(scenario.point.endsWith('-temporary')) {
      const temporaries=[...saved.keys()].filter(name=>/^record\.json\.[a-f0-9-]+\.tmp$/.test(name));
      assert.equal(temporaries.length,1);
      assert.equal(JSON.parse(saved.get(temporaries[0])).state,scenario.point.split('-')[0]);
    }
    if(scenario.copied) assert.deepEqual(saved.get('active-previews.json'),f.registry);
    else assert.equal(saved.has('active-previews.json'),false);
    if(scenario.moved) assert.deepEqual(saved.get('server.lock/owner.json'),f.owner);
    else assert.deepEqual(await fs.readFile(path.join(f.lock,'owner.json')),f.owner);
    if(scenario.current==='absent') await assert.rejects(fs.access(f.lock),{code:'ENOENT'});
    if(scenario.current==='empty') assert.deepEqual(await fs.readdir(f.lock),[]);
    if(scenario.current==='partial') {
      const partial=await fs.readFile(path.join(f.lock,'owner.json'));
      assert.equal(partial.length,12);assert.throws(()=>JSON.parse(partial.toString()));
    }
    if(scenario.current==='new') assert.equal(JSON.parse(await fs.readFile(path.join(f.lock,'owner.json'))).pid,recoveringPid);
    const observer=await f.connect(),diagnostic=await diagnose(observer.client);
    if(['empty','partial'].includes(scenario.current)) {
      assert.equal(diagnostic.mode,'diagnostic');assert.equal(diagnostic.holder.state,'unknown');
      assert.equal(diagnostic.recovery.available,false);
      const refused=await observer.client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:diagnostic.lock.fingerprint,confirm:true}});
      assert.equal(refused.structuredContent.error.code,'WORKSPACE_RECOVERY_REFUSED');
      assert.equal((await observer.client.callTool({name:'we_project_create',arguments:{name:'blocked',title:'Blocked'}})).structuredContent.error.code,'WORKSPACE_LOCKED');
      await observer.client.close();
      const after=await f.connect();assert.equal((await diagnose(after.client)).lock.fingerprint,diagnostic.lock.fingerprint);
      await after.client.close();
      assert.deepEqual(await fs.readdir(recoveries),entries,'Unknown locks cannot create another recovery archive');
    } else {
      if(scenario.current==='absent') {
        assert.equal(diagnostic.mode,'owner');
        const stale=await observer.client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:f.evidence.lock.fingerprint,confirm:true}});
        assert.equal(stale.structuredContent.error.code,'WORKSPACE_LOCK_CHANGED');
      } else {
        assert.equal(diagnostic.mode,'diagnostic');assert.equal(diagnostic.holder.state,'exited');assert.equal(diagnostic.recovery.available,true);
        assert.equal((await observer.client.callTool({name:'we_project_list',arguments:{}})).structuredContent.error.code,'WORKSPACE_LOCKED');
        const recovered=await observer.client.callTool({name:'we_workspace_recover',arguments:{expectedFingerprint:diagnostic.lock.fingerprint,confirm:true}});
        assert.equal(recovered.isError,undefined);assert.equal(recovered.structuredContent.previewOwnership,'not-adopted');
      }
      const inspected=await observer.client.callTool({name:'we_project_inspect',arguments:{projectId:f.projectId}});
      assert.equal(inspected.structuredContent.revision,f.revision);
      const notAdopted=await observer.client.callTool({name:'we_preview_close',arguments:{previewId:'11111111-1111-4111-8111-111111111111'}});
      assert.equal(notAdopted.structuredContent.error.code,'PREVIEW_NOT_FOUND');
      await observer.client.close();await assert.rejects(fs.access(f.lock),{code:'ENOENT'});
    }
    assert.deepEqual(await readTree(archive),saved,'Further diagnosis/recovery must preserve the interrupted archive');
    await f.unchanged();
  });
});

test('returned audit failures expose the actual phase and ownership without overwriting previous evidence',{skip:process.platform!=='win32'},async t=>{
  for(const [point,phase,mode,state] of [['audit-archived','archived','diagnostic','prepared'],['audit-acquired','acquired','owner','archived']]) await t.test(point,async t=>{
    const f=await recoveryFixture(t,point,'throw'),result=await f.recover();
    assert.equal(result.structuredContent.error.code,'WORKSPACE_RECOVERY_INCOMPLETE');
    assert.deepEqual({...result.structuredContent.error.details,recoveryId:undefined,archive:undefined},{recoveryId:undefined,archive:undefined,phase,mode,cause:'EIO'});
    const archive=result.structuredContent.error.details.archive;
    assert.equal(JSON.parse(await fs.readFile(path.join(archive,'record.json'))).state,state);
    assert.deepEqual(await fs.readFile(path.join(archive,'server.lock','owner.json')),f.owner);
    const diagnostic=await diagnose(f.recovering.client);assert.equal(diagnostic.mode,mode);
    const listed=await f.recovering.client.callTool({name:'we_project_list',arguments:{}});
    if(mode==='owner') assert.equal(listed.structuredContent.total,1);
    else assert.equal(listed.structuredContent.error.code,'WORKSPACE_LOCKED');
    await f.recovering.client.close();await assert.rejects(fs.access(f.lock),{code:'ENOENT'});
    const next=await f.connect();assert.equal((await diagnose(next.client)).mode,'owner');await next.client.close();
    await f.unchanged();
  });
});
