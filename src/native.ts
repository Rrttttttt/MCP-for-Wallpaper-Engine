import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Fault, noLinks } from './files.js';

export interface WindowIdentity {
  handle: string; processId: number; startTime: string; processPath: string; className: string;
}
const helper = fileURLToPath(new URL('../native/WeCapture/bin/publish/WeCapture.exe', import.meta.url));
export async function nativeAvailable() {
  if (process.platform !== 'win32') return false;
  await noLinks(helper);
  try { return (await fs.stat(helper)).isFile(); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}

// A short-lived helper owns the D3D/WinRT resources, including on hard timeout.
// Paths and target identities come from the server, never from a public MCP argument.
export async function nativeCall(operation: string, request: Record<string, unknown> = {}, timeoutMs = 8000): Promise<any> {
  if (!await nativeAvailable()) throw new Fault('NATIVE_CAPTURE_UNAVAILABLE', 'Build the Windows x64 helper with npm run build:native.');
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe'] });
    const chunks: Buffer[] = []; let size = 0, errors = '', settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Fault('NATIVE_CAPTURE_TIMEOUT', 'Native helper exceeded its operation deadline.')), timeoutMs + 2000);
    child.on('error', e => finish(e));
    child.stdin.on('error', e => finish(e));
    child.stdout.on('data', (data: Buffer) => {
      size += data.length;
      if (size > 28 * 1024 * 1024) finish(new Fault('NATIVE_OUTPUT_LIMIT', 'Native helper output exceeded 28 MiB.'));
      else chunks.push(data);
    });
    child.stderr.on('data', data => { errors = (errors + String(data)).slice(0,4096); });
    child.on('close', code => {
      if (settled) return;
      try {
        if (code !== 0) throw new Fault('NATIVE_CAPTURE_FAILED', `Native helper exited ${code}.`, { stderr: errors });
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.error) throw new Fault(result.error.code, result.error.message, { hresult: result.error.hresult });
        finish(undefined, result);
      } catch(e) { finish(e as Error); }
    });
    child.stdin.end(JSON.stringify({ ...request, operation, timeoutMs }));
  });
}

export function pngInfo(data: Buffer) {
  if (data.length < 24 || data.length > 20 * 1024 * 1024 || !data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || data.toString('ascii',12,16) !== 'IHDR')
    throw new Fault('INVALID_SCREENSHOT', 'Capture did not return a bounded PNG.');
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216)
    throw new Fault('CAPTURE_SIZE_LIMIT', 'PNG exceeds the physical frame size limit.');
  return { width, height, bytes: data.length };
}
