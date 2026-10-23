import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Projects, validate } from '../dist/projects.js';

function web(html = '<script src="wallpaper.js"></script>', script = 'function (') {
  return new Map([
    ['project.json', Buffer.from(JSON.stringify({ type: 'web', title: 'Syntax audit', file: 'index.html' }))],
    ['index.html', Buffer.from(html)], ['wallpaper.js', Buffer.from(script)]
  ]);
}

test('audit repro: malformed wallpaper.js fails shared static validation', () => {
  const result = validate(web());
  assert.equal(result.valid, false, 'function ( must not be accepted as a valid Web script');
  assert.match(result.errors.join('\n'), /wallpaper\.js/);
});

test('audit repro: invalid JS apply is rejected before checkpoints or project writes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'we-mcp-js-'));
  const projects = new Projects({ workspace: directory, projectRoots: [], timeoutMs: 1000 });
  await projects.init();
  t.after(async () => {
    await projects.unlock();
    assert.ok(directory.startsWith(path.join(os.tmpdir(), 'we-mcp-js-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const created = await projects.create('syntax', 'Syntax audit');
  const checkpoints = () => fs.readdir(path.join(directory, 'checkpoints')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const before = await checkpoints();
  await assert.rejects(projects.apply(created.projectId, created.revision, [{ path: 'wallpaper.js', content: 'function (' }]), { code: 'VALIDATION_FAILED' });
  assert.equal((await projects.inspect(created.projectId)).revision, created.revision);
  assert.deepEqual(await checkpoints(), before);
});

test('Web scripts use their HTML loading mode, preserve inline locations and never execute', () => {
  const cases = [
    ['classic rejects export', '<script src="wallpaper.js"></script>', 'export const x = 1;', false],
    ['module accepts export', '<SCRIPT TYPE="module" SRC="wallpaper.js?v=1&amp;x=2"></SCRIPT>', 'export const x = await Promise.resolve(1);', true],
    ['classic allows sloppy with', '<script src="wallpaper.js"></script>', 'with ({x:1}) { void x; }', true],
    ['module remains strict', '<script type="module" src="wallpaper.js"></script>', 'with ({x:1}) { void x; }', false],
    ['classic rejects top-level await', '<script src="wallpaper.js"></script>', 'await Promise.resolve(1);', false],
    ['both contexts are checked', '<script type="module" src="wallpaper.js"></script><script src="wallpaper.js"></script>', 'export const x = 1;', false],
    ['inline JS rejects invalid syntax', '<script>function (</script>', ';', false],
    ['quoted tag terminator', '<script data-note=">">function (</script>', ';', false],
    ['inline module', '<script type="module">export const value = await Promise.resolve(1);</script>', ';', true],
    ['non-JS data and GLSL', '<script type="application/json">function (</script><script type="x-shader/x-fragment">void main() {}</script>', ';', true],
    ['inert template and comment', '<!-- <script>function (</script> --><template><script>function (</script></template>', ';', true],
    ['external src ignores inline text', '<script src="wallpaper.js">function (</script>', ';', true],
    ['legacy JS type', '<script type="text/javascript1.5">function (</script>', ';', false],
    ['parse only', '<script src="wallpaper.js"></script>', 'globalThis.__weSyntaxExecuted = true; throw new Error("must not execute");', true]
  ];
  for (const [name, html, script, expected] of cases) {
    const result = validate(web(html, script));
    assert.equal(result.valid, expected, name + ': ' + result.errors.join('\n'));
    assert.equal(result.engineVerification, 'unverified');
    assert.equal(result.javascript.runtime, 'unverified');
  }
  assert.equal(globalThis.__weSyntaxExecuted, undefined);
  const located = validate(web('<!doctype html>\n<script>\nconst value = ;\n</script>', ';'));
  const error = located.javascript.issues.find(issue => issue.file === 'index.html');
  assert.deepEqual([error.code, error.line, error.column], ['JS_SYNTAX', 3, 15]);
  assert.match(located.errors.join('\n'), /index\.html:3:15/);
  const modules = web('', 'export const entry = 1;');
  modules.set('child.mjs', Buffer.from('export const child = await Promise.resolve(2);'));
  const valid = validate(modules);
  assert.equal(valid.valid, true);
  assert.equal(valid.javascript.checked.find(source => source.file === 'wallpaper.js').mode, 'script-or-module');
  assert.equal(valid.javascript.checked.find(source => source.file === 'child.mjs').mode, 'module');
  modules.set('child.mjs', Buffer.from('function ('));
  assert.equal(validate(modules).valid, false);
});

test('syntax inspection is bounded, rejects unsafe references and leaves SceneScript/GLSL untouched', () => {
  for (const src of ['../outside.js', '/wallpaper.js', 'wallpaper%ZZ.js', 'shader.txt']) {
    assert.equal(validate(web('<script src="' + src + '"></script>', ';')).valid, false, src);
  }
  const external = validate(web('<script src="https://example.invalid/remote.js"></script>', ';'));
  assert.equal(external.valid, true);
  assert.match(external.warnings.join('\n'), /not fetched or syntax-checked/);
  const large = validate(web('', ';'.repeat(1024 * 1024 + 1)));
  assert.equal(large.valid, false); assert.equal(large.javascript.issues[0].code, 'JS_CHECK_LIMIT');
  const aggregate = web('', ';');
  for (let i = 0; i < 9; i++) aggregate.set('part' + i + '.js', Buffer.alloc(1024 * 1024, 59));
  assert.equal(validate(aggregate).javascript.issues[0].code, 'JS_CHECK_LIMIT');
  const many = validate(web('<script>void 0;</script>'.repeat(257), ';'));
  assert.equal(many.valid, false); assert.ok(many.javascript.checked.length <= 256);
  const invalid = validate(web('<script>function (</script>'.repeat(200), ';'));
  assert.equal(invalid.valid, false); assert.equal(invalid.javascript.issues.length, 64);
  const scene = new Map([
    ['project.json', Buffer.from(JSON.stringify({ type: 'scene', title: 'Scene language boundary', file: 'scene.json' }))],
    ['scene.json', Buffer.from(JSON.stringify({ objects: [], script: 'export function update() { return new Vec3(0); }' }))],
    ['scene-script.js', Buffer.from('SceneScript must not use the Web parser')],
    ['shader.frag', Buffer.from('void main() { gl_FragColor = vec4(1.0); }')]
  ]);
  assert.equal(validate(scene).valid, true);
  assert.equal(validate(scene).javascript, undefined);
});

test('pathological parser input cannot keep the validation process blocked indefinitely', { timeout: 10000 }, () => {
  // Reduced from upstream Acorn #1445, below the source-size budget but expensive to parse.
  const term = '(?:'.repeat(340) + '(?<x>a)' + ')'.repeat(340);
  const source = '/' + Array(700).fill(term).join('|') + '/v;';
  assert.ok(Buffer.byteLength(source) < 1024 * 1024);
  const started = performance.now(), report = validate(web('', source));
  assert.ok(performance.now() - started < 6500);
  assert.equal(report.valid, false);
  assert.equal(report.javascript.issues[0].code, 'JS_CHECK_TIMEOUT');
  assert.equal(validate(web('', 'const healthy = true;')).valid, true);
});
