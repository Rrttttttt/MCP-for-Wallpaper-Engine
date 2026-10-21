import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Fault } from './files.js';

export interface Target { id: string; type: string; url: string; webSocketDebuggerUrl?: string }
export async function endpoint(port: number, route: string): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  if (!response.ok) throw new Fault('CEF_UNAVAILABLE', `CEF returned HTTP ${response.status}.`);
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Fault('CEF_RESPONSE_LIMIT','CEF discovery response too large.');
  return JSON.parse(body);
}
export function matchesProject(url: string, directory: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    const file = path.resolve(fileURLToPath(parsed)).toLowerCase(), root = path.resolve(directory).toLowerCase();
    return file.startsWith(root + path.sep);
  } catch { return false; }
}
export async function findTarget(port: number, directory: string): Promise<Target | undefined> {
  const targets: Target[] = await endpoint(port, '/json/list');
  if (!Array.isArray(targets)) throw new Fault('CEF_PROTOCOL', 'CEF target list is not an array.');
  const matches = targets.filter(t => t.type === 'page' && matchesProject(t.url, directory));
  if (matches.length > 1) throw new Fault('AMBIGUOUS_TARGET','Multiple CEF pages match the preview; refusing to choose one.');
  return matches[0];
}
export class Cdp {
  private counter = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private entries: { cursor: number; method: string; params: unknown }[] = [];
  private cursor = 0;
  private constructor(private socket: WebSocket, public target: Target, private timeout: number) {
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id) {
          const p = this.pending.get(message.id);
          if (p) { clearTimeout(p.timer); this.pending.delete(message.id); message.error ? p.reject(new Fault('CDP_ERROR', message.error.message)) : p.resolve(message.result); }
        } else if (['Runtime.consoleAPICalled','Runtime.exceptionThrown','Network.loadingFailed','Log.entryAdded'].includes(message.method)) {
          const serialized = JSON.stringify(message.params);
          this.entries.push({ cursor: ++this.cursor, method: message.method, params: serialized.length > 16000 ? { truncated: true, text: serialized.slice(0,16000) } : message.params });
          if (this.entries.length > 200) this.entries.shift();
        }
      } catch { /* Malformed/oversized event does not break request dispatch. */ }
    });
    socket.addEventListener('close', () => this.rejectAll('CEF connection closed.'));
    socket.addEventListener('error', () => this.rejectAll('CEF connection failed.'));
  }
  private rejectAll(message: string) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Fault('CEF_DISCONNECTED',message)); }
    this.pending.clear();
  }
  static async connect(port: number, target: Target, timeout: number) {
    if (!target.webSocketDebuggerUrl) throw new Fault('CEF_PROTOCOL','Target has no WebSocket URL.');
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || Number(url.port) !== port || url.username || url.password) throw new Fault('UNSAFE_CEF_ENDPOINT','Only configured loopback WebSocket endpoints are accepted.');
    // Pin even a "localhost" advertisement to the configured IPv4 loopback.
    url.hostname = '127.0.0.1';
    const socket = new WebSocket(url);
    await new Promise<void>((resolve,reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Fault('CEF_TIMEOUT','CEF WebSocket connection timed out.')); }, timeout);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Fault('CEF_UNAVAILABLE','CEF WebSocket connection failed.')); }, { once: true });
    });
    return new Cdp(socket, target, timeout);
  }
  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve,reject) => {
      const id = ++this.counter;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Fault('CDP_TIMEOUT',`${method} timed out.`)); }, this.timeout);
      this.pending.set(id,{resolve,reject,timer});
      try { this.socket.send(JSON.stringify({id,method,params})); }
      catch(e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async probe() {
    const result: Record<string, { status: string; reason?: string }> = {};
    for (const method of ['Runtime.enable','Page.enable','Network.enable','Log.enable']) {
      try { await this.call(method); result[method] = { status: 'supported' }; }
      catch(e) { result[method] = { status: 'unavailable', reason: (e as Error).message }; }
    }
    return result;
  }
  async diagnostics() {
    const r = await this.call('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,readyState:document.readyState,diagnostics:window.__weDiagnostics||null})', returnByValue: true });
    if (r.exceptionDetails || r.result?.type !== 'string') throw new Fault('CEF_DIAGNOSTICS','Unable to read fixed diagnostic object.');
    return JSON.parse(r.result.value);
  }
  async moveMouse(directory: string, x: number, y: number) {
    if (![x,y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Fault('INVALID_MOUSE_POSITION','Mouse x/y must be finite normalized coordinates in [0,1].');
    const viewport = async () => {
      const r = await this.call('Runtime.evaluate',{ expression:'JSON.stringify({url:location.href,readyState:document.readyState,width:innerWidth,height:innerHeight})',returnByValue:true });
      if (r.exceptionDetails || r.result?.type !== 'string') throw new Fault('CEF_VIEWPORT','Unable to read the current page viewport.');
      const v = JSON.parse(r.result.value);
      if (!v || typeof v !== 'object') throw new Fault('CEF_VIEWPORT','Invalid page viewport response.');
      if (!matchesProject(v.url,directory)) throw new Fault('TARGET_CHANGED','CEF page is outside the owned preview.');
      if (v.readyState !== 'complete' || ![v.width,v.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Fault('CEF_VIEWPORT','Requires a ready page with viewport dimensions of 1–8192 CSS pixels.');
      return { url:v.url as string,width:v.width as number,height:v.height as number };
    };
    const before = await viewport(), position = { x:x*(before.width-1),y:y*(before.height-1) };
    // CDP checks and dispatch are separate commands; navigation cannot be made atomic here.
    // After an attempted dispatch, failures must not imply that the page received no input.
    try {
      await this.call('Input.dispatchMouseEvent',{type:'mouseMoved',...position,button:'none',buttons:0,modifiers:0});
      const after = await viewport();
      if (after.url !== before.url || after.width !== before.width || after.height !== before.height) throw new Fault('TARGET_CHANGED','Page navigated or resized during mouse input.');
    } catch(e) {
      throw new Fault(e instanceof Fault ? e.code : 'MOUSE_INPUT_FAILED',(e as Error).message,{dispatchAttempted:true,visualResponse:'unverified'});
    }
    return { position,viewport:before,dispatchAttempted:true,confirmation:'event-dispatched',visualResponse:'unverified' };
  }
  logs(after = 0) { return { entries: this.entries.filter(e => e.cursor > after), cursor: this.cursor, truncated: !!this.entries.length && after < this.entries[0]!.cursor - 1 }; }
  close() { this.socket.close(); this.rejectAll('Preview connection closed.'); }
}
