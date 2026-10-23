// Real STDIO metadata/import/undo acceptance. Optional arguments: local WAV/MP3/MP4/WebM files.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hash } from '../dist/files.js';
import { readAssetSource } from '../dist/assets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = process.argv.length > 2 ? process.argv.slice(2).map(file => path.resolve(file)) :
  ['tone.wav','tone.mp3','clip.mp4','clip.webm'].map(file => path.join(root,'test/fixtures/media',file));
const assetRoots = [...new Set(sources.map(file => path.dirname(file)))];
const run = path.join(root,'.we-mcp/media-import-verification',randomUUID()),workspace = path.join(run,'data');
await fs.mkdir(run,{recursive:true});
const config = { workspace, projectRoots: [], assetRoots, timeoutMs: 1000 };
const argsFor = file => ({ sourceRoot: assetRoots.indexOf(path.dirname(file)), sourcePath: path.basename(file) });
const sourceHash = async file => { const a=argsFor(file);return hash(await readAssetSource(config,a.sourceRoot,a.sourcePath,40*1024*1024,'MEDIA_LIMIT')); };
const before = await Promise.all(sources.map(sourceHash)),configFile = path.join(run,'config.json');
await fs.writeFile(configFile,JSON.stringify(config));
const report = { sources, before, steps: [], passed: false, metadataOnly: true };
const client = new Client({ name: 'media-import-acceptance', version: '1' });
async function call(name,args) {
  const result=await client.callTool({name,arguments:args});
  report.steps.push({name,result:result.structuredContent});
  assert.ok(!result.isError,JSON.stringify(result.structuredContent));
  assert.ok(result.content.every(block=>block.type==='text'));
  return result.structuredContent;
}
try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js'),'--config',configFile],stderr:'inherit'}));
  const project=await call('we_project_create',{name:'media-acceptance',title:'Media import acceptance'});
  for(let i=0;i<sources.length;i++) {
    const args=argsFor(sources[i]),inspected=await call('we_media_inspect',args);
    assert.equal(inspected.media.sha256,before[i]);assert.equal(inspected.media.playability,'unverified');
    const targetPath='media/sample-'+i+'.'+inspected.media.container;
    const imported=await call('we_media_import',{...args,projectId:project.projectId,expectedRevision:project.revision,expectedSourceHash:before[i],targetPath});
    assert.equal(hash(await fs.readFile(path.join(project.path,targetPath))),before[i]);
    const restored=await call('we_project_restore',{projectId:project.projectId,expectedRevision:imported.revision,checkpointId:imported.checkpointId});
    assert.equal(restored.revision,project.revision);
    await assert.rejects(fs.access(path.join(project.path,targetPath)),{code:'ENOENT'});
  }
  report.passed=true;
} finally {
  await client.close();
  report.after=await Promise.all(sources.map(sourceHash));
  assert.deepEqual(report.after,before);
  await assert.rejects(fs.access(path.join(workspace,'server.lock')),{code:'ENOENT'});
  report.lockReleased=true;
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,metadataOnly:true,originalsUnchanged:true,lockReleased:true,report:path.join(run,'report.json')},null,2));
}
