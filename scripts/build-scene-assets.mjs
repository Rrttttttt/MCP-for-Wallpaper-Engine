// Recompile the bundled original PNG with the user's official engine. No compiler is redistributed.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, noLinks, atomicWrite, hash, readTree, writeTree } from '../dist/files.js';
const root = fileURLToPath(new URL('../',import.meta.url));
const flag = process.argv.indexOf('--config');
const config = await loadConfig(flag >= 0 ? path.resolve(process.argv[flag+1]) : path.join(root,'we.config.json'));
if (process.platform !== 'win32' || !config.installDir) throw new Error('Requires Windows and configured installDir.');
const compiler = path.join(config.installDir,'bin','resourcecompiler64.exe');
await noLinks(compiler);
const template = path.join(root,'templates','scene-orbit');
await noLinks(config.workspace);
await fs.mkdir(config.workspace,{recursive:true});
const scratch = await fs.mkdtemp(path.join(config.workspace,'scene-assets-'));
try {
  // Preserve the official project/materials layout rather than compiling a loose image.
  await writeTree(scratch,await readTree(template));
  const source = path.join(scratch,'materials','mcp_orb.png'), output = path.join(scratch,'materials','mcp_orb.tex');
  await fs.rm(output,{force:true});
  // Match the forward-slash paths used by the official editor/compiler invocation.
  const result = await promisify(execFile)(compiler,['-tex','-i',source.replaceAll('\\','/'),'-o',output.replaceAll('\\','/')],{cwd:config.installDir,windowsHide:true,shell:false,timeout:30000,maxBuffer:64*1024});
  const data = await fs.readFile(output);
  if (data.length < 32 || data.length > 4*1024*1024 || data.toString('ascii',0,8) !== 'TEXV0005') throw new Error('Compiler did not produce a bounded TEXV0005 texture.');
  const target = path.join(template,'materials','mcp_orb.tex');
  await noLinks(target);
  await atomicWrite(target,data);
  console.log(JSON.stringify({compiler,compilerSha256:hash(await fs.readFile(compiler)),sourceSha256:hash(await fs.readFile(source)),outputSha256:hash(data),bytes:data.length,stdout:result.stdout.trim()},null,2));
} finally {
  // mkdtemp returns a unique child of the configured workspace; never remove a computed parent.
  const relative = path.relative(config.workspace,scratch);
  if (relative.startsWith('scene-assets-') && !relative.includes(path.sep)) await fs.rm(scratch,{recursive:true,force:true});
}
