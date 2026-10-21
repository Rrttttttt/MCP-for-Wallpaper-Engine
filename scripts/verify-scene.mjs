// Explicit real-engine acceptance for the bundled Scene template, using a text-only MCP client.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { loadConfig, hash } from '../dist/files.js';
import { pngInfo, nativeCall } from '../dist/native.js';
import { Engine } from '../dist/engine.js';
import { Projects } from '../dist/projects.js';
const root = fileURLToPath(new URL('../',import.meta.url));
const original = await loadConfig(path.join(root,'we.config.json'));
const directory = path.join(root,'.we-mcp','scene-verification');
await fs.mkdir(directory,{recursive:true});
const config = path.join(directory,'config.json');
await fs.writeFile(config,JSON.stringify({...original,workspace:path.join(directory,'data'),projectRoots:[],devtoolsPort:null,timeoutMs:8000}));
let client,transport,connected=false;
const report = {startedAt:new Date().toISOString(),steps:[],measurements:{},checks:[],sessions:[],cleanupErrors:[],error:null};
const active = new Map();
async function connect() {
  client = new Client({name:'scene-template-verification',version:'1'});
  transport = new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js'),'--config',config],stderr:'inherit'});
  await client.connect(transport); connected=true;
  report.sessions.push({pid:transport.pid,connectedAt:new Date().toISOString()});
}
async function call(name,args={},expectedError) {
  const response = await client.callTool({name,arguments:args},undefined,{timeout:60000});
  assert.ok(response.content.every(c=>c.type==='text'),'Unexpected image payload for a text-only client.');
  const result = response.structuredContent;
  report.steps.push({tool:name,result});
  if(expectedError) {
    assert.equal(response.isError,true,`${name} should reject this request.`);
    assert.equal(result.error?.code,expectedError);
  } else if(response.isError) throw new Error(JSON.stringify(result));
  if(result.previewId&&result.windowIdentity) active.set(result.previewId,result);
  console.log(name+': '+(result.state??result.revision??result.error?.code??'ok'));
  return result;
}
async function close(previewId) {
  const closed=await call('we_preview_close',{previewId});
  assert.equal(closed.state,'window-absent'); active.delete(previewId);
}
async function verifySnapshot(preview,source,label) {
  // Check original source files; the renderer may add shader caches to its private copy.
  for(const file of source.files) assert.equal(hash(await fs.readFile(path.join(preview.directory,file.name))),file.sha256,`${label}: ${file.name}`);
  report.checks.push({name:label,revision:source.revision,verifiedSourceFiles:source.files.length,passed:true});
}
async function workspaceReleased() {
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'data','active-previews.json'))),[]);
  await assert.rejects(fs.access(path.join(directory,'data','server.lock')),{code:'ENOENT'});
}

