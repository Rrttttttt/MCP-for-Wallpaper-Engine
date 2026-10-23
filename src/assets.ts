import * as fs from 'node:fs/promises';
import { Fault, safeJoin, relativeFile, readTree, revision, type Config } from './files.js';
import type { Projects } from './projects.js';

export interface AssetImport {
  projectId: string; expectedRevision: string; sourceRoot: number; sourcePath: string;
  expectedSourceHash: string; targetPath: string; overwrite: boolean;
}

export async function readAssetSource(config: Config, sourceRoot: number, sourcePath: string, maxBytes: number, limitCode: string) {
  const root = config.assetRoots?.[sourceRoot];
  if (!Number.isInteger(sourceRoot) || sourceRoot < 0 || !root) throw new Fault('ASSET_ROOT_NOT_CONFIGURED', 'Select an index from configured assetRoots; no directories are enabled by default.');
  const handle = await fs.open(await safeJoin(root, sourcePath), 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Fault('UNSAFE_PATH', 'Asset source must be a regular file without extra hard links.');
    if (before.size < 1 || before.size > maxBytes) throw new Fault(limitCode, `Source must be 1 byte..${maxBytes / 1024 / 1024} MiB.`);
    // Read at most the sampled size plus one byte, even if another process grows the file.
    const data = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await handle.read(data, length, data.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Fault('SOURCE_CHANGED', 'Source changed while reading; inspect again.');
    return data.subarray(0, length);
  } finally { await handle.close(); }
}

export async function prepareAssetImport(projects: Projects, args: AssetImport, existsCode: string) {
  relativeFile(args.targetPath);
  const root = await projects.resolve(args.projectId, true), next = await readTree(root);
  if (revision(next) !== args.expectedRevision) throw new Fault('REVISION_CONFLICT', 'Project changed; inspect again before importing.');
  const existing = [...next.keys()].find(name => name.toLowerCase() === args.targetPath.toLowerCase());
  if (existing && (existing !== args.targetPath || !args.overwrite)) throw new Fault(existsCode, 'Destination already exists; use its exact spelling and explicitly enable overwrite.');
  const parts = args.targetPath.split('/');
  for (let i = 0; i < parts.length; i++) {
    const parent = i === 0 ? root : await safeJoin(root, parts.slice(0, i).join('/'));
    const names = await fs.readdir(parent).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
    const actual = names.find(name => name.toLowerCase() === parts[i]!.toLowerCase());
    if (actual && actual !== parts[i]) throw new Fault('INVALID_PATH', 'Destination spelling must match existing files and directories.');
  }
  const target = await safeJoin(root, args.targetPath);
  const stat = await fs.lstat(target).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
  if (stat && !stat.isFile()) throw new Fault(existsCode, 'Destination is not a regular asset file.');
  return next;
}
