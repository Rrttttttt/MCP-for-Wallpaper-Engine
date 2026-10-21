// Explicit integration: real WGC windows, no CEF dependency, strict text-only MCP client.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeCall } from '../dist/native.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../',import.meta.url));
const directory = path.join(root,'.we-mcp','native-verification');
await fs.mkdir(directory,{recursive:true});
const original = JSON.parse(await fs.readFile(path.join(root,'we.config.json'),'utf8'));
const installDir = path.resolve(root,original.installDir);
const config = path.join(directory,'config.json');
await fs.writeFile(config,JSON.stringify({installDir,workspace:path.join(directory,'data'),projectRoots:[],devtoolsPort:null,timeoutMs:8000}));
const client = new Client({name:'native-text-only-verification',version:'1'});
const transport = new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js'),'--config',config],stderr:'inherit'});
const report = {startedAt:new Date().toISOString(),steps:[],checks:[]};
const active = new Set();
async function call(name,args={},allowImages=false) {
  const response = await client.callTool({name,arguments:args},undefined,{timeout:60000});
  assert.ok(allowImages || response.content.every(c=>c.type==='text'),'Text-only client rejects all image content.');
  const result = response.structuredContent;
  report.steps.push({tool:name,result,contentTypes:response.content.map(c=>c.type)});
  if (response.isError) throw new Error(JSON.stringify(result));
  console.log(name+': '+(result.state??'ok'));
  return {result,response};
}
async function refused(operation,request,code) {
  await assert.rejects(nativeCall(operation,request,500),e=>e.code===code);
  report.checks.push({operation,expectedCode:code,passed:true});
}
const win32 = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PreviewTest { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string text); }';`;
async function controlOwnWindow(identity,command) {
  assert.match(identity.handle,/^\d+$/);
  const script = win32+command.replaceAll('HANDLE',identity.handle);
  await exec('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000});
  await new Promise(r=>setTimeout(r,250));
}
try {
  await client.connect(transport);
  const probe = (await call('we_environment_probe')).result;
  assert.equal(probe.capabilities.nativeWindowCapture.status,'available');
  const list = (await call('we_project_list')).result;
  const projectId = 'managed/native-starfield';
  if (!list.projects.some(p=>p.projectId===projectId)) await call('we_project_create',{name:'native-starfield',title:'Native capture verification'});
  const opened = (await call('we_preview_open',{projectId,width:960,height:540})).result;
  active.add(opened.previewId);
  assert.equal(opened.state,'window-bound-render-unverified');
  assert.ok(opened.windowIdentity);
  const request = {windowName:opened.windowName,installDir,expected:opened.windowIdentity};
  await refused('capture',{...request,expected:{...request.expected,processId:request.expected.processId+1}},'WINDOW_IDENTITY_CHANGED');
  await refused('capture',{...request,expected:{...request.expected,startTime:'0'}},'WINDOW_IDENTITY_CHANGED');
  await refused('capture',{...request,expected:{...request.expected,handle:'1'}},'WINDOW_IDENTITY_CHANGED');
  await refused('capture',{...request,installDir:directory},'WINDOW_NOT_OWNED');
  await refused('find',{...request,baseline:[request.expected.handle]},'WINDOW_NOT_NEW');
  try {
    await controlOwnWindow(request.expected,'[PreviewTest]::ShowWindowAsync([IntPtr]HANDLE,6) | Out-Null');
    await refused('capture',request,'WINDOW_NOT_CAPTURABLE');
  } finally { await controlOwnWindow(request.expected,'[PreviewTest]::ShowWindowAsync([IntPtr]HANDLE,9) | Out-Null'); }
  try {
    await controlOwnWindow(request.expected,"[PreviewTest]::SetWindowText([IntPtr]HANDLE,'renamed test preview') | Out-Null");
    await refused('absent',request,'WINDOW_CLOSE_TIMEOUT');
    const refusedClose = await client.callTool({name:'we_preview_close',arguments:{previewId:opened.previewId}});
    assert.equal(refusedClose.isError,true);
    assert.equal(refusedClose.structuredContent.error.code,'WINDOW_IDENTITY_CHANGED');
    report.checks.push({name:'renamed-window-close-refused-and-record-retained',passed:true});
  } finally { await controlOwnWindow(request.expected,`[PreviewTest]::SetWindowText([IntPtr]HANDLE,'${opened.windowName}') | Out-Null`); }
  const fakeName = 'WE-MCP-'+randomUUID();
  const fakeBaseline = (await nativeCall('baseline')).handles;
  const fakeScript = `Add-Type -AssemblyName System.Windows.Forms; $form=New-Object System.Windows.Forms.Form; $form.Text='${fakeName}'; $form.add_Shown({[Console]::WriteLine('ready')}); [System.Windows.Forms.Application]::Run($form)`;
  const fake = spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(fakeScript,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Fake-window test setup timed out.')),10000);
      fake.once('error',e=>{clearTimeout(timer);reject(e)});
      fake.once('exit',code=>{clearTimeout(timer);reject(new Error('Fake-window process exited '+code))});
      fake.stdout.once('data',()=>{clearTimeout(timer);resolve()});
    });
    await refused('find',{windowName:fakeName,installDir,baseline:fakeBaseline},'WINDOW_NOT_OWNED');
  } finally { fake.kill(); }
  await call('we_preview_set_properties',{previewId:opened.previewId,properties:{speed:0.7,density:240}});
  const frames = (await call('we_preview_observe',{previewId:opened.previewId,count:3,intervalMs:600})).result;
  assert.equal(frames.complete,true);
  assert.equal(frames.images.length,3,JSON.stringify(frames.issues));
  assert.equal(frames.evidence,undefined);
  assert.equal(frames.inlineImages,0);
  assert.ok(frames.captures.every(f=>f.backend==='native'&&f.windowIdentity.handle===request.expected.handle&&f.width>0&&f.height>0));
  const bytes = await Promise.all(frames.images.map(f=>fs.readFile(f)));
  assert.ok(!bytes[1].equals(bytes[2]),'Native animation frames must differ.');
  report.checks.push({name:'native-multiple-changing-frames-without-CEF',passed:true});
  const embedded = await call('we_preview_observe',{previewId:opened.previewId,backend:'native',includeImages:true},true);
  assert.equal(embedded.response.content.filter(c=>c.type==='image').length,1);
  const reloaded = (await call('we_preview_observe',{previewId:opened.previewId,backend:'native',reload:true,count:2,intervalMs:600})).result;
  assert.equal(reloaded.images.length,2,JSON.stringify(reloaded.issues));
  assert.equal(reloaded.revision,opened.revision);
  const closed = (await call('we_preview_close',{previewId:opened.previewId})).result;
  active.delete(opened.previewId);
  assert.equal(closed.state,'window-absent');
  await refused('capture',request,'WINDOW_IDENTITY_CHANGED');
  await refused('find',{...request,baseline:[]},'WINDOW_NOT_FOUND');
  report.error = null;
} catch(e) {report.error=e.stack;process.exitCode=1;console.error(e);}
finally {
  for(const previewId of active) {try {await call('we_preview_close',{previewId});}catch(e){console.error(e.message);}}
  await client.close();
  report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Report: '+path.join(directory,'report.json'));
}
