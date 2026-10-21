// Real STDIO + official CEF + native-window acceptance for the deterministic eyes fixture.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig,hash } from '../dist/files.js';
import { nativeAvailable,nativeCall } from '../dist/native.js';
import { Cdp,findTarget } from '../dist/cdp.js';
import { Engine } from '../dist/engine.js';
import { Projects } from '../dist/projects.js';
import { decodePng } from './png.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),original=await loadConfig(path.join(root,'we.config.json'));
const directory=path.join(root,'.we-mcp','mouse-verification'),runId=randomUUID(),run=path.join(directory,'runs',runId);
const workspace=path.join(run,'data'),config=path.join(run,'config.json');
await fs.mkdir(run,{recursive:true});
await fs.writeFile(config,JSON.stringify({...original,workspace,projectRoots:[path.join(root,'test','fixtures','mouse-eyes')]}));
const client=new Client({name:'mouse-eyes-acceptance',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js'),'--config',config],stderr:'inherit'});
const report={runId,startedAt:new Date().toISOString(),steps:[],measurements:[],checks:[],unverified:['Concurrent Web-to-Web isolation is not covered. This script uses a static Scene control and tests Web viewport sizes sequentially; see docs/mouse-input-acceptance.md for the local two-Web failure.'],cleanupErrors:[],error:null};
const active=new Map();
const execute=promisify(execFile);
// Read-only Win32 API. Never set, capture, restore or block the shared system cursor.
const cursorScript=`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CursorProbe { public struct Point { public int X; public int Y; } [DllImport("user32.dll",SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetPhysicalCursorPos(out Point point); }'; $point=[CursorProbe+Point]::new(); if (-not [CursorProbe]::GetPhysicalCursorPos([ref]$point)) { throw 'Cannot read system cursor position' }; $point | ConvertTo-Json -Compress`;
async function cursor() {
  const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',cursorScript],{windowsHide:true,timeout:10000,maxBuffer:4096});
  const p=JSON.parse(stdout); assert.ok(Number.isInteger(p.X)&&Number.isInteger(p.Y)); return p;
}
async function call(name,args={},expectedErrors) {
  const response=await client.callTool({name,arguments:args},undefined,{timeout:60000});
  assert.ok(response.content.every(c=>c.type==='text'),'Expected a text-only MCP response.');
  const result=response.structuredContent; report.steps.push({tool:name,result});
  const p=result.error?.details??result;
  if(p.previewId&&p.windowName) active.set(p.previewId,p);
  if(expectedErrors) { assert.equal(response.isError,true); assert.ok(expectedErrors.includes(result.error?.code),JSON.stringify(result)); }
  else if(response.isError) throw new Error(JSON.stringify(result));
  console.log(name+': '+(result.state??result.confirmation??result.error?.code??'ok'));
  return result;
}
async function close(p) {
  assert.equal((await call('we_preview_close',{previewId:p.previewId})).state,'window-absent');
  active.delete(p.previewId);
}
function measure(frame) {
  const eyes=[0,1].map(()=>({count:0,x:0,y:0,iris:0,minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity}));
  // Exclude native title bars. The only near-black shapes in the fixture's central area are pupils.
  for(let y=Math.floor(frame.height*0.2);y<frame.height*0.8;y++) for(let x=0;x<frame.width;x++) {
    const i=(y*frame.width+x)*frame.channels,r=frame.pixels[i],g=frame.pixels[i+1],b=frame.pixels[i+2],eye=eyes[x<frame.width/2?0:1];
    if(r<10&&g<15&&b<20) {
      eye.count++;eye.x+=x+0.5;eye.y+=y+0.5;
      eye.minX=Math.min(eye.minX,x);eye.maxX=Math.max(eye.maxX,x);eye.minY=Math.min(eye.minY,y);eye.maxY=Math.max(eye.maxY,y);
    }
    if(r<30&&g>150&&b>180) eye.iris++;
  }
  return eyes.map(eye=>{
    assert.ok(eye.count>100&&eye.iris>300,'Missing pupil/iris in captured image.');
    return {x:eye.x/eye.count,y:eye.y/eye.count,width:eye.maxX-eye.minX+1,height:eye.maxY-eye.minY+1,pupilPixels:eye.count,irisPixels:eye.iris};
  });
}
async function observe(p,backend='cef',count=2,measureEyes=true) {
  const result=await call('we_preview_observe',{previewId:p.previewId,count,intervalMs:100,backend});
  assert.equal(result.complete,true,JSON.stringify(result.issues));
  assert.deepEqual(result.issues,[]);
  const frame=decodePng(await fs.readFile(result.images.at(-1)));
  const diagnostics=result.evidence?.diagnostics;
  if(backend==='cef') {
    assert.ok(diagnostics?.ready);assert.deepEqual(diagnostics.errors,[]);
    assert.equal(frame.width,diagnostics.width);assert.equal(frame.height,diagnostics.height);
  }
  return {result,frame,eyes:measureEyes?measure(frame):undefined,diagnostics};
}
async function point(p,label,x,y) {
  const before=await cursor();
  const moved=await call('we_preview_move_mouse',{previewId:p.previewId,x,y});
  assert.equal(moved.confirmation,'event-dispatched');
  const observed=await observe(p),input=observed.diagnostics.input,after=await cursor();
  report.measurements.push({label,previewId:p.previewId,normalized:{x,y},position:moved.position,input,events:observed.diagnostics.events,cursor:{before,after},images:observed.result.images,eyes:observed.eyes});
  assert.ok(Math.abs(input.x-moved.position.x)<=1&&Math.abs(input.y-moved.position.y)<=1,'Page did not receive the requested client coordinates.');
  assert.equal(input.buttons,0);assert.equal(input.trusted,true);
  assert.deepEqual(after,before,'System cursor moved during acceptance; user movement also invalidates this check. Retry with the pointer stationary.');
  return observed;
}
function pixels(observed,baseline,x,y) {
  const frame=observed.frame,w=frame.width,h=frame.height,rx=w*0.12,ry=h*0.12;
  assert.equal(w,baseline.frame.width);assert.equal(h,baseline.frame.height);assert.equal(frame.channels,baseline.frame.channels);
  const nx=x*2-1,ny=y*2-1,length=Math.max(1,Math.hypot(nx,ny));
  for(let eye=0;eye<2;eye++) {
    const a=observed.eyes[eye],b=baseline.eyes[eye],dx=a.x-b.x,dy=a.y-b.y;
    assert.ok(Math.abs(dx-nx/length*rx*0.8)<2&&Math.abs(dy-ny/length*ry*0.8)<2,'Pixel-measured gaze direction/amplitude differs from the fixture contract.');
    assert.ok(Math.hypot(dx/(rx*0.8),dy/(ry*0.8))<=1.05,'Gaze exceeds the elliptical displacement limit.');
    assert.ok(Math.abs(a.width-b.width)<=2&&Math.abs(a.height-b.height)<=2,'Pupil stretched or was unexpectedly clipped.');
    assert.ok(a.irisPixels/b.irisPixels>0.45&&a.irisPixels/b.irisPixels<1.05,'Iris disappeared or expanded at the edge.');
  }
  let outsideChanges=0;
  for(let py=0;py<h;py++) for(let px=0;px<w;px++) {
    const i=(py*w+px)*frame.channels;
    if(![0,1,2].some(c=>Math.abs(frame.pixels[i+c]-baseline.frame.pixels[i+c])>8)) continue;
    const inside=[0.32,0.68].some(center=>((px+0.5-center*w)/(rx+2))**2+((py+0.5-h/2)/(ry+2))**2<=1);
    if(!inside) outsideChanges++;
  }
  assert.equal(outsideChanges,0,'Eye movement changed pixels outside the fixed eye masks.');
  report.checks.push({name:'pixel-direction-amplitude-mask-and-shape',normalized:{x,y},outsideChanges,passed:true});
}
function sameControl(a,b) {
  assert.equal(a.frame.width,b.frame.width);assert.equal(a.frame.height,b.frame.height);
  assert.equal(a.frame.channels,b.frame.channels);
  // Native PNGs include nonclient decorations. Compare the central scene region, not title bars/borders.
  const signature=({frame})=>{
    const rows=[];
    for(let y=Math.floor(frame.height*0.2);y<Math.floor(frame.height*0.8);y++) rows.push(frame.pixels.subarray((y*frame.width+Math.floor(frame.width*0.05))*frame.channels,(y*frame.width+Math.floor(frame.width*0.95))*frame.channels));
    return hash(Buffer.concat(rows));
  };
  assert.equal(signature(a),signature(b),'The control preview changed without targeted input.');
}

try {
  assert.ok(original.devtoolsPort,'Configure local CEF debugging before mouse acceptance.');
  assert.ok(await nativeAvailable(),'Build the native helper before verifying actual windows.');
  await client.connect(transport);
  transport._process.once('exit',(code,signal)=>{report.serverExit={code,signal}});
  const project=await call('we_project_create',{name:'mouse-eyes',title:'Mouse eyes acceptance',sourceProjectId:'root0'});
  assert.equal(project.validation.valid,true);
  const a=await call('we_preview_open',{projectId:project.projectId,width:960,height:540});
  const controlProject=await call('we_project_create',{name:'static-scene-control',title:'Static mouse isolation control',templateId:'scene-orbit',properties:{speed:0,amplitude:0}});
  const b=await call('we_preview_open',{projectId:controlProject.projectId,width:640,height:480});
  assert.ok(a.windowIdentity&&b.windowIdentity);
  const control=await observe(b,'native',1,false),baseline=await point(a,'center',0.5,0.5);
  for(let eye=0;eye<2;eye++) {
    assert.ok(Math.abs(baseline.eyes[eye].x-baseline.frame.width*[0.32,0.68][eye])<1);
    assert.ok(Math.abs(baseline.eyes[eye].y-baseline.frame.height/2)<1);
  }
  const nativeBaseline=await observe(a,'native',1);
  let events=baseline.diagnostics.events;
  for(const [label,x,y] of [['near-right',0.6,0.5],['mid-right',0.75,0.5],['right',1,0.5],['left',0,0.5],['down',0.5,1],['up',0.5,0],['top-left',0,0],['top-right',1,0],['bottom-left',0,1],['bottom-right',1,1],['inner-diagonal',0.65,0.65],['outer-diagonal',1,0.75]]) {
    const observed=await point(a,label,x,y);
    assert.ok(observed.diagnostics.events>events);events=observed.diagnostics.events;
    pixels(observed,baseline,x,y);
    sameControl(await observe(b,'native',1,false),control);
  }
  const nativeEdge=await observe(a,'native',1),cefEdge=report.measurements.at(-1);
  const scale=(nativeBaseline.eyes[1].x-nativeBaseline.eyes[0].x)/(baseline.eyes[1].x-baseline.eyes[0].x);
  for(let eye=0;eye<2;eye++) for(const axis of ['x','y']) {
    const nativeDelta=nativeEdge.eyes[eye][axis]-nativeBaseline.eyes[eye][axis];
    const cefDelta=cefEdge.eyes[eye][axis]-baseline.eyes[eye][axis];
    assert.ok(Math.abs(nativeDelta-cefDelta*scale)<3,'Actual native-window gaze does not match the CEF image.');
  }
  report.checks.push({name:'actual-native-window-matches-cef-gaze',scale,baseline:nativeBaseline.result.images,edge:nativeEdge.result.images,passed:true});
  const returned=await point(a,'return-center',0.5,0.5);
  assert.equal(hash(returned.frame.pixels),hash(baseline.frame.pixels),'Returning to center left trails or altered the eye masks.');
  report.checks.push({name:'web-input-does-not-change-owned-static-scene',controlImages:control.result.images,passed:true});
  await close(b);await close(a);
  const small=await call('we_preview_open',{projectId:project.projectId,width:640,height:480});
  const smallCenter=await point(small,'small-center',0.5,0.5);
  for(const [label,x,y] of [['small-left',0,0.5],['small-bottom-right',1,1]]) pixels(await point(small,label,x,y),smallCenter,x,y);
  report.checks.push({name:'two-sequential-web-viewport-sizes',sizes:[[960,540],[640,480]],passed:true});
  const target=await findTarget(original.devtoolsPort,small.directory);assert.ok(target);
  await nativeCall('verify',{windowName:small.windowName,installDir:original.installDir,expected:small.windowIdentity});
  const navigation=await Cdp.connect(original.devtoolsPort,target,4000);
  try {
    // Test-only CDP handle to our own page; never exposed as an arbitrary-evaluation MCP tool.
    await navigation.call('Page.navigate',{url:'about:blank'});
    let url;
    for(let attempt=0;attempt<20;attempt++) {url=(await navigation.diagnostics()).url;if(url==='about:blank') break;await new Promise(r=>setTimeout(r,50));}
    assert.equal(url,'about:blank');
    await call('we_preview_move_mouse',{previewId:small.previewId,x:0.5,y:0.5},['CEF_TARGET_UNAVAILABLE','TARGET_CHANGED']);
  } finally {navigation.close();}
  await close(small);
  await call('we_preview_move_mouse',{previewId:a.previewId,x:0.5,y:0.5},['PREVIEW_NOT_FOUND']);
  report.checks.push({name:'navigated-and-closed-previews-reject-input',passed:true});
} catch(e) {report.error=e.stack;process.exitCode=1;console.error(e);}
finally {
  for(const p of [...active.values()]) {try {await close(p);} catch(e) {report.cleanupErrors.push(e.message);}}
  try {await client.close();} catch(e) {report.cleanupErrors.push(e.message);}
  // A failed open/transport can leave a registered window. Only this fresh run's verified identities qualify.
  try {
    const entries=JSON.parse(await fs.readFile(path.join(workspace,'active-previews.json')));
    for(const p of entries) {
      assert.equal(path.dirname(p.directory),path.join(workspace,'previews'));assert.ok(p.windowIdentity);
      const request={windowName:p.windowName,installDir:original.installDir,expected:p.windowIdentity};
      try {await nativeCall('absent',request,300);continue;} catch { /* verify ownership before fallback close */ }
      await nativeCall('verify',request);
      await new Engine(original,new Projects(original)).cli(['-control','closeWallpaper','-location',p.windowName]);
      await nativeCall('absent',request);
    }
    assert.deepEqual(entries,[],'Shutdown left recovery records.');
    await assert.rejects(fs.access(path.join(workspace,'server.lock')),{code:'ENOENT'});
  } catch(e) {report.cleanupErrors.push(e.message);}
  if(report.cleanupErrors.length) {report.error??='Cleanup failed: '+report.cleanupErrors.join('; ');process.exitCode=1;}
  report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Report: '+path.join(directory,'report.json'));
}
