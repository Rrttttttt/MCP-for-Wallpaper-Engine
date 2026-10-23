import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../dist/engine.js';
import { Projects } from '../dist/projects.js';
import { readTree } from '../dist/files.js';

test('second Web is refused before executable lookup, snapshot writes or CLI; close releases the session slot',async t=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'we-web-limit-'));
  const config={workspace,projectRoots:[],timeoutMs:1000},projects=new Projects(config);
  await projects.init();
  t.after(async()=>{await projects.unlock();await fs.rm(workspace,{recursive:true,force:true})});
  const web=await projects.create('web','Web'),scene=await projects.create('scene','Scene',{},undefined,'scene-orbit');
  const engine=new Engine(config,projects),id='11111111-1111-4111-8111-111111111111';
  // Model an existing owned session; actual CLI launch/cleanup is tested against WE separately.
  engine.previews.set(id,{previewId:id,projectId:web.projectId,windowName:'WE-MCP-'+id,files:await readTree(web.path),native:false});
  let executableCalls=0,cliCalls=0;
  engine.executable=async()=>{executableCalls++;throw Object.assign(new Error('No test engine'),{code:'ENGINE_NOT_CONFIGURED'})};
  engine.cli=async()=>{cliCalls++;return {stdout:'',stderr:''}};
  await assert.rejects(engine.open(web.projectId,640,480),e=>e.code==='WEB_PREVIEW_LIMIT'&&e.details.activePreviewIds.includes(id));
  assert.equal(executableCalls,0);assert.equal(cliCalls,0);assert.equal(engine.previews.size,1);
  await assert.rejects(fs.access(path.join(workspace,'previews')),{code:'ENOENT'});
  const upper={...web.manifest,type:'WEB'};
  await projects.apply(web.projectId,web.revision,[{path:'project.json',content:JSON.stringify(upper)}]);
  engine.previews.get(id).files.set('project.json',Buffer.from(JSON.stringify(upper)));
  await assert.rejects(engine.open(web.projectId,640,480),{code:'WEB_PREVIEW_LIMIT'});
  await assert.rejects(engine.open(scene.projectId,640,480),{code:'ENGINE_NOT_CONFIGURED'});
  engine.cli=async()=>{cliCalls++;throw new Error('Close failed')};
  await assert.rejects(engine.close(id),/Close failed/);
  await assert.rejects(engine.open(web.projectId,640,480),{code:'WEB_PREVIEW_LIMIT'});
  engine.cli=async()=>{cliCalls++;return {stdout:'',stderr:''}};
  await engine.close(id);
  await assert.rejects(engine.open(web.projectId,640,480),{code:'ENGINE_NOT_CONFIGURED'});
  assert.equal(cliCalls,2);assert.equal(engine.previews.size,0);
  engine.previews.set('scene',{files:await readTree(scene.path)});
  await assert.rejects(engine.open(web.projectId,640,480),{code:'ENGINE_NOT_CONFIGURED'});
});

test('native Video/Scene observation never attempts CEF discovery; Web observation still does',async t=>{
  let requests=0;
  t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('No CEF listener in this test')});
  const engine=new Engine({workspace:'unused',projectRoots:[],devtoolsPort:9223,timeoutMs:1000},{});
  for(const type of ['video','VIDEO','scene','web']) {
    engine.previews.set(type,{previewId:type,native:false,directory:path.resolve('unused'),files:new Map([['project.json',Buffer.from(JSON.stringify({type}))]])});
    const before=requests;
    await assert.rejects(engine.observe(type,1,250,0,false,'cef'),{code:'CEF_TARGET_UNAVAILABLE'});
    if(type==='web') assert.ok(requests>before);
    else assert.equal(requests,before,'Native '+type+' must not probe a Web debugging endpoint');
  }
});
