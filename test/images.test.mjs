import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { inspectImage, importImage } from '../dist/images.js';
import { Projects } from '../dist/projects.js';
import { hash, loadConfig } from '../dist/files.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'we-mcp-image-'));
  const assets = path.join(dir, 'assets');
  await fs.mkdir(assets);
  const config = { workspace: path.join(dir, 'data'), projectRoots: [], assetRoots: [assets], timeoutMs: 1000 };
  const projects = new Projects(config);
  await projects.init();
  t.after(async () => {
    await projects.unlock();
    assert.ok(dir.startsWith(path.join(os.tmpdir(), 'we-mcp-image-')));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const png = await sharp({ create: { width: 16, height: 8, channels: 4, background: '#4488aacc' } }).png().toBuffer();
  await fs.writeFile(path.join(assets, 'source.png'), png);
  return { dir, assets, config, projects, png };
}

test('static image inspection, exact-byte import, explicit overwrite and checkpoint undo', async t => {
  const { projects, config, assets, png } = await fixture(t);
  const inspected = await inspectImage(config, 0, 'source.png');
  assert.deepEqual([inspected.image.width, inspected.image.height, inspected.image.hasAlpha, inspected.image.sha256], [16, 8, true, hash(png)]);
  const created = await projects.create('image', 'Image import');
  const args = { projectId: created.projectId, expectedRevision: created.revision, sourceRoot: 0, sourcePath: 'source.png', expectedSourceHash: hash(png), targetPath: 'images/source.png', overwrite: false };
  const imported = await importImage(projects, args);
  assert.equal(imported.originalBytesPreserved, true);
  assert.equal(imported.image.validation, 'decoded');
  assert.deepEqual(await fs.readFile(path.join(created.path, 'images/source.png')), png);
  assert.ok(imported.checkpointId);
  await assert.rejects(importImage(projects, args), { code: 'REVISION_CONFLICT' });
  args.expectedRevision = imported.revision;
  await assert.rejects(importImage(projects, args), { code: 'IMAGE_EXISTS' });
  await assert.rejects(importImage(projects, { ...args, targetPath: 'Images/other.png' }), { code: 'INVALID_PATH' });
  await assert.rejects(importImage(projects, { ...args, targetPath: 'images/SOURCE.png', overwrite: true }), { code: 'IMAGE_EXISTS' });
  await assert.rejects(importImage(projects, { ...args, targetPath: 'entry.js' }), { code: 'IMAGE_EXTENSION' });
  await assert.rejects(importImage(projects, { ...args, targetPath: 'wrong.jpg' }), { code: 'IMAGE_EXTENSION' });
  const newer = await sharp(png).negate().png().toBuffer();
  await fs.writeFile(path.join(assets, 'source.png'), newer);
  await assert.rejects(importImage(projects, { ...args, overwrite: true }), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(await fs.readFile(path.join(created.path, 'images/source.png')), png);
  const overwritten = await importImage(projects, { ...args, expectedSourceHash: hash(newer), overwrite: true });
  assert.deepEqual(await fs.readFile(path.join(created.path, 'images/source.png')), newer);
  const undone = await projects.restore(created.projectId, overwritten.checkpointId, overwritten.revision);
  assert.deepEqual(await fs.readFile(path.join(created.path, 'images/source.png')), png);
  const restored = await projects.restore(created.projectId, imported.checkpointId, undone.revision);
  assert.equal(restored.revision, created.revision);
  await assert.rejects(fs.access(path.join(created.path, 'images/source.png')), { code: 'ENOENT' });
  const emptyArgs = { ...args, expectedRevision: restored.revision, expectedSourceHash: hash(newer) };
  await assert.rejects(importImage(projects, { ...emptyArgs, targetPath: 'Images/other.png' }), { code: 'INVALID_PATH' });
  await fs.mkdir(path.join(created.path, 'directory.png'));
  await assert.rejects(importImage(projects, { ...emptyArgs, targetPath: 'directory.png', overwrite: true }), { code: 'IMAGE_EXISTS' });
  assert.equal((await projects.inspect(created.projectId)).revision, restored.revision);
});

test('JPEG orientation and WebP metadata are textual; corrupt and animated inputs are refused', async t => {
  const { config, assets, png } = await fixture(t);
  await fs.writeFile(path.join(assets, 'oriented.jpg'), await sharp(png).jpeg().withMetadata({ orientation: 6 }).toBuffer());
  const jpeg = (await inspectImage(config, 0, 'oriented.jpg')).image;
  assert.deepEqual([jpeg.format, jpeg.width, jpeg.height, jpeg.displayWidth, jpeg.displayHeight, jpeg.orientation, jpeg.hasAlpha], ['jpeg', 16, 8, 8, 16, 6, false]);
  await fs.writeFile(path.join(assets, 'image.webp'), await sharp(png).webp({ lossless: true }).toBuffer());
  const webp = (await inspectImage(config, 0, 'image.webp')).image;
  assert.equal(webp.format, 'webp'); assert.equal(webp.hasAlpha, true);
  const acTL = Buffer.alloc(20); acTL.writeUInt32BE(8); acTL.write('acTL', 4); acTL.writeUInt32BE(2, 8);
  const badInputs = [
    ['svg.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'IMAGE_FORMAT'],
    ['gif.png', Buffer.from('GIF89a'), 'IMAGE_FORMAT'],
    ['truncated.png', png.subarray(0, png.length - 20), 'INVALID_IMAGE'],
    ['animated.png', Buffer.concat([png.subarray(0, 33), acTL, png.subarray(33)]), 'IMAGE_FORMAT']
  ];
  for (const [name, data, code] of badInputs) {
    await fs.writeFile(path.join(assets, name), data);
    await assert.rejects(inspectImage(config, 0, name), { code });
  }
  await fs.writeFile(path.join(assets, 'animated.webp'), await sharp(Buffer.concat([Buffer.alloc(16, 40), Buffer.alloc(16, 200)]), { raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer());
  await assert.rejects(inspectImage(config, 0, 'animated.webp'), { code: 'IMAGE_FORMAT' });
});

test('image roots, paths, links and resource limits fail without modifying projects', async t => {
  const { dir, config, assets, projects } = await fixture(t);
  await assert.rejects(inspectImage({ ...config, assetRoots: [] }, 0, 'source.png'), { code: 'ASSET_ROOT_NOT_CONFIGURED' });
  for (const name of ['../source.png', 'C:/source.png', '/source.png', 'a\\source.png']) await assert.rejects(inspectImage(config, 0, name), { code: 'INVALID_PATH' });
  await fs.link(path.join(assets, 'source.png'), path.join(dir, 'hardlink.png'));
  await assert.rejects(inspectImage(config, 0, 'source.png'), { code: 'UNSAFE_PATH' });
  await fs.unlink(path.join(dir, 'hardlink.png'));
  await fs.symlink(dir, path.join(assets, 'outside'), 'junction');
  await assert.rejects(inspectImage(config, 0, 'outside/hardlink.png'), { code: 'UNSAFE_PATH' });
  await fs.writeFile(path.join(assets, 'large.png'), 'x');
  await fs.truncate(path.join(assets, 'large.png'), 21 * 1024 * 1024);
  await assert.rejects(inspectImage(config, 0, 'large.png'), { code: 'IMAGE_LIMIT' });
  await fs.writeFile(path.join(assets, 'wide.png'), await sharp({ create: { width: 8193, height: 1, channels: 3, background: '#fff' } }).png().toBuffer());
  await assert.rejects(inspectImage(config, 0, 'wide.png'), { code: 'IMAGE_LIMIT' });
  await fs.writeFile(path.join(assets, 'pixels.png'), await sharp({ create: { width: 4097, height: 4096, channels: 3, background: '#fff' } }).png().toBuffer());
  await assert.rejects(inspectImage(config, 0, 'pixels.png'), { code: 'INVALID_IMAGE' });
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({ assetRoots: ['./assets'] }));
  assert.deepEqual((await loadConfig(file)).assetRoots, [assets]);
  await fs.writeFile(file, JSON.stringify({ assetRoots: 'wrong' }));
  await assert.rejects(loadConfig(file), { code: 'CONFIG' });
  await fs.writeFile(file, JSON.stringify({}));
  assert.deepEqual((await loadConfig(file)).assetRoots, []);
  assert.equal((await projects.list()).total, 0);
});
