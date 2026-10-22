// Explicit real-engine acceptance. Optional argument: an existing Web project directory.
// All writes go to a fresh workspace; no desktop or source-project changes.
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {loadConfig,readTree,revision} from '../dist/files.js';
import {Cdp,findTarget} from '../dist/cdp.js';
import {nativeCall} from '../dist/native.js';
import {decodePng} from './png.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),base=await loadConfig(path.join(root,'we.config.json'));
const source=process.argv[2]?path.resolve(process.argv[2]):undefined;
const sourceBefore=source?revision(await readTree(source)):undefined;
const run=path.join(root,'.we-mcp','cef-verification',randomUUID()),workspace=path.join(run,'data');
await fs.mkdir(run,{recursive:true});
const config=path.join(run,'config.json');
await fs.writeFile(config,JSON.stringify({...base,workspace,projectRoots:source?[source]:[]}));
const client=new Client({name:'cef-chain-acceptance',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js'),'--config',config],stderr:'inherit'});
const report={startedAt:new Date().toISOString(),source,sourceBefore,steps:[],checks:[],cleanupErrors:[]};
let preview,observer;
async function call(name,args={}) {
  const response=await client.callTool({name,arguments:args},undefined,{timeout:60000}),value=response.structuredContent;
  assert.ok(response.content.every(c=>c.type==='text'));
  report.steps.push({name,result:value});
  if(name==='we_preview_open')preview=value.error?.details??value;
  console.log(name+': '+(value.state??value.confirmation??value.error?.code??'ok'));
  if(response.isError)throw new Error(JSON.stringify(value));
  return value;
}
async function observe(options={}) {
  const r=await call('we_preview_observe',{previewId:preview.previewId,backend:'cef',...options});
  assert.equal(r.complete,true);assert.deepEqual(r.issues,[]);
  assert.equal(r.evidence.readyState,'complete');assert.equal(r.evidence.diagnostics.ready,true);
  for(const image of r.images){const frame=decodePng(await fs.readFile(image));assert.ok(frame.width>0&&frame.height>0)}
  return r;
}
async function attach() {
  const target=await findTarget(base.devtoolsPort,preview.directory);assert.ok(target);
  observer=await Cdp.connect(base.devtoolsPort,target,4000);
  report.checks.push({name:'owned-target-listener',host:target.discoveryHost,targetId:target.id});
  // Test-only listener in this run's verified page; no public arbitrary-evaluation tool is added.
  await observer.call('Runtime.evaluate',{expression:"window.__cefAcceptanceInput=[];window.addEventListener('mousemove',function(e){window.__cefAcceptanceInput.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted});if(window.__cefAcceptanceInput.length>100)window.__cefAcceptanceInput.shift()})"});
}
async function mouse(x,y) {
  await observer.call('Runtime.evaluate',{expression:'window.__cefAcceptanceInput=[]'});
  const moved=await call('we_preview_move_mouse',{previewId:preview.previewId,x,y});
  assert.equal(moved.confirmation,'event-dispatched');
  let events,received;
  for(let attempt=0;attempt<10;attempt++) {
    const r=await observer.call('Runtime.evaluate',{expression:'JSON.stringify(window.__cefAcceptanceInput)',returnByValue:true});
    events=JSON.parse(r.result.value);
    received=events.find(e=>e.trusted&&Math.abs(e.x-moved.position.x)<=1&&Math.abs(e.y-moved.position.y)<=1);
    if(received)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  report.checks.push({name:'actual-page-mouse-event',normalized:{x,y},expected:moved.position,events});
  assert.ok(received,JSON.stringify({expected:moved.position,events}));
}
try {
  await client.connect(transport);
  const project=await call('we_project_create',{name:'cef-acceptance',title:'CEF acceptance copy',...(source?{sourceProjectId:'root0'}:{})});
  assert.equal(project.manifest.type,'web');
  preview=await call('we_preview_open',{projectId:project.projectId,width:960,height:540});
  assert.equal(preview.state,'page-ready');await attach();
  const initial=await observe({count:2,intervalMs:300});assert.deepEqual(initial.evidence.diagnostics.errors,[]);
  await call('we_preview_set_properties',{previewId:preview.previewId,properties:{speed:0.7}});
  assert.equal((await observe()).evidence.diagnostics.settings.speed,0.7);
  report.checks.push({name:'live-property-readback',speed:0.7});
  await mouse(0.25,0.5);await mouse(0.75,0.5);
  await observer.call('Runtime.evaluate',{expression:"console.error('WE-MCP CEF acceptance console');setTimeout(function(){throw new Error('WE-MCP CEF acceptance exception')},0)"});
  let errors;
  for(let attempt=0;attempt<10;attempt++) {
    errors=await observe();
    if(errors.evidence.diagnostics.errors.some(e=>e.includes('WE-MCP CEF acceptance exception')))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const entries=errors.logs.entries;
  assert.ok(entries.some(e=>e.method==='Runtime.consoleAPICalled'&&JSON.stringify(e.params).includes('WE-MCP CEF acceptance console')));
  assert.ok(entries.some(e=>e.method==='Runtime.exceptionThrown'&&JSON.stringify(e.params).includes('WE-MCP CEF acceptance exception')));
  assert.ok(errors.evidence.diagnostics.errors.some(e=>e.includes('WE-MCP CEF acceptance exception')));
  report.checks.push({name:'console-and-runtime-error-collection',passed:true});
  observer.close();observer=undefined;
  const reloaded=await observe({reload:true,count:2,intervalMs:300});
  preview={...preview,windowIdentity:reloaded.windowIdentity};
  await nativeCall('verify',{windowName:preview.windowName,installDir:base.installDir,expected:preview.windowIdentity});
  assert.deepEqual(reloaded.evidence.diagnostics.errors,[]);
  assert.equal(reloaded.evidence.diagnostics.settings.speed,project.manifest.general.properties.speed.value);
  await attach();await mouse(0.5,0.5);
  await call('we_preview_set_properties',{previewId:preview.previewId,properties:{speed:0.7}});
  assert.equal((await observe()).evidence.diagnostics.settings.speed,0.7);
  report.checks.push({name:'host-reload-restores-source-defaults-and-live-callbacks',passed:true});
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e)}
finally {
  observer?.close();
  if(preview?.previewId){try{await call('we_preview_close',{previewId:preview.previewId})}catch(e){report.cleanupErrors.push(e.message)}}
  try{await client.close()}catch(e){report.cleanupErrors.push(e.message)}
  try {
    await assert.rejects(fs.access(path.join(workspace,'server.lock')),{code:'ENOENT'});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspace,'active-previews.json'))),[]);
    if(source){report.sourceAfter=revision(await readTree(source));assert.equal(report.sourceAfter,sourceBefore)}
  }catch(e){report.cleanupErrors.push(e.message)}
  if(report.cleanupErrors.length){report.error??=report.cleanupErrors.join('; ');process.exitCode=1}
  report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Report: '+path.join(run,'report.json'));
}
