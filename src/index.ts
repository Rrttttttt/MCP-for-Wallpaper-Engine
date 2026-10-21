import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { Fault, loadConfig, readTree, json } from './files.js';
import { Projects, validate } from './projects.js';
import { Engine } from './engine.js';

const configFlag = process.argv.indexOf('--config');
const configFile = configFlag >= 0 ? process.argv[configFlag + 1]! : fileURLToPath(new URL('../we.config.json', import.meta.url));
const config = await loadConfig(configFile);
const projects = new Projects(config), engine = new Engine(config, projects);
if (process.argv.includes('--probe')) {
  console.log(json(await engine.probe()));
} else {
  await projects.init();
  // ponytail: serialize all tools in one process; use per-project queues if throughput becomes a real requirement.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => { const task = queue.then(work); queue = task.catch(() => {}); return task; };
  const pid = z.string().min(1).max(300), rev = z.string().regex(/^[a-f0-9]{64}$/), values = z.record(z.string(), z.union([z.string().max(4096), z.number().finite(), z.boolean()]));
  const output = (value: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: json(value) }], structuredContent: value });
  const factory = () => {
    const server = new McpServer({ name: 'wallpaper-engine-mcp', version: '0.1.0' });
    function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<any>, readOnly = false) {
      server.registerTool(name, { description, inputSchema: z.object(shape), annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } }, async args => serialize(async () => {
        try {
          const result = await handler(args);
          if (result?.report && result?.images) {
            const response = output(result.report);
            response.content.push(...result.images.map((i: any) => ({ type: 'image' as const, mimeType: 'image/png', data: i.data })));
            return response;
          }
          return output(result);
        } catch(e) {
          const failure = e instanceof Fault ? { code: e.code, message: e.message, details: e.details } : { code: 'OPERATION_FAILED', message: (e as Error).message };
          return { ...output({ error: failure }), isError: true };
        }
      }));
    }
    tool('we_environment_probe','Read configured engine version and actual capability evidence. Does not change engine settings.',{},() => engine.probe(),true);
    tool('we_project_list','Discover projects only beneath configured roots; external sources are read-only.', { type: z.enum(['web','scene','video']).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }, a => projects.list(a.type,a.offset,a.limit),true);
    tool('we_project_inspect','Return content revision, manifest, bounded file inventory and optionally up to 256 KiB of requested source text.',{ projectId: pid, readFiles: z.array(z.string()).max(20).default([]) },a => projects.inspect(a.projectId,a.readFiles),true);
    tool('we_project_create','Create bundled Web starfield or native Scene orbit with source PNG, compiled TEX and property-bound SceneScript. sourceProjectId imports a copy instead of the template. Copies strip workshopid; each new project requires runtime validation.',{ name:z.string(), title:z.string().min(1).max(200), templateId:z.enum(['web-starfield','scene-orbit']).default('web-starfield'), properties:values.default({}), sourceProjectId:pid.optional() },a => projects.create(a.name,a.title,a.properties,a.sourceProjectId,a.templateId));
    tool('we_project_apply','Apply project-relative UTF-8 writes/deletions using expectedRevision. Validates candidate and saves a persistent checkpoint before writing.',{ projectId:pid, expectedRevision:rev, changes:z.array(z.object({ path:z.string(),content:z.string().max(1024*1024).nullable() })).min(1).max(100) },a => projects.apply(a.projectId,a.expectedRevision,a.changes));
    tool('we_project_restore','Restore a checkpoint belonging to this managed project, refusing concurrent changes. Creates another checkpoint for undo.',{projectId:pid,checkpointId:z.string(),expectedRevision:rev},a => projects.restore(a.projectId,a.checkpointId,a.expectedRevision));
    tool('we_project_validate','Check metadata, HTML/CSS references and local Scene image-model/material/texture chains. Unresolved shared Scene assets remain warnings; does not claim runtime validation.',{projectId:pid},async a => validate(await readTree(await projects.resolve(a.projectId))),true);
    tool('we_preview_open','Launch a uniquely named official engine window from an immutable source snapshot. One registered Web preview per server session: close it before opening another. Scene previews may coexist. Reports evidence or explicit unverified state; never changes the desktop wallpaper.',{projectId:pid,width:z.number().int().min(320).max(7680).default(1280),height:z.number().int().min(240).max(4320).default(720)},a => engine.open(a.projectId,a.width,a.height));
    tool('we_preview_set_properties','Validate and send named properties only to an owned preview window; source defaults stay unchanged.',{previewId:z.string().uuid(),properties:values},a => engine.setProperties(a.previewId,a.properties));
    tool('we_preview_move_mouse','Move a virtual pointer only in an owned Web CEF preview. x/y are normalized [0,1], top-left to bottom-right, mapped using the current CSS viewport. No system cursor movement, clicks or native Scene fallback. Dispatch acknowledgement does not prove visual response.',{previewId:z.string().uuid(),x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1)},a => engine.moveMouse(a.previewId,a.x,a.y));
    tool('we_preview_observe','Capture owned CEF or native-window PNGs and available diagnostics. Defaults to text and saved paths; includeImages opts into bounded MCP image blocks. Native frames do not prove Scene script health. reload reopens the fixed snapshot.',{previewId:z.string().uuid(),count:z.number().int().min(1).max(3).default(1),intervalMs:z.number().int().min(100).max(2000).default(250),afterCursor:z.number().int().min(0).default(0),reload:z.boolean().default(false),backend:z.enum(['auto','cef','native']).default('auto'),includeImages:z.boolean().default(false)},a => engine.observe(a.previewId,a.count,a.intervalMs,a.afterCursor,a.reload,a.backend,a.includeImages));
    tool('we_preview_close','Close only a window created by this server session. No global stop/kill commands.',{previewId:z.string().uuid()},a => engine.close(a.previewId));
    tool('we_publish_prepare','Stage offline runtime sources and a preparation report; never packs native assets or uploads to Workshop.',{projectId:pid,intent:z.enum(['new','update']).default('new')},a => projects.publish(a.projectId,a.intent));
    return server;
  };
  const handle = serveStdio(factory,{ onerror:e => console.error(e.message) });
  let stopping = false;
  async function shutdown() {
    if (stopping) return; stopping = true;
    await queue;
    for (const failure of await engine.shutdown()) console.error(failure);
    await handle.close(); await projects.unlock();
  }
  process.stdin.on('end',() => { void shutdown().catch(e => { console.error(e); process.exitCode = 1; }); });
  for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => { void shutdown().then(() => process.exit(0)); });
}
