// Explicit real-engine acceptance: user-selected source is read only; all projects live in a fresh workspace.
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {loadConfig,hash} from '../dist/files.js';
import {Engine} from '../dist/engine.js';
import {Projects} from '../dist/projects.js';
import {nativeCall} from '../dist/native.js';
const root=fileURLToPath(new URL('../',import.meta.url)),base=await loadConfig(path.join(root,'we.config.json'));
assert.equal(process.argv.length,3,'Pass one absolute local source-image path.');
const source=path.resolve(process.argv[2]),original=await fs.readFile(source),sourceHash=hash(original);
const run=path.join(root,'.we-mcp','image-scene-verification',randomUUID()),workspace=path.join(run,'data');await fs.mkdir(run,{recursive:true});
const config=path.join(run,'config.json');await fs.writeFile(config,JSON.stringify({...base,workspace,assetRoots:[path.dirname(source)],projectRoots:[]}));
const report={startedAt:new Date().toISOString(),source,sourceHash,steps:[],checks:[],measurements:{},cleanupErrors:[]},active=new Map();
const client=new Client({name:'image-scene-acceptance',version:'1'});
async function call(name,args={}) {
  const r=await client.callTool({name,arguments:args},{timeout:90000});assert.ok(r.content.every(c=>c.type==='text'));
  const value=r.structuredContent;report.steps.push({name,result:value});
  if(name==='we_preview_open') {const p=value.error?.details??value;if(p.previewId) active.set(p.previewId,p)}
  if(name==='we_preview_close'&&!r.isError) active.delete(args.previewId);
  if(r.isError) throw new Error(JSON.stringify(value));
  // The official engine briefly draws a centered "Done." status overlay after commands.
  // Wait for that transient UI before comparing the entire wallpaper, rather than masking it out.
  if(['we_preview_open','we_preview_set_properties'].includes(name)) await new Promise(resolve=>setTimeout(resolve,name==='we_preview_open'?5000:2500));
  console.log(name+': '+(value.state??value.revision??'ok'));return value;
}
async function closeAll(){for(const p of [...active.values()])await call('we_preview_close',{previewId:p.previewId})}
async function frames(p,label,count=1,reload=false) {
  const r=await call('we_preview_observe',{previewId:p.previewId,backend:'native',count,intervalMs:500,reload});
  assert.equal(r.complete,true,JSON.stringify(r.issues));assert.deepEqual(r.issues,[]);
  const result=[];
  for(const capture of r.captures) {
    // WE CLI dimensions in this tested engine are physical client pixels, including at 120 DPI.
    // Capture metadata still records DPI; do not scale these CLI dimensions a second time.
    const border=1,width=p.width,height=p.height;
    assert.ok(Math.abs(capture.width-width-2*border)<=2,'Unexpected native client geometry; review crop instead of guessing.');
    const crop={left:Math.floor((capture.width-width)/2),top:capture.height-height-border,width,height};
    const pixels=await sharp(capture.path).extract(crop).removeAlpha().raw().toBuffer();
    assert.equal(pixels.length,width*height*3);result.push({file:capture.path,width,height,pixels});
  }
  report.measurements[label]=result.map(({pixels,...m})=>m);return result;
}
const meanDiff=(a,b)=>{assert.equal(a.length,b.length);return a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0)/a.length};
async function matchesBackground(p,reference,label,reload=false) {
  for(let attempt=0;attempt<8;attempt++) {
    const frame=(await frames(p,label+'-'+attempt,1,reload&&attempt===0)).at(-1);
    if(frame.pixels.equals(reference.pixels)) return frame;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.fail('Background did not return to the exact reference after bounded transient-UI settling: '+label);
}
function light(frame,background) {
  const {width,height,pixels}=frame;assert.equal(pixels.length,background.pixels.length);
  let count=0,weight=0,x=0,y=0,minX=width,minY=height,maxX=0,maxY=0;
  for(let j=0;j<height;j++)for(let i=0;i<width;i++) {
    const p=(j*width+i)*3,d=(Math.abs(pixels[p]-background.pixels[p])+Math.abs(pixels[p+1]-background.pixels[p+1])+Math.abs(pixels[p+2]-background.pixels[p+2]))/3;
    if(d>3){count++;weight+=d;x+=i*d;y+=j*d;minX=Math.min(minX,i);maxX=Math.max(maxX,i);minY=Math.min(minY,j);maxY=Math.max(maxY,j)}
  }
  assert.ok(count>20&&count<width*height*.03,'Expected a localized independent light, not a whole-frame change or missing layer.');
  return {file:frame.file,count,x:x/weight,y:y/weight,bounds:{minX,minY,maxX,maxY}};
}
try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js'),'--config',config],stderr:'inherit'}));
  const inspected=await call('we_image_inspect',{sourceRoot:0,sourcePath:path.basename(source)});assert.equal(inspected.image.sha256,sourceHash);
  const project=await call('we_scene_create',{name:'image-light',title:'躺椅 · 微光',sourceRoot:0,sourcePath:path.basename(source),expectedSourceHash:sourceHash});
  assert.equal(project.manifest.type,'scene');assert.equal(project.validation.valid,true);assert.equal(project.compilation.textures.length,2);
  assert.equal(project.validation.sceneDependencies.length,6);assert.ok(project.validation.sceneDependencies.every(d=>d.status==='local'));
  const originalFile=project.files.find(f=>f.name.startsWith('sources/original.'));assert.ok(originalFile);assert.equal(originalFile.sha256,sourceHash);
  report.project={projectId:project.projectId,path:project.path,revision:project.revision,config};
  const p=await call('we_preview_open',{projectId:project.projectId,width:960,height:640});
  await frames(p,'default-composition');
  await call('we_preview_set_properties',{previewId:p.previewId,properties:{lightVisible:false,speed:0,amplitude:0}});
  const background=(await frames(p,'background-only',2)).at(-1);
  const target=await sharp(original).autoOrient().toColourspace('srgb').resize(background.width,background.height,{fit:'fill'}).removeAlpha().raw().toBuffer();
  const error=meanDiff(background.pixels,target);report.checks.push({name:'rendered-background-versus-oriented-source',meanAbsoluteRGBError:error});
  assert.ok(error<6,'Rendered background does not match the selected image at the expected orientation and framing.');
  const props=project.manifest.general.properties,maxSize=props.lightSize.max;
  const smallSize=Math.min(32,maxSize),largeSize=Math.min(96,maxSize);assert.ok(largeSize>=smallSize*2);
  await call('we_preview_set_properties',{previewId:p.previewId,properties:{lightVisible:true,lightSize:smallSize}});
  const small=light((await frames(p,'small-light')).at(-1),background);
  await call('we_preview_set_properties',{previewId:p.previewId,properties:{lightSize:largeSize}});
  const large=light((await frames(p,'large-light')).at(-1),background);
  assert.ok(large.count>small.count*2,'Live lightSize did not increase the affected area');
  assert.ok(Math.hypot(small.x-large.x,small.y-large.y)<4,'Resizing unexpectedly moved the light center');
  report.checks.push({name:'live-size-binding',small,large});
  await call('we_preview_set_properties',{previewId:p.previewId,properties:{speed:.35,amplitude:Math.floor(project.image.displayWidth*.1)}});
  const moving=(await frames(p,'moving-light',3)).map(f=>light(f,background));
  const travel=Math.max(...moving.map(f=>f.x))-Math.min(...moving.map(f=>f.x));
  assert.ok(travel>20,'Light origin script did not produce visible independent motion');
  assert.ok(Math.max(...moving.map(f=>f.y))-Math.min(...moving.map(f=>f.y))<4);
  report.checks.push({name:'live-speed-and-travel',travel,moving});
  await call('we_preview_set_properties',{previewId:p.previewId,properties:{lightVisible:false}});
  const hidden=await matchesBackground(p,background,'light-hidden'),hiddenError=meanDiff(hidden.pixels,background.pixels);
  report.checks.push({name:'hidden-restores-background',meanAbsoluteRGBError:hiddenError});
  const before=await call('we_project_inspect',{projectId:project.projectId,readFiles:['project.json']});assert.equal(before.revision,project.revision);
  const manifest=JSON.parse(before.contents['project.json']);manifest.general.properties.lightVisible.value=false;
  const edited=await call('we_project_apply',{projectId:project.projectId,expectedRevision:before.revision,changes:[{path:'project.json',content:JSON.stringify(manifest,null,2)+'\n'}]});
  assert.ok(edited.checkpointId);
  const changed=await call('we_preview_open',{projectId:project.projectId,width:960,height:640});
  await matchesBackground(changed,background,'saved-hidden-default');
  const restored=await call('we_project_restore',{projectId:project.projectId,expectedRevision:edited.revision,checkpointId:edited.checkpointId});assert.equal(restored.revision,project.revision);
  await matchesBackground(changed,background,'old-snapshot-stays-hidden',true);
  await closeAll();
  const reopened=await call('we_preview_open',{projectId:project.projectId,width:960,height:640});assert.equal(reopened.revision,project.revision);
  await call('we_preview_set_properties',{previewId:reopened.previewId,properties:{speed:0,amplitude:0}});
  light((await frames(reopened,'restored-visible-default')).at(-1),background);
  report.checks.push({name:'checkpoint-restore-and-reopen',passed:true});
  report.publish=await call('we_publish_prepare',{projectId:project.projectId,intent:'new'});
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e)}
finally {
  try{await closeAll()}catch(e){report.cleanupErrors.push(e.message)}
  try{await client.close()}catch(e){report.cleanupErrors.push(e.message)}
  try {
    const entries=JSON.parse(await fs.readFile(path.join(workspace,'active-previews.json')));
    for(const p of entries) {
      assert.equal(path.dirname(p.directory),path.join(workspace,'previews'));assert.ok(p.windowIdentity);
      const req={windowName:p.windowName,installDir:base.installDir,expected:p.windowIdentity};
      try{await nativeCall('absent',req,300);continue}catch{}
      await nativeCall('verify',req);await new Engine(base,new Projects(base)).cli(['-control','closeWallpaper','-location',p.windowName]);await nativeCall('absent',req);
    }
    assert.deepEqual(entries,[]);await assert.rejects(fs.access(path.join(workspace,'server.lock')),{code:'ENOENT'});
    assert.deepEqual(await fs.readdir(path.join(workspace,'scene-builds')),[]);
    assert.equal(hash(await fs.readFile(source)),sourceHash);
  }catch(e){report.cleanupErrors.push(e.message)}
  report.passed=!report.error&&report.cleanupErrors.length===0;report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('Report: '+path.join(run,'report.json'));
  if(!report.passed)process.exitCode=1;
}
