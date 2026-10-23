import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {imageSceneFiles} from '../dist/scene.js';
import {hash} from '../dist/files.js';

test('image Scene preserves originals, orients PNG output and binds two independent layers without user-coordinate assumptions',async()=>{
  const data=await sharp({create:{width:31,height:17,channels:3,background:'#334455'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const {files,image}=await imageSceneFiles(data,{speed:0,amplitude:0,lightVisible:false});
  assert.deepEqual(files.get('sources/original.jpg'),data);
  const png=await sharp(files.get('materials/mcp_background.png')).metadata();
  assert.deepEqual([png.width,png.height,png.space],[17,31,'srgb']);assert.equal(image.orientation,6);
  const scene=JSON.parse(files.get('scene.json')),p=JSON.parse(files.get('project.json'));
  assert.deepEqual(scene.general.orthogonalprojection,{width:17,height:31});assert.equal(scene.objects.length,2);
  assert.equal(scene.objects[0].origin,'8.5 15.5 0');assert.equal(p.general.properties.speed.value,0);
  assert.equal(p.general.properties.lightVisible.value,false);
  const ctx=vm.createContext({engine:{userProperties:{lightSize:9,lightVisible:true}}});
  for(const [field,value] of [['scale',{x:1,y:2,z:3}],['visible',false]]) {
    vm.runInContext(scene.objects[1][field].script.replace('export function','function'),ctx);
    const result=ctx.update(value);
    if(field==='scale') assert.deepEqual(result,{x:9/64,y:9/64,z:1});else assert.equal(result,true);
  }
  const light=await sharp(files.get('materials/mcp_orb.png')).raw().toBuffer();
  assert.equal(light[3],0);assert.ok(light[(32*64+32)*4+3]>200);
  await assert.rejects(imageSceneFiles(data,{lightSize:999}),{code:'INVALID_PROPERTY'});
});

async function fixture(t,mode='normal') {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'we-scene-image-')),workspace=path.join(dir,'data'),assets=path.join(dir,'assets'),install=path.join(dir,'engine');
  await fs.mkdir(assets);await fs.mkdir(path.join(install,'bin'),{recursive:true});
  await fs.writeFile(path.join(install,'bin','resourcecompiler64.exe'),'test preload boundary');
  const data=await sharp({create:{width:64,height:48,channels:3,background:'#6688aa'}}).png().toBuffer();
  await fs.writeFile(path.join(assets,'用户图片.png'),data);
  const config=path.join(dir,'config.json'),pidFile=path.join(dir,'compiler.pid');
  await fs.writeFile(config,JSON.stringify({workspace,installDir:install,assetRoots:[assets]}));
  const client=new Client({name:'scene-create-regression',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',new URL('./fixtures/scene-compiler.mjs',import.meta.url).href,fileURLToPath(new URL('../dist/index.js',import.meta.url)),'--config',config],stderr:'pipe',env:{...process.env,WE_TEST_SCENE_MODE:mode,WE_TEST_SCENE_PID:pidFile}});
  await client.connect(transport);transport.stderr?.resume();
  t.after(async()=>{await client.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'we-scene-image-')));await fs.rm(dir,{recursive:true,force:true})});
  async function call(name,args={},options) {const r=await client.callTool({name,arguments:args},options);assert.ok(r.content.every(c=>c.type==='text'));return r}
  const args={name:'photo',title:'Photo Scene',sourceRoot:0,sourcePath:'用户图片.png',expectedSourceHash:hash(data)};
  async function pid() {
    for(let i=0;i<120;i++){const p=await fs.readFile(pidFile,'utf8').catch(()=>null);if(p)return Number(p);await new Promise(r=>setTimeout(r,25))}
    throw new Error('Test compiler did not start');
  }
  return {client,workspace,data,assets,args,call,pid};
}

