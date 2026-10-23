// Real STDIO acceptance using a user-selected local image. Writes only a fresh workspace.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hash } from '../dist/files.js';

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-image-import.mjs <local PNG/JPEG/WebP>');
const source = path.resolve(process.argv[2]), before = hash(await fs.readFile(source));
const root = fileURLToPath(new URL('../', import.meta.url));
const run = path.join(root, '.we-mcp', 'image-import-verification', randomUUID());
await fs.mkdir(run, { recursive: true });
const config = path.join(run, 'config.json');
await fs.writeFile(config, JSON.stringify({ workspace: path.join(run, 'data'), assetRoots: [path.dirname(source)] }));
const client = new Client({ name: 'image-import-acceptance', version: '1' });
const report = { source, sourceBefore: before, startedAt: new Date().toISOString(), steps: [], passed: false };
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(response.content.every(block => block.type === 'text'));
  report.steps.push({ name, result: response.structuredContent });
  assert.ok(!response.isError, JSON.stringify(response.structuredContent));
  return response.structuredContent;
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/index.js'), '--config', config], stderr: 'inherit' }));
  const image = await call('we_image_inspect', { sourceRoot: 0, sourcePath: path.basename(source) });
  assert.equal(image.image.sha256, before);
  const project = await call('we_project_create', { name: 'image-acceptance', title: 'Image import acceptance' });
  const extension = { png: 'png', jpeg: 'jpg', webp: 'webp' }[image.image.format];
  const targetPath = 'images/imported.' + extension;
  const imported = await call('we_image_import', { projectId: project.projectId, expectedRevision: project.revision,
    sourceRoot: 0, sourcePath: path.basename(source), expectedSourceHash: before, targetPath });
  assert.equal(hash(await fs.readFile(path.join(project.path, targetPath))), before);
  const restored = await call('we_project_restore', { projectId: project.projectId, expectedRevision: imported.revision, checkpointId: imported.checkpointId });
  assert.equal(restored.revision, project.revision);
  await assert.rejects(fs.access(path.join(project.path, targetPath)), { code: 'ENOENT' });
  report.passed = true;
} finally {
  await client.close();
  report.sourceAfter = hash(await fs.readFile(source));
  report.passed &&= report.sourceAfter === before;
  report.lockReleased = await fs.access(path.join(run, 'data', 'server.lock')).then(() => false, e => { if (e.code === 'ENOENT') return true; throw e; });
  report.passed &&= report.lockReleased;
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, report: path.join(run, 'report.json'), image: report.steps[0]?.result.image, sourceUnchanged: report.sourceAfter === before, lockReleased: report.lockReleased }, null, 2));
}
assert.equal(report.passed, true);
