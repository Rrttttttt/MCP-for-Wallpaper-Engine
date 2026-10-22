// Fault injection is confined to this test-owned process and its exact workspace.
import path from 'node:path';
import {createRequire,syncBuiltinESMExports} from 'node:module';

const fs=createRequire(import.meta.url)('node:fs/promises');
const original={...fs};
const root=path.resolve(process.env.WE_TEST_RECOVERY_WORKSPACE);
const archives=path.join(root,'lock-recoveries'),lock=path.join(root,'server.lock');
const selected=process.env.WE_TEST_RECOVERY_POINT;
const action=process.env.WE_TEST_RECOVERY_ACTION;
let recovering=false,reached=false;
const archiveFile=file=>typeof file==='string'&&path.dirname(path.dirname(file))===archives;
async function interrupt(point) {
  if(reached||point!==selected) return;
  reached=true;
  if(action==='throw') throw Object.assign(new Error('Injected recovery audit failure'),{code:'EIO'});
  await new Promise(resolve=>process.stderr.write('WE_TEST_RECOVERY_POINT:'+point+'\n',resolve));
  await new Promise(()=>{}); // The parent kills only this child after observing the boundary.
}

fs.mkdir=async function(file,...args) {
  const result=await original.mkdir(file,...args);
  if(typeof file==='string'&&path.dirname(file)===archives) recovering=true;
  if(recovering&&file===lock) await interrupt('new-lock-directory');
  return result;
};
fs.writeFile=async function(file,data,...args) {
  if(recovering&&file===path.join(lock,'owner.json')&&selected==='partial-owner') {
    await original.writeFile(file,Buffer.from(data).subarray(0,12),...args);
    await interrupt('partial-owner');
    throw new Error('Partial-owner checkpoint unexpectedly resumed');
  }
  const result=await original.writeFile(file,data,...args);
  if(recovering&&file===path.join(lock,'owner.json')) await interrupt('owner-written');
  if(archiveFile(file)) {
    if(path.basename(file)==='active-previews.json') await interrupt('registry-copied');
    if(/^record\.json\.[a-f0-9-]+\.tmp$/.test(path.basename(file))) {
      const state=JSON.parse(String(data)).state;
      if(state==='prepared'||state==='acquired') await interrupt(state+'-temporary');
    }
  }
  return result;
};
fs.rename=async function(from,to,...args) {
  let point;
  if(archiveFile(to)&&path.basename(to)==='record.json') point='audit-'+JSON.parse(await original.readFile(from,'utf8')).state;
  else if(from===lock&&archiveFile(to)&&path.basename(to)==='server.lock') point='lock-renamed';
  // Returned I/O failures are injected before commit; process kills occur after commit.
  if(action==='throw'&&point===selected) await interrupt(point);
  const result=await original.rename(from,to,...args);
  await interrupt(point);
  return result;
};
syncBuiltinESMExports();
