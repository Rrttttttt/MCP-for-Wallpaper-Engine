import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

async function fixture(t,mode) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'we-shutdown-'));
  const workspace=path.join(directory,'data'),trace=path.join(directory,'trace.jsonl'),config=path.join(directory,'config.json');
  await fs.writeFile(config,JSON.stringify({workspace,timeoutMs:3000}));
  const clients=[];
  t.after(async()=>{
    for(const client of clients.reverse()) await client.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'we-shutdown-'));
    await fs.rm(directory,{recursive:true,force:true});
  });
  async function connect(inject=true) {
    const client=new Client({name:'shutdown-regression',version:'1'});
    clients.push(client);
    const args=inject?['--import',new URL('./fixtures/shutdown-preload.mjs',import.meta.url).href]:[];
    const transport=new StdioClientTransport({command:process.execPath,args:[...args,fileURLToPath(new URL('../dist/index.js',import.meta.url)),'--config',config],stderr:'pipe',env:{...process.env,WE_TEST_WINDOW_STATE:mode,WE_TEST_TRACE:trace}});
    transport.stderr?.resume();await client.connect(transport);return client;
  }
  const client=await connect();
  const project=await client.callTool({name:'we_project_create',arguments:{name:'shutdown',title:'Shutdown regression'}});
  assert.notEqual(project.isError,true);
  const opened=await client.callTool({name:'we_preview_open',arguments:{projectId:project.structuredContent.projectId}});
  assert.equal(opened.structuredContent.error.code,'PREVIEW_OPEN_FAILED');
  assert.equal(opened.structuredContent.error.details.cause,'CLI_FAILED');
  const previewId=opened.structuredContent.error.details.previewId;
  const registry=()=>fs.readFile(path.join(workspace,'active-previews.json'),'utf8').then(JSON.parse);
  assert.equal((await registry()).length,1);
  return {client,connect,previewId,registry,lock:path.join(workspace,'server.lock'),trace:async()=> (await fs.readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line))};
}

test('failed unbound preview that is already absent exits within SDK grace and the next session owns the workspace',async t=>{
  const f=await fixture(t,'absent');
  await f.client.close();
  await assert.rejects(fs.access(f.lock),{code:'ENOENT'});
  assert.deepEqual(await f.registry(),[]);
  assert.deepEqual((await f.trace()).map(entry=>entry.operation),['baseline','cli','absent']);
  const next=await f.connect(false);
  const diagnosis=await next.callTool({name:'we_workspace_diagnose',arguments:{}});
  assert.equal(diagnosis.structuredContent.mode,'owner');
  assert.equal(diagnosis.structuredContent.startupIssue,null);
});

test('late unbound window must bind and verify before the generated-name close command',async t=>{
  const f=await fixture(t,'present');
  const closed=await f.client.callTool({name:'we_preview_close',arguments:{previewId:f.previewId}});
  assert.notEqual(closed.isError,true);assert.equal(closed.structuredContent.state,'window-absent');
  assert.deepEqual(await f.registry(),[]);
  assert.deepEqual((await f.trace()).map(entry=>entry.operation),['baseline','cli','absent','find','verify','cli','absent']);
});

test('unowned or uninspectable failed preview keeps its registry and never receives a close command',async t=>{
  for(const [mode,code] of [['not-owned','WINDOW_NOT_OWNED'],['unavailable','NATIVE_CAPTURE_TIMEOUT']]) {
    await t.test(mode,async t=>{
      const f=await fixture(t,mode),before=await f.registry();
      const closed=await f.client.callTool({name:'we_preview_close',arguments:{previewId:f.previewId}});
      assert.equal(closed.isError,true);assert.equal(closed.structuredContent.error.code,code);
      assert.deepEqual(await f.registry(),before);
      const trace=await f.trace();
      assert.equal(trace.filter(entry=>entry.operation==='cli').length,1,'Only the failed open command may be attempted');
      if(mode==='unavailable') assert.equal(trace.some(entry=>entry.operation==='find'),false,'Do not mask an inspection failure with another long discovery attempt');
    });
  }
});
