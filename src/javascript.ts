import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Files } from './files.js';
import type { parseWebJavaScript } from './javascript-parser.js';

type Report = ReturnType<typeof parseWebJavaScript>;
export function checkWebJavaScript(files: Files): Report {
  const failed = (code: string, file: string, message: string): Report => ({ status: 'failed', parser: 'acorn (isolated)', checked: [],
    issues: [{ code, file, message }], warnings: [], runtime: 'unverified' });
  const sources: [string, string][] = [];
  let bytes = 0;
  for (const [file, data] of files) {
    if (!/\.(?:html?|js|mjs)$/i.test(file)) continue;
    bytes += data.length;
    if (data.length > 1024 * 1024 || bytes > 8 * 1024 * 1024) return failed('JS_CHECK_LIMIT', file, 'Syntax inspection limit: 1 MiB per HTML/script and 8 MiB total input.');
    sources.push([file, data.toString('base64')]);
  }
  // Keep the synchronous validate API; a bounded child protects it from parser CPU/memory exhaustion.
  const result = spawnSync(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('./javascript-parser.js', import.meta.url)), '--parse-stdin'], {
    input: JSON.stringify(sources), encoding: 'utf8', shell: false, windowsHide: true, timeout: 3000, maxBuffer: 128 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
  });
  if (result.error || result.status !== 0) return failed((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'JS_CHECK_TIMEOUT' : 'JS_CHECK_FAILED', '(Web sources)', 'Syntax parser did not complete within its process/resource limits; no syntax pass was recorded.');
  try { return JSON.parse(result.stdout); }
  catch { return failed('JS_CHECK_FAILED', '(Web sources)', 'Syntax parser returned an invalid report.'); }
}
