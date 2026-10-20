import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Fault extends Error {
  constructor(public code: string, message: string, public details: unknown = undefined) { super(message); }
}
export const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export function relativeFile(value: string): string {
  const parts = value.split('/');
  if (!value || value.length > 240 || /[\\:\x00-\x1f<>"|?*]/.test(value) || parts.some(p =>
    !p || p === '.' || p === '..' || p.startsWith('.') || /[. ]$/.test(p) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) || ['node_modules'].includes(p.toLowerCase()))) {
    throw new Fault('INVALID_PATH', 'Only ordinary project-relative paths with forward slashes are allowed.');
  }
  return value;
}
export async function noLinks(target: string): Promise<void> {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Fault('UNSAFE_PATH', `Link/reparse path rejected: ${current}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export async function safeJoin(root: string, name: string): Promise<string> {
  relativeFile(name);
  const target = path.resolve(root, name);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Fault('INVALID_PATH', 'Path leaves project root.');
  await noLinks(target);
  return target;
}
export type Files = Map<string, Buffer>;
export async function readTree(root: string): Promise<Files> {
  await noLinks(root);
  const result: Files = new Map();
  let bytes = 0;
  async function walk(dir: string, prefix = '') {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      relativeFile(name);
      const target = await safeJoin(root, name);
      if (entry.isDirectory()) await walk(target, name + '/');
      else if (entry.isFile()) {
        const stat = await fs.stat(target);
        bytes += stat.size;
        if (bytes > 64 * 1024 * 1024 || result.size >= 2000) throw new Fault('PROJECT_TOO_LARGE', 'MVP limit: 64 MiB and 2000 files per project.');
        result.set(name, await fs.readFile(target));
      } else throw new Fault('UNSAFE_PATH', `Non-regular file: ${name}`);
    }
  }
  await walk(root);
  return result;
}
export function revision(files: Files): string {
  return hash(json([...files].map(([name, data]) => [name, hash(data)]).sort((a,b) => a[0]!.localeCompare(b[0]!))));
}
export async function writeTree(root: string, files: Files) {
  await noLinks(root);
  await fs.mkdir(root, { recursive: true });
  for (const [name, data] of files) {
    const target = await safeJoin(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { flag: 'wx' });
  }
}
export async function atomicWrite(target: string, data: string | Buffer) {
  await noLinks(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = target + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temp, data, { flag: 'wx' }); await fs.rename(temp, target); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
export function manifest(files: Files): Record<string, any> {
  try { return JSON.parse(files.get('project.json')!.toString('utf8')); }
  catch { throw new Fault('INVALID_PROJECT', 'Missing or malformed project.json.'); }
}
export interface Config {
  installDir?: string; workspace: string; projectRoots: string[]; devtoolsPort?: number | null; timeoutMs: number;
}
export async function loadConfig(file: string): Promise<Config> {
  const base = path.dirname(path.resolve(file));
  let input: any = {};
  try { input = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const config: Config = {
    installDir: input.installDir ? path.resolve(base, input.installDir) : undefined,
    workspace: path.resolve(base, input.workspace ?? '.we-mcp'),
    projectRoots: (input.projectRoots ?? []).map((root: string) => path.resolve(base, root)),
    devtoolsPort: input.devtoolsPort ?? null,
    timeoutMs: input.timeoutMs ?? 12000
  };
  if (config.devtoolsPort != null && (!Number.isInteger(config.devtoolsPort) || config.devtoolsPort < 1024 || config.devtoolsPort > 65535)) throw new Fault('CONFIG', 'devtoolsPort must be 1024..65535.');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 30000) throw new Fault('CONFIG', 'timeoutMs must be 1000..30000.');
  await noLinks(config.workspace);
  return config;
}
