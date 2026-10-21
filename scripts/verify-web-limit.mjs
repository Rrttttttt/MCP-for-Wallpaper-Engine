// Real MCP regression for the fail-closed Web limit, not a claim of concurrent Web support.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/files.js';
import { endpoint } from '../dist/cdp.js';
import { nativeCall } from '../dist/native.js';
import { Engine } from '../dist/engine.js';
import { Projects } from '../dist/projects.js';

const root=fileURLToPath(new URL('../',import.meta.url)),original=await loadConfig(path.join(root,'we.config.json'));
const directory=path.join(root,'.we-mcp','web-limit-verification'),runId=randomUUID(),run=path.join(directory,'runs',runId),workspace=path.join(run,'data');
await fs.mkdir(run,{recursive:true});
const config=path.join(run,'config.json');
await fs.writeFile(config,JSON.stringify({...original,workspace,projectRoots:[path.join(root,'test','fixtures','mouse-eyes')]}));
const client=new Client({name:'web-limit-acceptance',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js'),'--config',config],stderr:'inherit'});
const active=new Map(),report={runId,startedAt:new Date().toISOString(),steps:[],checks:[],cleanupErrors:[],error:null};
async function call(name,args={},error) {
  const response=await client.callTool({name,arguments:args},undefined,{timeout:60000}),result=response.structuredContent;
  assert.ok(response.content.every(c=>c.type==='text'));
  report.steps.push({tool:name,result});
  const p=result.error?.details??result;
  if(p.previewId&&p.windowName) active.set(p.previewId,p);
  if(error){assert.equal(response.isError,true);assert.equal(result.error?.code,error);}
  else if(response.isError)throw new Error(JSON.stringify(result));
  console.log(name+': '+(result.state??result.confirmation??result.error?.code??'ok'));return result;
}
async function close(p){assert.equal((await call('we_preview_close',{previewId:p.previewId})).state,'window-absent');active.delete(p.previewId);}
async function gaze(p,x){
  const moved=await call('we_preview_move_mouse',{previewId:p.previewId,x,y:0.5});
  const observed=await call('we_preview_observe',{previewId:p.previewId,count:1,backend:'cef'});
  assert.equal(observed.complete,true);assert.deepEqual(observed.issues,[]);
  const d=observed.evidence.diagnostics;assert.equal(d.ready,true);assert.deepEqual(d.errors,[]);
  assert.ok(Math.abs(d.input.x-moved.position.x)<=1&&Math.abs(d.input.y-moved.position.y)<=1);
  assert.equal(d.input.trusted,true);
}
try {
  await client.connect(transport);
  const probe=await call('we_environment_probe');
  assert.equal(probe.capabilities.nativeWindowCapture.status,'available');
  assert.equal(probe.capabilities.webPreviewConcurrency.maxActivePerSession,1);
  const web=await call('we_project_create',{name:'eyes',title:'Web capacity acceptance',sourceProjectId:'root0'});
  const scene=await call('we_project_create',{name:'scene',title:'Mixed preview control',templateId:'scene-orbit',properties:{speed:0,amplitude:0}});
  const first=await call('we_preview_open',{projectId:web.projectId,width:640,height:480});assert.equal(first.state,'page-ready');
  const mixed=await call('we_preview_open',{projectId:scene.projectId,width:640,height:480});assert.ok(mixed.windowIdentity);
  const snapshots=await fs.readdir(path.join(workspace,'previews'));
  const targets=(await endpoint(original.devtoolsPort,'/json/list')).map(t=>t.url).sort();
  const denied=await call('we_preview_open',{projectId:web.projectId,width:960,height:540},'WEB_PREVIEW_LIMIT');
  assert.deepEqual(denied.error.details.activePreviewIds,[first.previewId]);
  assert.equal(denied.error.details.scope,'server-session');
  assert.deepEqual(await fs.readdir(path.join(workspace,'previews')),snapshots);
  assert.deepEqual((await endpoint(original.devtoolsPort,'/json/list')).map(t=>t.url).sort(),targets);
  assert.equal(JSON.parse(await fs.readFile(path.join(workspace,'active-previews.json'))).length,2);
  await gaze(first,0.25);
  report.checks.push({name:'second-web-refused-without-new-snapshot-or-browser-target',passed:true});
  await close(first);
  const reopened=await call('we_preview_open',{projectId:web.projectId,width:960,height:540});assert.equal(reopened.state,'page-ready');
  await gaze(reopened,0.75);
  report.checks.push({name:'closing-web-releases-slot-while-scene-remains-open',passed:true});
  await close(reopened);await close(mixed);
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e);}
finally {
  for(const p of [...active.values()]){try{await close(p);}catch(e){report.cleanupErrors.push(e.message)}}
  try{await client.close();}catch(e){report.cleanupErrors.push(e.message)}
  try {
    const entries=JSON.parse(await fs.readFile(path.join(workspace,'active-previews.json')));
    for(const p of entries){
      assert.equal(path.dirname(p.directory),path.join(workspace,'previews'));assert.ok(p.windowIdentity);
      const request={windowName:p.windowName,installDir:original.installDir,expected:p.windowIdentity};
      try{await nativeCall('absent',request,300);continue;}catch{/* reverify before closing */}
      await nativeCall('verify',request);
      await new Engine(original,new Projects(original)).cli(['-control','closeWallpaper','-location',p.windowName]);
      await nativeCall('absent',request);
    }
    assert.deepEqual(entries,[]);await assert.rejects(fs.access(path.join(workspace,'server.lock')),{code:'ENOENT'});
  }catch(e){report.cleanupErrors.push(e.message)}
  if(report.cleanupErrors.length){report.error??=report.cleanupErrors.join('; ');process.exitCode=1;}
  report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Report: '+path.join(directory,'report.json'));
}
