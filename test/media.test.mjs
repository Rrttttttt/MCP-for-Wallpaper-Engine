import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectMedia, importMedia, createVideo } from '../dist/media.js';
import { Projects } from '../dist/projects.js';
import { hash } from '../dist/files.js';

const fixtures = fileURLToPath(new URL('./fixtures/media/', import.meta.url));
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'we-mcp-media-'));
  const assets = path.join(dir, 'assets');
  await fs.cp(fixtures, assets, { recursive: true });
  const config = { workspace: path.join(dir, 'data'), projectRoots: [], assetRoots: [assets], timeoutMs: 1000 };
  const projects = new Projects(config); await projects.init();
  t.after(async () => {
    await projects.unlock();
    assert.ok(dir.startsWith(path.join(os.tmpdir(), 'we-mcp-media-')));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, assets, config, projects };
}

test('isolated real MediaInfo WASM probe reports bounded metadata for WAV/MP3/MP4/WebM', async t => {
  const { config, assets } = await fixture(t);
  for (const [name, container, kind] of [['tone.wav','wav','audio'],['tone.mp3','mp3','audio'],['clip.mp4','mp4','video'],['clip.webm','webm','video']]) {
    const report = (await inspectMedia(config, 0, name)).media;
    assert.equal(report.container, container); assert.equal(report.kind, kind);
    assert.equal(report.validation, 'metadata-only'); assert.equal(report.playability, 'unverified');
    assert.equal(report.sha256, hash(await fs.readFile(path.join(assets, name))));
    assert.ok(report.durationSeconds > 0.2 && report.durationSeconds < 0.5);
    if (kind === 'video') assert.deepEqual([report.video[0].width,report.video[0].height,report.video[0].frameRate], [64,48,10]);
    else assert.deepEqual([report.audio[0].channels,report.audio[0].sampleRate], [1,16000]);
    if (container === 'mp4') { assert.equal(report.audio.length, 1); assert.equal(report.video[0].rotation, 0); }
    assert.ok(!JSON.stringify(report).includes('PRIVATE-METADATA-SENTINEL'));
    assert.equal(report.parser.library.name, 'MediaInfoLib');
  }
});

test('binary media imports preserve bytes, refuse stale/unsafe overwrites and support checkpoint restore', async t => {
  const { projects, assets } = await fixture(t);
  const created = await projects.create('media', 'Media import');
  let revision = created.revision;
  for (const name of ['tone.wav','tone.mp3','clip.mp4','clip.webm']) {
    const bytes = await fs.readFile(path.join(assets, name));
    const args = { projectId: created.projectId, expectedRevision: revision, sourceRoot: 0, sourcePath: name, expectedSourceHash: hash(bytes), targetPath: 'media/' + name, overwrite: false };
    const saved = await importMedia(projects, args);
    assert.ok(saved.checkpointId); assert.equal(saved.originalBytesPreserved, true);
    assert.deepEqual(await fs.readFile(path.join(created.path, args.targetPath)), bytes);
    await assert.rejects(importMedia(projects, args), { code: 'REVISION_CONFLICT' });
    args.expectedRevision = saved.revision;
    await assert.rejects(importMedia(projects, args), { code: 'MEDIA_EXISTS' });
    await assert.rejects(importMedia(projects, { ...args, targetPath: 'Media/another.' + saved.media.container }), { code: 'INVALID_PATH' });
    await assert.rejects(importMedia(projects, { ...args, targetPath: 'entry.js' }), { code: 'MEDIA_EXTENSION' });
    await assert.rejects(importMedia(projects, { ...args, targetPath: 'media/changed.' + saved.media.container, expectedSourceHash: '0'.repeat(64) }), { code: 'SOURCE_CHANGED' });
    const same = await importMedia(projects, { ...args, overwrite: true });
    assert.equal(same.checkpointId, null); assert.equal(same.revision, saved.revision);
    if (name === 'tone.wav') {
      const changed = Buffer.from(bytes); changed[changed.length - 2] ^= 1;
      await fs.writeFile(path.join(assets,name),changed);
      await assert.rejects(importMedia(projects, { ...args, overwrite: true }), { code: 'SOURCE_CHANGED' });
      const overwritten = await importMedia(projects, { ...args, expectedSourceHash: hash(changed), overwrite: true });
      assert.deepEqual(await fs.readFile(path.join(created.path,args.targetPath)),changed);
      const undone = await projects.restore(created.projectId,overwritten.checkpointId,overwritten.revision);
      assert.equal(undone.revision,saved.revision);
      await fs.writeFile(path.join(assets,name),bytes);
    }
    const restored = await projects.restore(created.projectId, saved.checkpointId, saved.revision);
    assert.equal(restored.revision, revision);
    await assert.rejects(fs.access(path.join(created.path, args.targetPath)), { code: 'ENOENT' });
  }
  projects.config.projectRoots.push(created.path);
  const bytes = await fs.readFile(path.join(assets, 'tone.wav'));
  await assert.rejects(importMedia(projects, { projectId: 'root0', expectedRevision: revision, sourceRoot: 0, sourcePath: 'tone.wav', expectedSourceHash: hash(bytes), targetPath: 'tone.wav', overwrite: false }), { code: 'READ_ONLY_SOURCE' });
});

