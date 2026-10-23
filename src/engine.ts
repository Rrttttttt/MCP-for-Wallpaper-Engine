import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Fault, type Config, type Files, noLinks, readTree, writeTree, revision, manifest, atomicWrite, json } from './files.js';
import { Projects, validate, checkProperties } from './projects.js';
import { Cdp, endpoint, findTarget, matchesProject } from './cdp.js';
import { nativeAvailable, nativeCall, pngInfo, type WindowIdentity } from './native.js';

const execFileAsync = promisify(execFile);
interface Preview {
  previewId: string; projectId: string; revision: string; directory: string; windowName: string;
  width: number; height: number; cdp?: Cdp; capabilities?: unknown; files: Files;
  native: boolean; baseline?: string[]; identity?: WindowIdentity;
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
    let nativeWindowCapture: unknown = { status: 'unavailable', reason: 'Build the optional Windows x64 helper with npm run build:native.' };
    try { if (await nativeAvailable()) nativeWindowCapture = await nativeCall('probe'); }
    catch(e) { nativeWindowCapture = { status: 'unavailable', reason: (e as Error).message }; }
    return { platform: process.platform, executable, version, capabilities: {
      cli: { status: executable && process.platform === 'win32' ? 'unverified' : 'unavailable', reason: cliReason ?? 'Executable found; command receipt and rendering require an actual preview.' },
      cefDiscovery: cdp, nativeWindowCapture,
      webPreviewConcurrency: { status:'limited',maxActivePerSession:1,scope:'server-session',reason:'Local official-engine/CEF testing reproduced a missing second Web renderer even without remote debugging. Close the registered Web preview before opening another; this is not a cross-process lock.' },
      sceneAuthoring: { status: 'limited', templates:['scene-orbit'], reason: 'Bundled image layer with source PNG, compiled TEX and property-bound SceneScript. Each project still requires engine/editor verification; arbitrary Scene authoring is not implemented.' }
    } };
  }
  private get(id: string) {
    const p = this.previews.get(id);
    if (!p) throw new Fault('PREVIEW_NOT_FOUND','Unknown preview ID in this server session.');
    return p;
  }
  private async bind(p: Preview) {
    if (!this.config.devtoolsPort || String(manifest(p.files).type).toLowerCase() !== 'web') return false;
    const target = await findTarget(this.config.devtoolsPort, p.directory);
    if (!target) return false;
    if (p.cdp?.target.id !== target.id || p.cdp?.target.discoveryHost !== target.discoveryHost) {
      p.cdp?.close(); p.cdp = await Cdp.connect(this.config.devtoolsPort,target,Math.min(this.config.timeoutMs,4000));
      p.capabilities = await p.cdp.probe();
    }
    return true;
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
  private nativeRequest(p: Preview) { return { windowName:p.windowName, installDir:this.config.installDir, expected:p.identity }; }
  private async verifyWindow(p: Preview) {
    if (!p.native) return;
    if (!p.identity) p.identity = (await nativeCall('find',{ ...this.nativeRequest(p),baseline:p.baseline },this.config.timeoutMs)).identity;
    await nativeCall('verify',this.nativeRequest(p),this.config.timeoutMs);
  }
  private async launch(p: Preview) {
    if (p.native) p.baseline = (await nativeCall('baseline')).handles;
    p.identity = undefined;
    // Persist before sending the CLI command: even a command timeout can leave a live window.
    this.previews.set(p.previewId,p);
    await this.saveRegistry();
    await this.cli(openArgs(path.join(p.directory,'project.json'),p.windowName,p.width,p.height));
    await this.verifyWindow(p);
    await this.saveRegistry();
  }
  async open(projectId: string, width: number, height: number) {
    const files = await readTree(await this.projects.resolve(projectId)), report = validate(files);
    if (!report.valid) throw new Fault('VALIDATION_FAILED','Preview source is invalid.',report);
    if (String(manifest(files).type).toLowerCase() === 'web') {
      const activePreviewIds = [...this.previews.values()].filter(p => String(manifest(p.files).type).toLowerCase() === 'web').map(p => p.previewId);
      if (activePreviewIds.length) throw new Fault('WEB_PREVIEW_LIMIT','Close the registered Web preview before opening another. Concurrent Web rendering failed in local official-engine/CEF tests.',{limit:1,scope:'server-session',activePreviewIds});
    }
    await this.executable();
    const previewId = randomUUID(), windowName = 'WE-MCP-' + previewId;
    const directory = path.join(this.config.workspace,'previews',previewId);
    await writeTree(directory,files);
    const p: Preview = { previewId, projectId, revision: revision(files), directory, windowName, width, height, files, native:await nativeAvailable() };
    try { await this.launch(p); }
    catch(e) { throw new Fault('PREVIEW_OPEN_FAILED',(e as Error).message,{ ...this.info(p),cause:e instanceof Fault ? e.code : 'CLI_FAILED',cleanup:this.previews.has(previewId) ? 'Preview remains registered for close/shutdown.' : 'No command sent; no live preview was registered.' }); }
    let lastError: string | undefined;
    if (this.config.devtoolsPort && manifest(files).type === 'web') {
      const ready = await this.waitReady(p); lastError = ready.lastError;
      if (ready.evidence) return { ...this.info(p), state: 'page-ready', evidence: ready.evidence, capabilities: p.capabilities, visualVerification: 'unverified until observe and image review' };
    }
    let current: string | undefined;
    try { current = (await this.cli(['-control','getWallpaper','-location',windowName])).stdout; } catch(e) { lastError = (e as Error).message; }
    const matched = !!current && matchesProject(new URL('file:///' + current.replace(/\\/g,'/')).href,directory);
    return { ...this.info(p), state: p.identity ? 'window-bound-render-unverified' : matched ? 'path-confirmed-render-unverified' : 'command-sent-unverified', reportedPath: current, lastError, limitations: ['Window binding and exit code are not proof of rendering.', 'Use observe to capture frames; Scene script diagnostics remain unavailable.'] };
  }
  private info(p: Preview) { return { previewId: p.previewId, projectId: p.projectId, revision: p.revision, directory: p.directory, windowName: p.windowName, width: p.width, height: p.height, windowIdentity:p.identity }; }
  private async saveRegistry() {
    await atomicWrite(path.join(this.config.workspace,'active-previews.json'),json([...this.previews.values()].map(p => this.info(p))));
  }
  async setProperties(id: string, properties: Record<string,unknown>) {
    const p = this.get(id);
    checkProperties(manifest(p.files).general?.properties ?? {}, properties);
    await this.verifyWindow(p);
    await this.cli(propertyArgs(p.windowName,properties));
    return { previewId: id, submitted: properties, confirmation: 'command-sent-unverified', sourceDefaultsChanged: false, nextStep: 'Observe template diagnostics and the actual image.' };
  }
  async moveMouse(id: string, x: number, y: number) {
    const p = this.get(id);
    if (manifest(p.files).type !== 'web' || !this.config.devtoolsPort) throw new Fault('MOUSE_INPUT_UNSUPPORTED','Mouse movement requires a Web preview and configured CEF debugging. No system cursor fallback is used.');
    await this.verifyWindow(p);
    if (!await this.bind(p) || !p.cdp) throw new Fault('CEF_TARGET_UNAVAILABLE','No matching owned CEF page is available for mouse input.');
    const result = await p.cdp.moveMouse(p.directory,x,y);
    try { await this.verifyWindow(p); }
    catch(e) { throw new Fault(e instanceof Fault ? e.code : 'WINDOW_VERIFICATION_FAILED',(e as Error).message,{...result,dispatchAttempted:true}); }
    return { previewId:id,backend:'cef',normalized:{x,y},...result,nextStep:'Observe the rendered response; command acknowledgement does not verify eye direction, displacement or edge quality.' };
  }
  async observe(id: string, count = 1, intervalMs = 250, afterCursor = 0, reload = false, backend: 'auto' | 'cef' | 'native' = 'auto', includeImages = false) {
    const p = this.get(id), images: { path: string; data: string }[] = [], issues: string[] = [];
    if (reload) {
      // A bare Page.reload in WE 2.8.42 loses host property/FPS callbacks. Recreate only this owned window instead.
      await this.closeWindow(p);
      p.cdp?.close(); p.cdp = undefined;
      await this.launch(p);
      if (this.config.devtoolsPort && manifest(p.files).type === 'web') {
        const ready = await this.waitReady(p);
        if (!ready.evidence) issues.push(ready.lastError ?? 'Host reload did not produce a ready page.');
      }
    }
    await this.verifyWindow(p);
    try { await this.bind(p); } catch(e) { issues.push((e as Error).message); }
    const selected = backend === 'auto' ? (p.cdp ? 'cef' : 'native') : backend;
    if (selected === 'native' && !p.native) throw new Fault('NATIVE_CAPTURE_UNAVAILABLE','Build the Windows helper before requesting native capture.');
    if (selected === 'cef' && !p.cdp) throw new Fault('CEF_TARGET_UNAVAILABLE','No matching owned CEF target. Use native capture for Scene or previews without CEF.');
    const captures: Record<string,unknown>[] = [];
    let evidence: unknown;
    for (let i=0;i<count;i++) {
      if (i) await new Promise(r => setTimeout(r,intervalMs));
      try {
        await this.verifyWindow(p);
        if (p.cdp) {
          let diagnostic;
          try { diagnostic = await p.cdp.diagnostics(); }
          catch(e) {
            if (selected === 'cef') throw e;
            issues.push(`CEF diagnostics unavailable: ${(e as Error).message}`);
            p.cdp.close(); p.cdp = undefined;
          }
          if (diagnostic) {
            if (!matchesProject(diagnostic.url,p.directory)) { p.cdp?.close(); p.cdp = undefined; throw new Fault('TARGET_CHANGED','CEF target navigated outside owned preview.'); }
            evidence = diagnostic;
          }
        }
        const screenshot = selected === 'native' ? await nativeCall('capture',this.nativeRequest(p),this.config.timeoutMs) : await p.cdp!.call('Page.captureScreenshot',{ format:'png' });
        const data = Buffer.from(screenshot.data, 'base64');
        const dimensions = pngInfo(data);
        await this.verifyWindow(p);
        const output = path.join(this.config.workspace,'observations',p.previewId,`${Date.now()}-${i}.png`);
        await atomicWrite(output,data);
        captures.push({ path:output,...dimensions,backend:selected,windowIdentity:p.identity,timestampTicks:screenshot.timestampTicks,dpi:screenshot.dpi,scope:selected === 'native' ? 'window-including-nonclient-area' : 'page',color:selected === 'native' ? screenshot.color : 'CEF PNG; display color fidelity unverified' });
        if (includeImages) {
          // Keep MCP payload bounded; full-size files remain available to the user.
          if (images.reduce((n,image) => n + image.data.length,0) + screenshot.data.length <= 8*1024*1024) images.push({ path:output,data:data.toString('base64') });
          else issues.push('Inline image budget (8 MiB base64) exceeded; inspect the saved PNG path.');
        }
      } catch(e) { issues.push(`${e instanceof Fault ? e.code : 'CAPTURE_FAILED'}: ${(e as Error).message}`); break; }
    }
    return { report: { ...this.info(p), state: captures.length ? 'frames-captured' : 'unverified', backend:selected, requestedFrames:count, capturedFrames:captures.length, complete:captures.length === count, evidence, runtimeDiagnostics:p.cdp ? 'CEF diagnostics available' : 'unavailable; native frames do not prove script/asset health', capabilities:p.capabilities, logs:p.cdp?.logs(afterCursor), issues, images:captures.map(i => i.path), captures, inlineImages:images.length, visualVerification: 'Requires inspection of image content; PNG capture alone does not rule out a blank frame.', performance: 'Diagnostic frame counters are not GPU presentation FPS.' }, images };
  }
  private async closeWindow(p: Preview) {
    if (p.native) {
      if (!p.identity) {
        // A failed launch may never create a window. Do not wait for it to appear during cleanup.
        try { await nativeCall('absent',this.nativeRequest(p),500); return 'window-absent'; }
        catch(e) { if (!(e instanceof Fault) || e.code !== 'WINDOW_CLOSE_TIMEOUT') throw e; }
      }
      try { await this.verifyWindow(p); }
      catch(e) {
        // If already absent, acknowledge absence without sending a close to a replacement HWND.
        try { await nativeCall('absent',this.nativeRequest(p),500); return 'window-absent'; }
        catch { throw e; }
      }
    }
    await this.cli(['-control','closeWallpaper','-location',p.windowName]);
    if (p.native) { await nativeCall('absent',this.nativeRequest(p),this.config.timeoutMs); return 'window-absent'; }
    return 'close-command-sent';
  }
  async close(id: string) {
    const p = this.get(id);
    const state = await this.closeWindow(p);
    p.cdp?.close(); this.previews.delete(id); await this.saveRegistry();
    return { previewId: id, state, windowName: p.windowName };
  }
  async shutdown() {
    const failures: string[] = [];
    for (const p of [...this.previews.values()]) {
      try { await this.close(p.previewId); } catch(e) { p.cdp?.close(); failures.push(`${p.windowName}: ${(e as Error).message}`); }
    }
    return failures;
  }
}
