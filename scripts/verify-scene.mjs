// Explicit real-engine acceptance for the bundled Scene template, using a text-only MCP client.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { loadConfig } from '../dist/files.js';
import { pngInfo } from '../dist/native.js';
const root = fileURLToPath(new URL('../',import.meta.url));
const original = await loadConfig(path.join(root,'we.config.json'));
const directory = path.join(root,'.we-mcp','scene-verification');
await fs.mkdir(directory,{recursive:true});
const config = path.join(directory,'config.json');
await fs.writeFile(config,JSON.stringify({...original,workspace:path.join(directory,'data'),projectRoots:[],devtoolsPort:null,timeoutMs:8000}));
const client = new Client({name:'scene-template-verification',version:'1'});
const transport = new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js'),'--config',config],stderr:'inherit'});
const report = {startedAt:new Date().toISOString(),steps:[],measurements:{},error:null};
const active = new Set();
async function call(name,args={}) {
  const response = await client.callTool({name,arguments:args},undefined,{timeout:60000});
  assert.ok(response.content.every(c=>c.type==='text'),'Unexpected image payload for a text-only client.');
  const result = response.structuredContent;
  report.steps.push({tool:name,result});
  if(response.isError) throw new Error(JSON.stringify(result));
  console.log(name+': '+(result.state??result.revision??'ok'));
  return result;
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
async function observe(id,label,count=3) {
  const result=await call('we_preview_observe',{previewId:id,count,intervalMs:250,backend:'native'});
  assert.equal(result.complete,true,JSON.stringify(result.issues));
  const positions=await Promise.all(result.images.map(marker));
  report.measurements[label]=positions;
  return positions;
}
const travel=frames=>Math.max(...frames.map(f=>f.x))-Math.min(...frames.map(f=>f.x));
try {
  await client.connect(transport);
  const created=await call('we_project_create',{name:'orbit-'+randomUUID().slice(0,8),title:'Scene template acceptance',templateId:'scene-orbit',properties:{amplitude:160}});
  assert.equal(created.manifest.type,'scene'); assert.equal(created.validation.valid,true);
  assert.ok(created.validation.sceneDependencies.every(d=>d.status==='local'));
  const opened=await call('we_preview_open',{projectId:created.projectId,width:960,height:540});
  active.add(opened.previewId);
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
  const closed=await call('we_preview_close',{previewId:opened.previewId}); active.delete(opened.previewId);
  assert.equal(closed.state,'window-absent');
} catch(e) {report.error=e.stack;process.exitCode=1;console.error(e);}
finally {
  for(const previewId of active) {try{await call('we_preview_close',{previewId});}catch(e){console.error(e.message);}}
  await client.close();
  report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Report: '+path.join(directory,'report.json'));
}
