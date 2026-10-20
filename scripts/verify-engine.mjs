// Explicit integration run: starts and closes isolated official-engine preview windows.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../',import.meta.url));
const client = new Client({name:'official-engine-verification',version:'1'});
const transport = new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js')],stderr:'inherit'});
const report = { startedAt:new Date().toISOString(), steps:[] };
const active = new Set();
async function call(name,args={}) {
  const response = await client.callTool({name,arguments:args},undefined,{timeout:60000});
  const result = response.structuredContent ?? JSON.parse(response.content.find(c=>c.type==='text').text);
  report.steps.push({tool:name,result});
  console.log(name + ': ' + (result.state ?? result.revision ?? result.error?.code ?? 'ok'));
  if (response.isError) throw new Error(JSON.stringify(result));
  return result;
}
try {
  await client.connect(transport);
  await call('we_environment_probe');
  const list = await call('we_project_list');
  let project;
  if (list.projects.some(p=>p.projectId==='managed/stage0-starfield')) project = await call('we_project_inspect',{projectId:'managed/stage0-starfield',readFiles:['project.json']});
  else project = await call('we_project_create',{name:'stage0-starfield',title:'Audio Starfield — integration sample'});
  await call('we_project_validate',{projectId:project.projectId});
  let preview = await call('we_preview_open',{projectId:project.projectId,width:1280,height:720}); active.add(preview.previewId);
  await call('we_preview_set_properties',{previewId:preview.previewId,properties:{speed:0.7,density:240}});
  const firstObservation = await call('we_preview_observe',{previewId:preview.previewId,count:3,intervalMs:600});
  if (firstObservation.images.length !== 3 || firstObservation.evidence?.diagnostics?.settings?.speed !== 0.7 || firstObservation.evidence?.diagnostics?.settings?.density !== 240) throw new Error('Live properties or multi-frame capture did not verify.');
  const source = project.contents?.['project.json'] ? JSON.parse(project.contents['project.json']) : project.manifest;
  source.general.properties.speed.value = 0.7; source.general.properties.density.value = 240;
  const applied = await call('we_project_apply',{projectId:project.projectId,expectedRevision:project.revision,changes:[{path:'project.json',content:JSON.stringify(source,null,2)+'\n'}]});
  await call('we_preview_close',{previewId:preview.previewId}); active.delete(preview.previewId);
  preview = await call('we_preview_open',{projectId:project.projectId,width:1280,height:720}); active.add(preview.previewId);
  if (preview.revision !== applied.revision) throw new Error('Reloaded source revision mismatch.');
  const reloaded = await call('we_preview_observe',{previewId:preview.previewId,count:2,intervalMs:600,reload:true});
  if (reloaded.images.length !== 2 || reloaded.evidence?.diagnostics?.settings?.speed !== 0.7 || reloaded.evidence?.diagnostics?.settings?.density !== 240 || reloaded.evidence?.diagnostics?.errors?.length) throw new Error('Saved defaults or clean runtime did not survive full host reload.');
  const frames = await Promise.all(reloaded.images.map(f=>fs.readFile(f)));
  if (frames[0].equals(frames[1])) throw new Error('Animation frames did not change.');
  await call('we_publish_prepare',{projectId:project.projectId,intent:'new'});
} catch(e) { report.error = e.message; process.exitCode = 1; }
finally {
  for (const previewId of active) { try { await call('we_preview_close',{previewId}); } catch(e) { console.error(e.message); } }
  await client.close();
  report.finishedAt = new Date().toISOString();
  const target = path.join(root,'.we-mcp','integration-report.json');
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,JSON.stringify(report,null,2)+'\n');
  console.log('Report: '+target);
}