test('real MCP Scene creation writes one validated candidate, refuses stale hashes/existing names, and stages a complete asset chain',{skip:process.platform!=='win32'},async t=>{
  const {call,args,data,assets}=await fixture(t);
  const inspected=await call('we_image_inspect',{sourceRoot:0,sourcePath:'用户图片.png'});assert.equal(inspected.structuredContent.image.sha256,hash(data));
  assert.equal((await call('we_scene_create',{...args,expectedSourceHash:'0'.repeat(64)})).structuredContent.error.code,'SOURCE_CHANGED');
  const response=await call('we_scene_create',args);assert.equal(response.isError,undefined,JSON.stringify(response.structuredContent));
  const p=response.structuredContent;assert.equal(p.manifest.type,'scene');assert.equal(p.validation.valid,true);
  assert.equal(p.validation.engineVerification,'unverified');assert.equal(p.validation.sceneDependencies.length,6);
  assert.ok(p.validation.sceneDependencies.every(d=>d.status==='local'));assert.equal(p.compilation.textures.length,2);
  assert.deepEqual(await fs.readFile(path.join(p.path,'sources/original.png')),data);
  assert.equal((await call('we_scene_create',args)).structuredContent.error.code,'PROJECT_EXISTS');
  const edited=await call('we_project_apply',{projectId:p.projectId,expectedRevision:p.revision,changes:[{path:'notes.txt',content:'change'}]});
  const restored=await call('we_project_restore',{projectId:p.projectId,expectedRevision:edited.structuredContent.revision,checkpointId:edited.structuredContent.checkpointId});
  assert.equal(restored.structuredContent.revision,p.revision);
  const staged=(await call('we_publish_prepare',{projectId:p.projectId})).structuredContent;
  assert.deepEqual(await fs.readFile(path.join(staged.directory,'sources/original.png')),data);
  assert.deepEqual(await fs.readFile(path.join(assets,'用户图片.png')),data);
});

for(const [mode,code] of [['failure','TEXTURE_COMPILE_FAILED'],['overflow','TEXTURE_COMPILE_FAILED'],['corrupt','INVALID_TEXTURE'],['oversize','TEXTURE_LIMIT']])
  test('compiler '+mode+' leaves no new project or build directory',{skip:process.platform!=='win32'},async t=>{
    const {workspace,args,call}=await fixture(t,mode);
    const failed=await call('we_scene_create',args);assert.equal(failed.structuredContent.error.code,code);
    assert.deepEqual(await fs.readdir(path.join(workspace,'projects')),[]);assert.deepEqual(await fs.readdir(path.join(workspace,'scene-builds')),[]);
    assert.equal((await call('we_workspace_diagnose')).structuredContent.mode,'owner');
  });

test('stalled official-compiler boundary is actually killed at the fixed deadline and the MCP session remains usable',{skip:process.platform!=='win32'},async t=>{
  const {workspace,args,call,pid}=await fixture(t,'stall'),started=performance.now();
  const pending=call('we_scene_create',args,{timeout:40000}),worker=await pid(),failed=await pending;
  assert.equal(failed.structuredContent.error.code,'TEXTURE_COMPILE_FAILED');
  assert.ok(performance.now()-started>=29000&&performance.now()-started<35000);
  assert.throws(()=>process.kill(worker,0),{code:'ESRCH'});
  assert.deepEqual(await fs.readdir(path.join(workspace,'projects')),[]);assert.deepEqual(await fs.readdir(path.join(workspace,'scene-builds')),[]);
  assert.equal((await call('we_workspace_diagnose')).structuredContent.mode,'owner');
});

for(const end of ['cancel','EOF']) test('Scene compiler '+end+' terminates the active worker without saving a project',{skip:process.platform!=='win32'},async t=>{
  const {client,workspace,args,call,pid}=await fixture(t,'stall'),controller=new AbortController();
  const pending=call('we_scene_create',args,{signal:controller.signal}).catch(()=>null),worker=await pid(),start=performance.now();
  if(end==='cancel') controller.abort();else await client.close();
  await pending;
  if(end==='cancel') assert.equal((await call('we_workspace_diagnose')).structuredContent.mode,'owner');
  else await assert.rejects(fs.access(path.join(workspace,'server.lock')),{code:'ENOENT'});
  assert.ok(performance.now()-start<3500,'Cancellation must not wait for the 30 second compiler deadline');
  assert.throws(()=>process.kill(worker,0),{code:'ESRCH'});
  assert.deepEqual(await fs.readdir(path.join(workspace,'projects')),[]);assert.deepEqual(await fs.readdir(path.join(workspace,'scene-builds')),[]);
});