test('media probe rejects paths, links, oversize, unsupported/corrupt inputs, and cancelled saves', async t => {
  const { dir, assets, config, projects } = await fixture(t);
  await assert.rejects(inspectMedia({ ...config, assetRoots: [] }, 0, 'tone.wav'), { code: 'ASSET_ROOT_NOT_CONFIGURED' });
  for (const name of ['../tone.wav','C:/tone.wav','/tone.wav','a\\tone.wav']) await assert.rejects(inspectMedia(config, 0, name), { code: 'INVALID_PATH' });
  await fs.link(path.join(assets,'tone.wav'), path.join(dir,'linked.wav'));
  await assert.rejects(inspectMedia(config, 0, 'tone.wav'), { code: 'UNSAFE_PATH' });
  await fs.unlink(path.join(dir,'linked.wav'));
  await fs.symlink(dir, path.join(assets,'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectMedia(config, 0, 'outside/anything.wav'), { code: 'UNSAFE_PATH' });
  await fs.writeFile(path.join(assets,'oversize.wav'), 'x');
  await fs.truncate(path.join(assets,'oversize.wav'), 40 * 1024 * 1024 + 1);
  await assert.rejects(inspectMedia(config, 0, 'oversize.wav'), { code: 'MEDIA_LIMIT' });
  const wav = await fs.readFile(path.join(assets,'tone.wav'));
  await fs.writeFile(path.join(assets,'truncated.wav'), wav.subarray(0,100));
  await assert.rejects(inspectMedia(config, 0, 'truncated.wav'), { code: 'INVALID_MEDIA' });
  for (const [name, content] of [['fake.mp4',Buffer.from('not a media file')],['fake.webm',Buffer.from([26,69,223,163,0,0])],['fake.mp3',Buffer.from('ID3')]]) {
    await fs.writeFile(path.join(assets,name), content);
    await assert.rejects(inspectMedia(config, 0, name), { code: 'MEDIA_FORMAT' });
  }
  const created = await projects.create('cancel', 'Cancel import'), controller = new AbortController();
  controller.abort();
  await assert.rejects(importMedia(projects, { projectId: created.projectId, expectedRevision: created.revision, sourceRoot: 0, sourcePath: 'tone.wav', expectedSourceHash: hash(wav), targetPath: 'tone.wav', overwrite: false }, controller.signal), { code: 'MEDIA_CANCELLED' });
  assert.equal((await projects.inspect(created.projectId)).revision, created.revision);
});

test('native video creation uses inspected bytes, refuses audio, changes, duplicate names and cancelled writes', async t => {
  const { projects, assets, config } = await fixture(t);
  for (const [name, container] of [['clip.mp4','mp4'],['clip.webm','webm']]) {
    const data = await fs.readFile(path.join(assets,name));
    const args = { name:container,title:'Native '+container,sourceRoot:0,sourcePath:name,expectedSourceHash:hash(data) };
    await assert.rejects(createVideo(projects,{...args,expectedSourceHash:'0'.repeat(64)}),{code:'SOURCE_CHANGED'});
    await assert.rejects(createVideo(projects,{...args,name:'../escape'}),{code:'INVALID_NAME'});
    const created = await createVideo(projects,args);
    assert.equal(created.validation.valid,true); assert.equal(created.validation.engineVerification,'unverified');
    assert.equal(created.media.playability,'unverified'); assert.equal(created.manifest.type,'video');
    assert.equal(created.manifest.file,'wallpaper.'+container); assert.equal(created.files.length,2);
    assert.deepEqual(await fs.readFile(path.join(created.path,created.manifest.file)),data);
    const before = created.revision;
    await assert.rejects(createVideo(projects,args),{code:'EEXIST'});
    assert.equal((await projects.inspect(created.projectId)).revision,before);
    assert.deepEqual(await fs.readFile(path.join(assets,name)),data);
    const copy = await projects.create('copy-'+container,'Copy',{},created.projectId);
    assert.equal(copy.manifest.type,'video');
    const staged = await projects.publish(created.projectId,'new');
    assert.deepEqual(await fs.readFile(path.join(staged.directory,created.manifest.file)),data);
  }
  const tone = await fs.readFile(path.join(assets,'tone.wav'));
  await assert.rejects(createVideo(projects,{name:'audio',title:'Audio',sourceRoot:0,sourcePath:'tone.wav',expectedSourceHash:hash(tone)}),{code:'VIDEO_REQUIRED'});
  await assert.rejects(createVideo(projects,{name:'cancelled',title:'Cancelled',sourceRoot:0,sourcePath:'clip.mp4',expectedSourceHash:'0'.repeat(64)},AbortSignal.abort()),{code:'MEDIA_CANCELLED'});
  await assert.rejects(createVideo(new Projects({...config,assetRoots:[]}),{name:'disabled',title:'Disabled',sourceRoot:0,sourcePath:'clip.mp4',expectedSourceHash:'0'.repeat(64)}),{code:'ASSET_ROOT_NOT_CONFIGURED'});
  assert.deepEqual((await fs.readdir(projects.root)).sort(),['copy-mp4','copy-webm','mp4','webm']);
});
