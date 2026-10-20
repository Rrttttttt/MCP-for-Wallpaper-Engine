import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Fault, type Config, type Files, noLinks, readTree, writeTree, revision, manifest, atomicWrite, json } from './files.js';
import { Projects, validate, checkProperties } from './projects.js';
import { Cdp, endpoint, findTarget, matchesProject } from './cdp.js';

const execFileAsync = promisify(execFile);
interface Preview {
  previewId: string; projectId: string; revision: string; directory: string; windowName: string;
  width: number; height: number; cdp?: Cdp; capabilities?: unknown; files: Files;
}
export const openArgs = (file: string, name: string, width: number, height: number) => ['-control','openWallpaper','-file',file,'-playInWindow',name,'-width',String(width),'-height',String(height)];
export const propertyArgs = (name: string, values: Record<string, unknown>) => {
  const payload = JSON.stringify(values);
  if (payload.includes(')~END') || payload.includes('RAW~(')) throw new Fault('INVALID_PROPERTY','Property text contains reserved CLI delimiters.');
  if (!/^WE-MCP-[\da-f-]{36}$/.test(name)) throw new Fault('INVALID_PREVIEW','Properties require a generated preview window name.');
  return ['-control','applyProperties','-location',name,'-properties',`RAW~(${payload})~END`];
};
export class Engine {
  private previews = new Map<string, Preview>();
  constructor(private config: Config, private projects: Projects) {}
  async executable() {
    if (!this.config.installDir) throw new Fault('ENGINE_NOT_CONFIGURED','Set installDir in we.config.json.');
    for (const name of ['wallpaper32.exe','wallpaper64.exe']) {
      const file = path.join(this.config.installDir, name);
      await noLinks(file);
      try { if ((await fs.stat(file)).isFile()) return file; } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    throw new Fault('ENGINE_NOT_FOUND','No official Wallpaper Engine executable in configured directory.');
  }
  async cli(args: string[]) {
    if (process.platform !== 'win32') throw new Fault('WINDOWS_REQUIRED','Official engine integration requires Windows.');
    // WE parses RAW delimiters directly from the Windows command line. CRT escaping would insert backslashes into JSON.
    // Only this fixed command (generated window name + delimiter-checked JSON) bypasses Node's CRT quoting; no shell is used.
    const result = await execFileAsync(await this.executable(), args, { cwd: this.config.installDir, windowsHide: true, shell: false, windowsVerbatimArguments: args[1] === 'applyProperties', timeout: this.config.timeoutMs, maxBuffer: 256 * 1024 });
    return { stdout: result.stdout.trim(), stderr: result.stderr.slice(0,4096) };
  }
  async probe() {
    let executable: string | undefined, version: unknown, cliReason: string | undefined;
    try { executable = await this.executable(); } catch(e) { cliReason = (e as Error).message; }
    try { version = JSON.parse(await fs.readFile(path.join(this.config.installDir!, 'version.json'),'utf8')).version; } catch { /* optional version file */ }
    let cdp: any = { status: 'unavailable', reason: 'No devtoolsPort configured; engine settings are never changed automatically.' };
    if (this.config.devtoolsPort) {
      try { cdp = { status: 'supported', discovery: await endpoint(this.config.devtoolsPort, '/json/version'), methods: 'unverified until an owned preview target is connected' }; }
      catch(e) { cdp = { status: 'unavailable', reason: (e as Error).message }; }
    }
    return { platform: process.platform, executable, version, capabilities: {
      cli: { status: executable && process.platform === 'win32' ? 'unverified' : 'unavailable', reason: cliReason ?? 'Executable found; command receipt and rendering require an actual preview.' },
      cefDiscovery: cdp, nativeWindowCapture: { status: 'unavailable', reason: 'Not implemented in this milestone; no full-desktop screenshot fallback.' },
      sceneAuthoring: { status: 'unverified', reason: 'Requires a real editor-created source template and reload validation.' }
    } };
  }
  private get(id: string) {
    const p = this.previews.get(id);
    if (!p) throw new Fault('PREVIEW_NOT_FOUND','Unknown preview ID in this server session.');
    return p;
  }
  private async bind(p: Preview) {
    if (!this.config.devtoolsPort) return;
    const target = await findTarget(this.config.devtoolsPort, p.directory);
    if (!target) return;
    if (p.cdp?.target.id !== target.id) {
      p.cdp?.close(); p.cdp = await Cdp.connect(this.config.devtoolsPort,target,Math.min(this.config.timeoutMs,4000));
      p.capabilities = await p.cdp.probe();
    }
  }
  private async waitReady(p: Preview) {
    let lastError: string | undefined;
    const deadline = Date.now() + this.config.timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this.bind(p);
        if (p.cdp) {
          const status = await p.cdp.diagnostics();
          if (matchesProject(status.url,p.directory) && status.readyState === 'complete') return { evidence: status };
        }
      } catch(e) { lastError = (e as Error).message; }
      await new Promise(r => setTimeout(r,250));
    }
    return { lastError };
  }
  async open(projectId: string, width: number, height: number) {
    const files = await readTree(await this.projects.resolve(projectId)), report = validate(files);
    if (!report.valid) throw new Fault('VALIDATION_FAILED','Preview source is invalid.',report);
    const previewId = randomUUID(), windowName = 'WE-MCP-' + previewId;
    const directory = path.join(this.config.workspace,'previews',previewId);
    await writeTree(directory,files);
    const p: Preview = { previewId, projectId, revision: revision(files), directory, windowName, width, height, files };
    await this.cli(openArgs(path.join(directory,'project.json'),windowName,width,height));
    this.previews.set(previewId,p);
    await this.saveRegistry();
    let lastError: string | undefined;
    if (this.config.devtoolsPort) {
      const ready = await this.waitReady(p); lastError = ready.lastError;
      if (ready.evidence) return { ...this.info(p), state: 'page-ready', evidence: ready.evidence, capabilities: p.capabilities, visualVerification: 'unverified until observe and image review' };
    }
    let current: string | undefined;
    try { current = (await this.cli(['-control','getWallpaper','-location',windowName])).stdout; } catch(e) { lastError = (e as Error).message; }
    const matched = !!current && matchesProject(new URL('file:///' + current.replace(/\\/g,'/')).href,directory);
    return { ...this.info(p), state: matched ? 'path-confirmed-render-unverified' : 'command-sent-unverified', reportedPath: current, lastError, limitations: ['Exit code is not proof of rendering.', 'Use observe after enabling the configured CEF port for images and runtime evidence.'] };
  }
  private info(p: Preview) { return { previewId: p.previewId, projectId: p.projectId, revision: p.revision, directory: p.directory, windowName: p.windowName, width: p.width, height: p.height }; }
  private async saveRegistry() {
    await atomicWrite(path.join(this.config.workspace,'active-previews.json'),json([...this.previews.values()].map(p => this.info(p))));
  }
  async setProperties(id: string, properties: Record<string,unknown>) {
    const p = this.get(id);
    checkProperties(manifest(p.files).general?.properties ?? {}, properties);
    await this.cli(propertyArgs(p.windowName,properties));
    return { previewId: id, submitted: properties, confirmation: 'command-sent-unverified', sourceDefaultsChanged: false, nextStep: 'Observe template diagnostics and the actual image.' };
  }
  async observe(id: string, count = 1, intervalMs = 250, afterCursor = 0, reload = false) {
    const p = this.get(id), images: { path: string; data: string }[] = [], issues: string[] = [];
    try { await this.bind(p); } catch(e) { issues.push((e as Error).message); }
    if (!p.cdp) return { report: { ...this.info(p), state: 'unverified', issues: [...issues,'No matching owned CEF target; screenshot and runtime diagnostics unavailable.'], images: [], metrics: null }, images };
    if (reload) {
      // A bare Page.reload in WE 2.8.42 loses host property/FPS callbacks. Recreate only this owned window instead.
      p.cdp.close(); p.cdp = undefined;
      await this.cli(['-control','closeWallpaper','-location',p.windowName]);
      await this.cli(openArgs(path.join(p.directory,'project.json'),p.windowName,p.width,p.height));
      const ready = await this.waitReady(p);
      if (!ready.evidence) issues.push(ready.lastError ?? 'Host reload did not produce a ready page.');
      if (!p.cdp) return { report: { ...this.info(p), state: 'unverified', issues, images: [] }, images };
    }
    let evidence: unknown;
    for (let i=0;i<count;i++) {
      if (i) await new Promise(r => setTimeout(r,intervalMs));
      try {
        const diagnostic = await p.cdp!.diagnostics();
        if (!matchesProject(diagnostic.url,p.directory)) { p.cdp!.close(); p.cdp = undefined; throw new Fault('TARGET_CHANGED','CEF target navigated outside owned preview.'); }
        evidence = diagnostic;
        const screenshot = await p.cdp!.call('Page.captureScreenshot',{ format:'png' });
        const data = Buffer.from(screenshot.data, 'base64');
        if (!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || data.length > 20*1024*1024) throw new Fault('INVALID_SCREENSHOT','CEF did not return a bounded PNG image.');
        const output = path.join(this.config.workspace,'observations',p.previewId,`${Date.now()}-${i}.png`);
        await atomicWrite(output,data);
        images.push({ path:output,data:data.toString('base64') });
      } catch(e) { issues.push((e as Error).message); if (!p.cdp) break; }
    }
    return { report: { ...this.info(p), state: images.length ? 'frames-captured' : 'unverified', evidence, capabilities:p.capabilities, logs:p.cdp?.logs(afterCursor), issues, images:images.map(i => i.path), visualVerification: 'Requires inspection of image content; PNG capture alone does not rule out a blank frame.', performance: 'Diagnostic frame counters are not GPU presentation FPS.' }, images };
  }
  async close(id: string) {
    const p = this.get(id);
    await this.cli(['-control','closeWallpaper','-location',p.windowName]);
    p.cdp?.close(); this.previews.delete(id); await this.saveRegistry();
    return { previewId: id, state: 'close-command-sent', windowName: p.windowName };
  }
  async shutdown() {
    const failures: string[] = [];
    for (const p of [...this.previews.values()]) {
      try { await this.close(p.previewId); } catch(e) { p.cdp?.close(); failures.push(`${p.windowName}: ${(e as Error).message}`); }
    }
    return failures;
  }
}
