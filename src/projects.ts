import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Fault, type Config, type Files, readTree, revision, manifest, safeJoin, noLinks, writeTree, atomicWrite, hash, json, relativeFile } from './files.js';

export function checkProperties(definitions: Record<string, any>, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    const d = definitions[key];
    if (!d) throw new Fault('INVALID_PROPERTY', `Unknown property: ${key}`);
    let valid = false;
    if (d.type === 'slider') valid = typeof value === 'number' && Number.isFinite(value) && value >= d.min && value <= d.max && (d.fraction || Number.isInteger(value));
    if (d.type === 'bool') valid = typeof value === 'boolean';
    if (d.type === 'textinput') valid = typeof value === 'string' && value.length <= 4096;
    if (d.type === 'color') valid = typeof value === 'string' && /^\d*\.?\d+ \d*\.?\d+ \d*\.?\d+$/.test(value) && value.split(' ').every(v => Number(v) >= 0 && Number(v) <= 1);
    if (d.type === 'combo') valid = d.options?.some((o: any) => o.value === value) ?? false;
    if (!valid) throw new Fault('INVALID_PROPERTY', `Invalid or unsupported value for ${key} (${d.type}).`);
  }
  return values;
}
export function validate(files: Files) {
  const errors: string[] = [], warnings: string[] = [];
  const normalized = new Set<string>();
  let totalBytes = 0;
  for (const [name,data] of files) {
    try { relativeFile(name); } catch { errors.push(`Unsafe file path: ${name}`); }
    const lower = name.toLowerCase();
    if (normalized.has(lower)) errors.push(`Windows case collision: ${name}`);
    normalized.add(lower); totalBytes += data.length;
  }
  for (const name of normalized) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) if (normalized.has(parts.slice(0,i).join('/'))) errors.push(`File/directory collision: ${name}`);
  }
  if (totalBytes > 64 * 1024 * 1024 || files.size > 2000) errors.push('Project exceeds 64 MiB / 2000 file limit.');
  let p: Record<string, any> = {};
  try { p = manifest(files); } catch(e) { errors.push((e as Error).message); }
  if (!['web', 'scene', 'video'].includes(String(p.type).toLowerCase())) errors.push('Unsupported or missing project type.');
  if (typeof p.title !== 'string' || !p.title.trim()) errors.push('Missing project title.');
  try { if (!files.has(relativeFile(p.file))) errors.push(`Missing entry: ${p.file}`); }
  catch { errors.push('Entry must be an ordinary relative file path.'); }
  if (p.preview && !files.has(p.preview)) errors.push(`Missing preview: ${p.preview}`);
  for (const [name, data] of files) {
    if (name.endsWith('.json')) { try { JSON.parse(data.toString()); } catch { errors.push(`Invalid JSON: ${name}`); } }
    if (/\.(html|css|js)$/i.test(name)) {
      const text = data.toString();
      if (/https?:\/\/|wss?:\/\//i.test(text)) warnings.push(`External URL in ${name}; offline operation needs review.`);
      if (/wallpaperRegisterAudioListener/.test(text) && p.supportsaudioprocessing !== true) errors.push('Audio listener requires supportsaudioprocessing: true.');
      const references = name.endsWith('.html') ? [...text.matchAll(/(?:src|href)\s*=\s*["']([^"'#]+)["']/gi)].map(m => m[1]!) :
        name.endsWith('.css') ? [...text.matchAll(/url\(\s*["']?([^\s)"']+)/gi)].map(m => m[1]!) : [];
      for (const ref of references) {
        if (/^(?:data:|https?:|#)/i.test(ref)) continue;
        try {
          const nameRef = path.posix.normalize(path.posix.join(path.posix.dirname(name), decodeURIComponent(ref.split(/[?#]/)[0]!)));
          relativeFile(nameRef);
          if (!files.has(nameRef)) errors.push(`Missing dependency ${ref} referenced by ${name}`);
        } catch { errors.push(`Unsafe dependency ${ref} in ${name}`); }
      }
    }
  }
  try {
    const defs = p.general?.properties ?? {};
    checkProperties(defs, Object.fromEntries(Object.entries(defs).filter(([, d]: any) => ['slider','bool','textinput','color','combo'].includes(d.type)).map(([k,d]: any) => [k,d.value])));
  } catch(e) { errors.push((e as Error).message); }
  const sceneDependencies: { path: string; status: 'local' | 'unresolved'; kind: string }[] = [];
  if (String(p.type).toLowerCase() === 'scene') {
    warnings.push('Scene scripts, engine-provided shaders/assets and dynamic dependencies still require official engine/editor verification.');
    const seen = new Set<string>();
    const dependency = (ref: unknown, kind: string) => {
      if (typeof ref !== 'string') { warnings.push(`Unsupported Scene ${kind} binding; requires engine verification.`); return; }
      try { relativeFile(ref); } catch { errors.push(`Unsafe Scene ${kind} reference: ${ref}`); return; }
      if (seen.has(ref)) return;
      if (seen.size >= 2000) { warnings.push('Scene dependency inspection truncated at 2000 references.'); return; }
      seen.add(ref);
      sceneDependencies.push({path:ref,kind,status:files.has(ref) ? 'local' : 'unresolved'});
      // Imported scenes can legitimately reference the installation's shared assets.
      if (!files.has(ref)) warnings.push(`Unresolved Scene ${kind}: ${ref}; may require engine assets.`);
      return files.get(ref);
    };
    try {
      const scene = JSON.parse(files.get(p.file)?.toString() ?? 'null');
      if (!scene || !Array.isArray(scene.objects)) errors.push('Scene entry must contain an objects array.');
      else for (const object of scene.objects.slice(0,2000)) {
        if (!object?.image) continue;
        const model = dependency(object.image,'image model');
        if (!model) continue;
        const material = dependency(JSON.parse(model.toString()).material,'material');
        if (!material) continue;
        const passes = JSON.parse(material.toString()).passes;
        if (!Array.isArray(passes)) { warnings.push('Unsupported Scene material passes; requires engine verification.'); continue; }
        if (passes.length > 64) warnings.push('Scene material inspection truncated at 64 passes.');
        for (const pass of passes.slice(0,64)) {
          if (!Array.isArray(pass?.textures)) continue;
          if (pass.textures.length > 32) warnings.push('Scene material inspection truncated at 32 textures per pass.');
          for (const texture of pass.textures.slice(0,32)) {
            if (typeof texture !== 'string' || texture.startsWith('_rt_')) continue;
            const ref = `materials/${texture.replace(/\.tex$/i,'')}.tex`;
            const compiled = dependency(ref,'texture');
            if (compiled && !/^TEXV\d{4}\x00/.test(compiled.subarray(0,9).toString('ascii'))) errors.push(`Invalid compiled texture header: ${ref}`);
            if (!files.has(ref) && ['png','jpg','jpeg','tga'].some(extension => files.has(ref.replace(/\.tex$/i,'.'+extension)))) errors.push(`Local Scene texture source requires compilation: ${ref}`);
          }
        }
      }
      if (scene?.objects?.length > 2000) warnings.push('Scene dependency inspection truncated at 2000 objects.');
    } catch { errors.push('Cannot inspect Scene image dependencies; check scene, model and material JSON structure.'); }
  }
  return { valid: errors.length === 0, errors, warnings: [...new Set(warnings)], ...(String(p.type).toLowerCase() === 'scene' ? {sceneDependencies} : {}), engineVerification: 'unverified', limitations: ['Static reference checks cover HTML/CSS and local Scene image-model/material/texture chains; arbitrary scripts, shaders and other Scene layer types require runtime/editor verification.', 'JavaScript syntax and runtime compatibility require engine validation.'] };
}

export class Projects {
  constructor(public config: Config) {}
  get root() { return path.join(this.config.workspace, 'projects'); }
  async init() {
    await noLinks(this.config.workspace);
    await fs.mkdir(this.root, { recursive: true });
    // One process owns a workspace; a second writer must use another workspace.
    try { await fs.mkdir(path.join(this.config.workspace, 'server.lock')); }
    catch(e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Fault('WORKSPACE_LOCKED', 'Workspace in use, or stale server.lock after a crash. Check the old process before removing that lock.'); throw e; }
  }
  async unlock() { await fs.rmdir(path.join(this.config.workspace, 'server.lock')); }
  async resolve(id: string, write = false) {
    const [source, ...parts] = id.split('/');
    let root: string | undefined;
    if (source === 'managed') root = this.root;
    else if (/^root\d+$/.test(source ?? '')) root = this.config.projectRoots[Number(source!.slice(4))];
    if (!root || (!parts.length && source === 'managed')) throw new Fault('PROJECT_NOT_FOUND', 'Unknown project ID.');
    if (write && source !== 'managed') throw new Fault('READ_ONLY_SOURCE', 'External sources are read-only. Import a copy into the managed workspace first.');
    if (!parts.length) { await noLinks(root); return root; }
    return safeJoin(root, parts.join('/'));
  }
  async list(type?: string, offset = 0, limit = 50) {
    const items: any[] = [], warnings: string[] = [];
    const seen = new Set<string>();
    let visited = 0;
    const walk = async (root: string, prefix: string, depth: number) => {
      if (++visited > 5000 || depth > 8) { warnings.push('Discovery limit reached.'); return; }
      try {
        await noLinks(root);
        const canonical = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
        if (seen.has(canonical)) return;
        seen.add(canonical);
        const entries = await fs.readdir(root, { withFileTypes: true });
        if (entries.some(e => e.name === 'project.json' && e.isFile())) {
          const p = JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8'));
          if (!type || String(p.type).toLowerCase() === type) items.push({ projectId: prefix, title: p.title, type: p.type, source: prefix.startsWith('managed/') ? 'managed-original' : /(?:^|[\\/])workshop(?:[\\/]|$)/i.test(root) ? 'workshop-copy' : 'external-unverified', editable: prefix.startsWith('managed/') });
          return;
        }
        for (const e of entries.sort((a,b) => a.name.localeCompare(b.name))) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(path.join(root,e.name), prefix + '/' + e.name, depth + 1);
      } catch(e) { warnings.push(`${prefix}: ${(e as Error).message}`); }
    };
    for (const [i, root] of [this.root, ...this.config.projectRoots].entries()) await walk(root, i === 0 ? 'managed' : `root${i-1}`, 0);
    return { projects: items.slice(offset, offset + limit), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null, warnings: warnings.slice(0,50) };
  }
  async inspect(id: string, readFiles: string[] = []) {
    const root = await this.resolve(id), files = await readTree(root), p = manifest(files);
    const contents: Record<string, string> = {};
    let total = 0;
    for (const name of readFiles) {
      relativeFile(name);
      const data = files.get(name);
      if (!data) throw new Fault('FILE_NOT_FOUND', name);
      total += data.length;
      if (total > 256 * 1024 || data.includes(0)) throw new Fault('READ_LIMIT', 'Text reads are limited to 256 KiB without binary data.');
      contents[name] = data.toString();
    }
    return { projectId: id, path: root, revision: revision(files), manifest: p, files: [...files].map(([name,data]) => ({ name, bytes: data.length, sha256: hash(data) })), contents, validation: validate(files) };
  }
  async create(name: string, title: string, properties: Record<string, unknown> = {}, sourceProjectId?: string, templateId: 'web-starfield' | 'scene-orbit' = 'web-starfield') {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Fault('INVALID_NAME', 'Name must use lowercase ASCII letters, digits and hyphens.');
    if (!['web-starfield','scene-orbit'].includes(templateId)) throw new Fault('INVALID_TEMPLATE','Unknown bundled template.');
    const id = `managed/${name}`, target = await this.resolve(id, true);
    const files = sourceProjectId ? await readTree(await this.resolve(sourceProjectId)) : await readTree(fileURLToPath(new URL(`../templates/${templateId}/`, import.meta.url)));
    const p = manifest(files);
    p.title = title; delete p.workshopid;
    checkProperties(p.general?.properties ?? {}, properties);
    for (const [key,value] of Object.entries(properties)) p.general.properties[key].value = value;
    files.set('project.json', Buffer.from(json(p)));
    const report = validate(files);
    if (!report.valid) throw new Fault('VALIDATION_FAILED', 'New project failed static validation.', report);
    // Exclusive destination creation prevents accidental overwrites.
    await fs.mkdir(target);
    await writeTree(target, files);
    await atomicWrite(path.join(this.config.workspace, 'origins', name + '.json'), json({ sourceProjectId: sourceProjectId ?? null, templateId: sourceProjectId ? null : templateId, createdAt: new Date().toISOString(), sourceRevision: revision(files) }));
    return this.inspect(id);
  }
  async checkpoint(id: string, files: Files) {
    const checkpointId = randomUUID(), root = path.join(this.config.workspace, 'checkpoints', checkpointId);
    await writeTree(path.join(root, 'files'), files);
    await atomicWrite(path.join(root, 'record.json'), json({ projectId: id, revision: revision(files), createdAt: new Date().toISOString() }));
    return checkpointId;
  }
  async replace(id: string, expected: string, next: Files) {
    const root = await this.resolve(id, true), before = await readTree(root);
    if (revision(before) !== expected) throw new Fault('REVISION_CONFLICT', 'Project changed; inspect it again before editing.', { actualRevision: revision(before) });
    const report = validate(next);
    if (!report.valid) throw new Fault('VALIDATION_FAILED', 'Changes failed static validation.', report);
    const changed = [...new Set([...before.keys(), ...next.keys()])].filter(name => !before.get(name)?.equals(next.get(name) ?? Buffer.alloc(0)) || !next.has(name));
    if (!changed.length) return { projectId:id, revision:expected, checkpointId:null, changed, validation:report };
    const checkpointId = await this.checkpoint(id, before);
    const journal = path.join(this.config.workspace, 'checkpoints', checkpointId, 'operation.json');
    await atomicWrite(journal, json({ state: 'prepared', projectId: id, expectedRevision: expected, nextRevision: revision(next), changed }));
    if (revision(await readTree(root)) !== expected) throw new Fault('REVISION_CONFLICT', 'Project changed while checkpointing; no files written.');
    try {
      for (const name of changed) {
        const target = await safeJoin(root, name);
        let current: Buffer | undefined;
        try { current = await fs.readFile(target); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if ((current === undefined) !== !before.has(name) || (current && !current.equals(before.get(name)!))) throw new Fault('REVISION_CONFLICT', `Concurrent edit detected: ${name}`);
        if (next.has(name)) await atomicWrite(target, next.get(name)!);
        else await fs.unlink(target);
      }
      const actual = revision(await readTree(root));
      if (actual !== revision(next)) throw new Fault('REVISION_CONFLICT', 'Concurrent external change detected after write.');
      await atomicWrite(journal, json({ state: 'complete', projectId: id, revision: actual, changed }));
      return { projectId: id, revision: actual, checkpointId, changed, validation: report };
    } catch(e) {
      await atomicWrite(journal, json({ state: 'recovery-required', projectId: id, changed, error: (e as Error).message }));
      throw new Fault('RECOVERY_REQUIRED', 'Multi-file write interrupted. Inspect current revision, then restore this checkpoint if appropriate.', { checkpointId, reason: (e as Error).message });
    }
  }
  async apply(id: string, expected: string, changes: { path: string; content: string | null }[]) {
    const next = await readTree(await this.resolve(id, true));
    if (changes.length === 0 || changes.length > 100) throw new Fault('CHANGE_LIMIT', 'Use 1..100 changes.');
    const unique = new Set<string>();
    for (const change of changes) {
      relativeFile(change.path);
      const normalized = change.path.toLowerCase();
      if (unique.has(normalized)) throw new Fault('DUPLICATE_PATH', change.path);
      unique.add(normalized);
      if (change.content === null) next.delete(change.path);
      else { if (Buffer.byteLength(change.content) > 1024 * 1024) throw new Fault('WRITE_LIMIT', 'Max 1 MiB per text change.'); next.set(change.path, Buffer.from(change.content)); }
    }
    return this.replace(id, expected, next);
  }
  async restore(id: string, checkpointId: string, expected: string) {
    if (!/^[\da-f-]{36}$/.test(checkpointId)) throw new Fault('INVALID_CHECKPOINT', 'Invalid checkpoint ID.');
    const root = path.join(this.config.workspace, 'checkpoints', checkpointId);
    await noLinks(root);
    const record = JSON.parse(await fs.readFile(path.join(root,'record.json'),'utf8'));
    const files = await readTree(path.join(root, 'files'));
    if (record.projectId !== id || record.revision !== revision(files)) throw new Fault('INVALID_CHECKPOINT', 'Checkpoint ownership/hash mismatch.');
    return this.replace(id, expected, files);
  }
  async publish(id: string, intent: 'new' | 'update') {
    const files = await readTree(await this.resolve(id)), report = validate(files), p = manifest(files);
    if (!report.valid) throw new Fault('VALIDATION_FAILED', 'Cannot prepare invalid project.', report);
    if (intent === 'new') { delete p.workshopid; files.set('project.json',Buffer.from(json(p))); }
    if (intent === 'update' && !p.workshopid) throw new Fault('NO_WORKSHOP_ID', 'Update requires an existing workshopid and manual ownership verification.');
    const output = path.join(this.config.workspace,'publish', randomUUID());
    await writeTree(output, files);
    const result = { projectId: id, intent, directory: output, sourceRevision: revision(await readTree(await this.resolve(id))), packageRevision: revision(files), validation: report, uploaded: false, remaining: ['Verify graphics and audio in the official engine, reload from saved sources.', 'Review all assets, rights, metadata and offline dependencies.', 'Import the staged directory through the official editor; create a preview image if missing.', 'Upload or update manually through the official Workshop menu.'] };
    await atomicWrite(path.join(output,'..',path.basename(output) + '.report.json'), json(result));
    return result;
  }
}
