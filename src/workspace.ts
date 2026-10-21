import * as fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Fault, hash, json, noLinks } from './files.js';

const execute = promisify(execFile);
const ownerSchema = z.object({
  version:z.literal(1), service:z.literal('wallpaper-engine-mcp'), sessionId:z.uuid(),
  pid:z.number().int().min(1).max(2147483647), host:z.string().min(1).max(255),
  platform:z.string().min(1).max(32), processStartTime:z.string().regex(/^\d{15,20}$/).nullable(),
  workspace:z.string().min(1).max(4096), createdAt:z.iso.datetime()
}).strict();
type Owner = z.infer<typeof ownerSchema>;
type ProcessEvidence = {state:'alive'|'absent'|'unknown'; startTime?:string; reason?:string};
type Lock = {state:'present'|'absent'|'unsafe'|'unknown'; fingerprint:string|null; owner:Owner|null; reason?:string; identity?:string};
const canonical = (value:string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const identity = (s:BigIntStats) => json([String(s.dev),String(s.ino),String(s.birthtimeNs)]);
const stamp = (s:BigIntStats) => identity(s) + String(s.mtimeNs) + ':' + String(s.size);

// Fixed, read-only local query. No command line, arbitrary script, remote host or public PID argument.
async function processEvidence(pid:number):Promise<ProcessEvidence> {
  if (process.platform !== 'win32') return {state:'unknown',reason:'Process start identity is currently implemented only on Windows.'};
  try {
    const script = `$ErrorActionPreference='Stop'; $p=$null; try { $p=[System.Diagnostics.Process]::GetProcessById(${pid}) } catch { if ($_.Exception.GetBaseException() -is [System.ArgumentException]) { @{state='absent'} | ConvertTo-Json -Compress; exit }; throw }; try { if ($p.HasExited) { @{state='absent'} | ConvertTo-Json -Compress } else { @{state='alive'; startTime=$p.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Compress } } finally { $p.Dispose() }`;
    const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const {stdout} = await execute(shell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,timeout:3000,maxBuffer:8192});
    return z.union([
      z.object({state:z.literal('absent')}).strict(),
      z.object({state:z.literal('alive'),startTime:z.string().regex(/^\d{15,20}$/)}).strict()
    ]).parse(JSON.parse(stdout.trim()));
  } catch { return {state:'unknown',reason:'Local process query failed, was denied or timed out; this is not evidence of exit.'}; }
}

export class WorkspaceLock {
  private owned?:{fingerprint:string; identity:string};
  readonly workspace:string;
  constructor(workspace:string) { this.workspace=path.resolve(workspace); }
  get directory() { return path.join(this.workspace,'server.lock'); }
  get isOwner() { return this.owned !== undefined; }