// Only decodes the bounded 8-bit RGB/RGBA PNG format used by this integration.
// Measuring cyan pixels excludes title-bar changes from animation evidence.
async function marker(file) {
  const png=await fs.readFile(file),{width,height}=pngInfo(png);
  assert.equal(png[24],8); assert.ok([2,6].includes(png[25])); assert.equal(png[28],0);
  const channels=png[25]===6?4:3, stride=width*channels, compressed=[];
  for(let offset=8;offset+12<=png.length;) {
    const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8);
    assert.ok(offset+12+length<=png.length);
    if(type==='IDAT') compressed.push(png.subarray(offset+8,offset+8+length));
    offset+=12+length;
  }
  const raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:(stride+1)*height});
  assert.equal(raw.length,(stride+1)*height);
  let previous=Buffer.alloc(stride),count=0,sumX=0,sumY=0;
  for(let y=0;y<height;y++) {
    const filter=raw[y*(stride+1)],row=Buffer.from(raw.subarray(y*(stride+1)+1,(y+1)*(stride+1)));
    assert.ok(filter<=4);
    for(let i=0;i<stride;i++) {
      const left=i>=channels?row[i-channels]:0,up=previous[i],corner=i>=channels?previous[i-channels]:0;
      const estimate=left+up-corner,a=Math.abs(estimate-left),b=Math.abs(estimate-up),c=Math.abs(estimate-corner);
      const predictor=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):a<=b&&a<=c?left:b<=c?up:corner;
      row[i]=(row[i]+predictor)&255;
    }
    for(let x=0;x<width;x++) {
      const i=x*channels;
      if(row[i]<80&&row[i+1]>140&&row[i+2]>140) {count++;sumX+=x;sumY+=y;}
    }
    previous=row;
  }
  assert.ok(count>5000,'Expected cyan image layer is missing or blank.');
  return {file,width,height,pixels:count,x:sumX/count,y:sumY/count};
}
async function observe(id,label,count=3,reload=false) {
  const result=await call('we_preview_observe',{previewId:id,count,intervalMs:250,backend:'native',reload});
  assert.equal(result.complete,true,JSON.stringify(result.issues));
  const positions=await Promise.all(result.images.map(marker));
  report.measurements[label]=positions;
  return positions;
}
const travel=frames=>Math.max(...frames.map(f=>f.x))-Math.min(...frames.map(f=>f.x));
const verticalTravel=frames=>Math.max(...frames.map(f=>f.y))-Math.min(...frames.map(f=>f.y));
function horizontal(frames) {
  assert.ok(travel(frames)>30,'Expected horizontal SceneScript motion.');
  assert.ok(verticalTravel(frames)<1,'Original scene unexpectedly moved vertically.');
}
function vertical(frames) {
  assert.ok(travel(frames)<1,'Edited scene did not use its zero-amplitude source default.');
  assert.ok(verticalTravel(frames)>30,'Edited SceneScript did not produce vertical motion.');
  assert.ok(frames.every(f=>Math.abs(f.x-f.width/4)<5),'Edited scene did not load the new origin.');
}
try {
  await connect();
  const created=await call('we_project_create',{name:'orbit-'+randomUUID().slice(0,8),title:'Scene template acceptance',templateId:'scene-orbit',properties:{amplitude:160}});
  assert.equal(created.manifest.type,'scene'); assert.equal(created.validation.valid,true);
  assert.ok(created.validation.sceneDependencies.every(d=>d.status==='local'));
  const opened=await call('we_preview_open',{projectId:created.projectId,width:960,height:540});
  assert.ok(opened.windowIdentity);
  const moving=await observe(opened.previewId,'configuredSourceMotion');
  assert.ok(travel(moving)>30,'SceneScript motion was not visible.');
  // This fixture renders 1280 scene pixels into a 960-pixel client: 160 scene pixels ≈ 120 screen pixels.
  assert.ok(moving.every(f=>Math.abs(f.x-f.width/2)<125),'Configured source amplitude was not loaded.');
  await call('we_preview_set_properties',{previewId:opened.previewId,properties:{amplitude:0}});
  const still=await observe(opened.previewId,'zeroAmplitude');
  assert.ok(travel(still.slice(-2))<1,'Host amplitude parameter did not stop movement.');
  assert.ok(Math.abs(still.at(-1).x-still.at(-1).width/2)<5,'Zero-amplitude marker is not at scene center.');
  await call('we_preview_set_properties',{previewId:opened.previewId,properties:{amplitude:240}});
  assert.ok(travel(await observe(opened.previewId,'resumedMotion'))>30,'Sparse property update did not restore motion.');
  await call('we_preview_set_properties',{previewId:opened.previewId,properties:{speed:0}});
  assert.ok(travel((await observe(opened.previewId,'zeroSpeed')).slice(-2))<1,'Host speed parameter did not freeze motion.');
  const baseline=await call('we_project_inspect',{projectId:created.projectId,readFiles:['project.json','scene.json']});
  const manifest=JSON.parse(baseline.contents['project.json']),scene=JSON.parse(baseline.contents['scene.json']);
  manifest.general.properties.amplitude.value=0;
  scene.objects[0].origin.value='320 360 0';
  const script=scene.objects[0].origin.script;
  assert.ok(script.includes('value.y = base.y;'),'Scene fixture script changed; update this acceptance case explicitly.');
  scene.objects[0].origin.script=script.replace('value.y = base.y;','value.y = base.y + Math.sin(phase) * 120;');
  const edited=await call('we_project_apply',{projectId:created.projectId,expectedRevision:baseline.revision,changes:[
    {path:'project.json',content:JSON.stringify(manifest,null,2)+'\n'},
    {path:'scene.json',content:JSON.stringify(scene,null,2)+'\n'}
  ]});
  assert.ok(edited.checkpointId); assert.notEqual(edited.revision,baseline.revision);
  const editedSource=await call('we_project_inspect',{projectId:created.projectId});
  assert.equal(editedSource.revision,edited.revision);
  await call('we_project_apply',{projectId:created.projectId,expectedRevision:baseline.revision,changes:[{path:'stale.txt',content:'must not be written'}]},'REVISION_CONFLICT');
  // Reload must retain the existing snapshot, even though the managed source is now different.
  horizontal(await observe(opened.previewId,'oldSnapshotReloadAfterEdit',3,true));
  assert.equal(active.get(opened.previewId).revision,baseline.revision);
  await verifySnapshot(active.get(opened.previewId),baseline,'old-preview-source-remains-original');
  const changedPreview=await call('we_preview_open',{projectId:created.projectId,width:960,height:540});
  assert.equal(changedPreview.revision,edited.revision);
  vertical(await observe(changedPreview.previewId,'editedVerticalMotion'));
  await verifySnapshot(active.get(changedPreview.previewId),editedSource,'new-preview-loads-edited-source');
  await call('we_project_restore',{projectId:created.projectId,checkpointId:edited.checkpointId,expectedRevision:baseline.revision},'REVISION_CONFLICT');
  const restored=await call('we_project_restore',{projectId:created.projectId,checkpointId:edited.checkpointId,expectedRevision:edited.revision});
  assert.equal(restored.revision,baseline.revision); assert.ok(restored.checkpointId);
  assert.deepEqual((await call('we_project_inspect',{projectId:created.projectId})).files,baseline.files);
  // A source rollback must likewise not rewrite a running edited snapshot.
  vertical(await observe(changedPreview.previewId,'editedSnapshotReloadAfterRestore',3,true));
  assert.equal(active.get(changedPreview.previewId).revision,edited.revision);
  await verifySnapshot(active.get(changedPreview.previewId),editedSource,'edited-preview-survives-source-rollback');
  await close(opened.previewId);
  const reopened=await call('we_preview_open',{projectId:created.projectId,width:960,height:540});
  assert.equal(reopened.revision,baseline.revision);
  horizontal(await observe(reopened.previewId,'restoredHorizontalMotion'));
  await verifySnapshot(active.get(reopened.previewId),baseline,'reopened-preview-loads-restored-source');

  // Keep both source versions open: EOF shutdown must close both and release the workspace.
  const shutdownWindows=[...active.values()];
  assert.equal(shutdownWindows.length,2);
  await client.close(); connected=false;
  for(const window of shutdownWindows) await nativeCall('absent',{windowName:window.windowName,installDir:original.installDir,expected:window.windowIdentity},8000);
  await workspaceReleased(); active.clear();
  report.checks.push({name:'stdio-shutdown-closes-owned-windows-and-releases-lock',windows:shutdownWindows.length,passed:true});
  await connect();
  const persisted=await call('we_project_inspect',{projectId:created.projectId});
  assert.equal(persisted.revision,baseline.revision); assert.deepEqual(persisted.files,baseline.files);
  await call('we_preview_close',{previewId:reopened.previewId},'PREVIEW_NOT_FOUND');
  const redone=await call('we_project_restore',{projectId:created.projectId,checkpointId:restored.checkpointId,expectedRevision:persisted.revision});
  assert.equal(redone.revision,edited.revision);
  assert.deepEqual((await call('we_project_inspect',{projectId:created.projectId})).files,editedSource.files);
  const finalRestore=await call('we_project_restore',{projectId:created.projectId,checkpointId:edited.checkpointId,expectedRevision:redone.revision});
  assert.equal(finalRestore.revision,baseline.revision);
  const finalPreview=await call('we_preview_open',{projectId:created.projectId,width:960,height:540});
  horizontal(await observe(finalPreview.previewId,'afterServerRestartAndCheckpointRestore'));
  assert.equal(active.get(finalPreview.previewId).revision,baseline.revision);
  await verifySnapshot(active.get(finalPreview.previewId),baseline,'restored-source-after-server-restart');
  await close(finalPreview.previewId);
  await call('we_preview_observe',{previewId:finalPreview.previewId},'PREVIEW_NOT_FOUND');
  report.checks.push({name:'checkpoints-and-sources-persist-across-server-restart',passed:true});
} catch(e) {report.error=e.stack;process.exitCode=1;console.error(e);}
finally {
  for(const previewId of active.keys()) if(connected) {try{await close(previewId);}catch(e){report.cleanupErrors.push(e.message);}}
  try {await client?.close(); connected=false;} catch(e) {report.cleanupErrors.push(e.message);}
  // Cleanup fallback for a failed shutdown test: only previously tracked, reverified owned windows.
  for(const preview of active.values()) {
    const request={windowName:preview.windowName,installDir:original.installDir,expected:preview.windowIdentity};
    try {
      try {await nativeCall('absent',request,300);continue;} catch { /* still present; reverify before closing */ }
      await nativeCall('verify',request);
      await new Engine(original,new Projects(original)).cli(['-control','closeWallpaper','-location',preview.windowName]);
      await nativeCall('absent',request);
    } catch(e) {report.cleanupErrors.push(e.message);}
  }
  try {await workspaceReleased();} catch(e) {report.cleanupErrors.push(e.message);}
  if(report.cleanupErrors.length) {
    report.error??='Cleanup failed: '+report.cleanupErrors.join('; ');
    process.exitCode=1; console.error(report.cleanupErrors);
  }
  report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Report: '+path.join(directory,'report.json'));
}
