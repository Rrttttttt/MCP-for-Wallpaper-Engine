import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { hash } from '../dist/files.js';

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'we-mcp-media-stop-'));
  const workspace=path.join(directory,'data'),config=path.join(directory,'config.json'),pidFile=path.join(directory,'probe.pid');
  const assets=fileURLToPath(new URL('./fixtures/media/',import.meta.url)),clients=[];
  await fs.writeFile(config,JSON.stringify({workspace,assetRoots:[assets]}));
  t.after(async()=>{
    for(const client of clients.reverse()) await client.close();
    assert.ok(directory.startsWith(path.join(os.tmpdir(),'we-mcp-media-stop-')));
    await fs.rm(directory,{recursive:true,force:true});
  });
  async function connect(stalled=true) {
    const client=new Client({name:'media-stop-test',version:'1'});clients.push(client);
    const transport=new StdioClientTransport({command:process.execPath,args:[...(stalled?['--import',new URL('./fixtures/media-probe-stall.mjs',import.meta.url).href]:[]),fileURLToPath(new URL('../dist/index.js',import.meta.url)),'--config',config],stderr:'pipe',env:{...process.env,WE_TEST_MEDIA_PID:pidFile}});
    await client.connect(transport);transport.stderr?.resume();return client;
  }
  async function workerPid() {
    const deadline=Date.now()+3000;
    while(Date.now()<deadline) {
      const value=await fs.readFile(pidFile,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e});
      if(/^\d+$/.test(value))return Number(value);
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    throw new Error('Stalled parser was not started');
  }
  return {client:await connect(),connect,workerPid,workspace,assets};
}

test('real stalled media worker times out, exits, and the same MCP session remains usable',async t=>{
  const {client,workerPid}=await fixture(t);
  const pending=client.callTool({name:'we_media_inspect',arguments:{sourceRoot:0,sourcePath:'tone.wav'}});
  const pid=await workerPid(),result=await pending;
  assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'MEDIA_PROBE_FAILED');
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  const diagnosis=await client.callTool({name:'we_workspace_diagnose',arguments:{}});
  assert.equal(diagnosis.structuredContent.mode,'owner');
});

test('EOF cancels an active media import, releases the lock, and allows a new session without writes',async t=>{
  const {client,connect,workerPid,workspace,assets}=await fixture(t);
  const created=await client.callTool({name:'we_project_create',arguments:{name:'cancel',title:'Cancel stalled import'}});
  const project=created.structuredContent,source=await fs.readFile(path.join(assets,'tone.wav'));
  const pending=client.callTool({name:'we_media_import',arguments:{projectId:project.projectId,expectedRevision:project.revision,sourceRoot:0,sourcePath:'tone.wav',expectedSourceHash:hash(source),targetPath:'media/tone.wav'}}).catch(()=>null);
  const pid=await workerPid(),started=performance.now();
  await client.close();await pending;
  assert.ok(performance.now()-started<3500,'Shutdown must cancel the worker before its 5 second deadline');
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  await assert.rejects(fs.access(path.join(workspace,'server.lock')),{code:'ENOENT'});
  await assert.rejects(fs.access(path.join(project.path,'media/tone.wav')),{code:'ENOENT'});
  assert.deepEqual(await fs.readdir(path.join(workspace,'checkpoints')).catch(e=>{if(e.code==='ENOENT')return [];throw e}),[]);
  const next=await connect(false);
  const inspected=await next.callTool({name:'we_project_inspect',arguments:{projectId:project.projectId}});
  assert.equal(inspected.structuredContent.revision,project.revision);
});

test('MCP request cancellation stops a media import without closing the client or writing a checkpoint',async t=>{
  const {client,workerPid,workspace,assets}=await fixture(t);
  const created=await client.callTool({name:'we_project_create',arguments:{name:'cancel-request',title:'Cancel request'}});
  const project=created.structuredContent,source=await fs.readFile(path.join(assets,'tone.wav')),controller=new AbortController();
  const pending=client.callTool({name:'we_media_import',arguments:{projectId:project.projectId,expectedRevision:project.revision,sourceRoot:0,sourcePath:'tone.wav',expectedSourceHash:hash(source),targetPath:'media/tone.wav'}},{signal:controller.signal}).catch(()=>null);
  const pid=await workerPid(),started=performance.now();controller.abort();await pending;
  const inspected=await client.callTool({name:'we_project_inspect',arguments:{projectId:project.projectId}});
  assert.ok(performance.now()-started<3500,'Cancellation must stop the worker before its 5 second deadline');
  assert.equal(inspected.structuredContent.revision,project.revision);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  await assert.rejects(fs.access(path.join(project.path,'media/tone.wav')),{code:'ENOENT'});
  assert.deepEqual(await fs.readdir(path.join(workspace,'checkpoints')).catch(e=>{if(e.code==='ENOENT')return [];throw e}),[]);
});