  private async read():Promise<Lock> {
    try {
      await noLinks(this.directory);
      let before:BigIntStats;
      try { before=await fs.lstat(this.directory,{bigint:true}); }
      catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {state:'absent',fingerprint:null,owner:null}; throw e; }
      if (!before.isDirectory()) throw new Fault('UNSAFE_PATH','Workspace lock is not an ordinary directory.');
      const entries:string[]=[];
      for await (const entry of await fs.opendir(this.directory)) {
        entries.push(entry.name);
        if (entries.length > 8) throw new Fault('LOCK_READ_LIMIT','Lock directory has unexpected entries.');
      }
      let raw:Buffer|null=null, owner:Owner|null=null, reason='missing-owner-metadata';
      if (entries.includes('owner.json')) {
        const file=path.join(this.directory,'owner.json');
        await noLinks(file);
        const handle=await fs.open(file,'r');
        try {
          const start=await handle.stat({bigint:true});
          if (!start.isFile() || start.nlink !== 1n) throw new Fault('UNSAFE_PATH','Lock metadata must be an ordinary file without additional hard links.');
          if (start.size > 8192n) throw new Fault('LOCK_READ_LIMIT','Lock metadata exceeds 8 KiB.');
          const buffer=Buffer.alloc(8193);let length=0;
          while (length < buffer.length) {
            const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);
            if (!bytesRead) break;length+=bytesRead;
          }
          if (length > 8192) throw new Fault('LOCK_READ_LIMIT','Lock metadata exceeds 8 KiB.');
          if (stamp(start) !== stamp(await handle.stat({bigint:true})) || stamp(start) !== stamp(await fs.lstat(file,{bigint:true}))) throw new Fault('LOCK_CHANGED','Lock metadata changed during inspection.');
          raw=buffer.subarray(0,length);
        } finally { await handle.close(); }
        reason='invalid-owner-metadata';
        try {
          const parsed=ownerSchema.parse(JSON.parse(raw.toString('utf8')));
          if (canonical(parsed.workspace) === canonical(this.workspace)) {owner=parsed;reason='owner-recorded';}
        } catch { /* Invalid metadata is unknown, never a stale-lock signal. */ }
      }
      if (entries.some(name=>name !== 'owner.json')) {owner=null;reason='unexpected-lock-entries';}
      const after=await fs.lstat(this.directory,{bigint:true});
      if (stamp(before) !== stamp(after)) throw new Fault('LOCK_CHANGED','Lock directory changed during inspection.');
      return {state:'present',identity:identity(after),fingerprint:hash(json([stamp(after),entries.sort(),raw === null ? null : hash(raw)])),owner,reason};
    } catch(e) {
      return {state:e instanceof Fault && e.code === 'UNSAFE_PATH' ? 'unsafe' : 'unknown',fingerprint:null,owner:null,reason:e instanceof Fault ? e.code : ((e as NodeJS.ErrnoException).code ?? 'LOCK_READ_FAILED')};
    }
  }

  async acquire() {
    await noLinks(this.workspace);
    await fs.mkdir(this.workspace,{recursive:true});
    try { await fs.mkdir(this.directory); }
    catch(e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Fault('WORKSPACE_LOCKED','Workspace lock exists. Use we_workspace_diagnose; no automatic recovery is attempted.');
      throw e;
    }
    const acquiredIdentity=identity(await fs.lstat(this.directory,{bigint:true}));
    const evidence=await processEvidence(process.pid);
    const owner:Owner={version:1,service:'wallpaper-engine-mcp',sessionId:randomUUID(),pid:process.pid,host:os.hostname(),platform:process.platform,processStartTime:evidence.startTime ?? null,workspace:this.workspace,createdAt:new Date().toISOString()};
    await noLinks(this.directory);
    if (identity(await fs.lstat(this.directory,{bigint:true})) !== acquiredIdentity) throw new Fault('WORKSPACE_OWNERSHIP_LOST','Lock changed before owner metadata could be written.');
    await fs.writeFile(path.join(this.directory,'owner.json'),json(owner),{flag:'wx'});
    const lock=await this.read();
    if (!lock.fingerprint || !lock.identity || lock.owner?.sessionId !== owner.sessionId) throw new Fault('WORKSPACE_OWNERSHIP_LOST','Cannot verify the newly acquired lock; preserving it for diagnosis.');
    this.owned={fingerprint:lock.fingerprint,identity:lock.identity};
  }

  async assertOwned() {
    if (!this.owned) throw new Fault('WORKSPACE_LOCKED','This session is diagnostic only. Call we_workspace_diagnose; project and preview tools require workspace ownership.');
    const lock=await this.read();
    if (lock.fingerprint !== this.owned.fingerprint) throw new Fault('WORKSPACE_OWNERSHIP_LOST','Workspace lock changed or became unreadable. No operation or automatic unlock will be attempted.');
  }

  async release() {
    if (!this.owned) return;
    // ponytail: cooperative release only; add shared acquisition/recovery coordination before introducing reclaimers.
    await this.assertOwned();
    await fs.unlink(path.join(this.directory,'owner.json'));
    if (identity(await fs.lstat(this.directory,{bigint:true})) !== this.owned.identity) throw new Fault('WORKSPACE_OWNERSHIP_LOST','Lock directory was replaced during release.');
    await fs.rmdir(this.directory); // Non-recursive: never delete unexpected contents.
    this.owned=undefined;
  }

  async diagnose() {
    const lock=await this.read();
    const mode=this.owned && lock.fingerprint === this.owned.fingerprint ? 'owner' : 'diagnostic';
    let holder:{state:'alive'|'exited'|'pid-reused'|'unknown'|'none';reason?:string;observedStartTime?:string}={state:lock.state === 'absent' ? 'none' : 'unknown',reason:lock.owner ? 'Recorded host, platform or process start identity cannot be verified locally.' : lock.reason};
    if (lock.owner?.host === os.hostname() && lock.owner.platform === process.platform && lock.owner.processStartTime) {
      const evidence=await processEvidence(lock.owner.pid);
      holder=evidence.state === 'absent' ? {state:'exited'} : evidence.state === 'alive' ? {state:evidence.startTime === lock.owner.processStartTime ? 'alive' : 'pid-reused',observedStartTime:evidence.startTime} : {state:'unknown',reason:evidence.reason};
      const after=await this.read();
      if (after.fingerprint !== lock.fingerprint) return this.report(after,'diagnostic',{state:'unknown',reason:'Lock changed during process inspection.'});
    }
    return this.report(lock,mode,holder);
  }
  private report(lock:Lock,mode:string,holder:Record<string,unknown>) {
    const {identity:_,...publicLock}=lock;
    return {workspace:this.workspace,observedAt:new Date().toISOString(),mode,lock:publicLock,holder,recovery:{available:false,reason:'Controlled recovery is not implemented. Do not infer recoverability from age, empty metadata or a single process snapshot.'}};
  }
}
