// Test-only compiler process. Real engine compilation is exercised separately by verify-image-scene.mjs.
import {fileURLToPath} from 'node:url';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const self=fileURLToPath(import.meta.url);
if(process.argv[1]===self) {
  const mode=process.env.WE_TEST_SCENE_MODE;
  await fs.writeFile(process.env.WE_TEST_SCENE_PID,String(process.pid));
  if(mode==='stall') {setInterval(()=>{},1000);await new Promise(()=>{})}
  if(mode==='failure') process.exit(17);
  if(mode==='overflow') {process.stdout.write('x'.repeat(128*1024));process.exit(0)}
  const output=process.argv[2];
  if(mode==='oversize') {await fs.writeFile(output,'x');await fs.truncate(output,33*1024*1024+1);process.exit(0)}
  await fs.writeFile(output,mode==='corrupt'?Buffer.from('broken TEX'):await fs.readFile(new URL('../../templates/scene-orbit/materials/mcp_orb.tex',import.meta.url)));
} else {
  const cp=createRequire(import.meta.url)('node:child_process'),original=cp.execFile;
  cp.execFile=function(command,args,options,callback) {
    if(path.basename(command)==='resourcecompiler64.exe') {
      assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.timeout,30000);assert.equal(options.maxBuffer,64*1024);
      assert.equal(args[0],'-tex');assert.equal(args[1],'-i');assert.equal(args[3],'-o');assert.equal(args.length,5);
      assert.ok(/materials\/mcp_(background|orb)\.png$/.test(args[2]));
      return original(process.execPath,[self,args[4]],options,callback);
    }
    return original(command,args,options,callback);
  };
  syncBuiltinESMExports();
}
