import * as fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Fault, hash, json, noLinks, atomicWrite } from './files.js';

const execute = promisify(execFile);
const ownerBase = z.object({
  service:z.literal('wallpaper-engine-mcp'), sessionId:z.uuid(),
  pid:z.number().int().min(1).max(2147483647), host:z.string().min(1).max(255),
  platform:z.string().min(1).max(32), processStartTime:z.string().regex(/^\d{15,20}$/).nullable(),
  workspace:z.string().min(1).max(4096), createdAt:z.iso.datetime()
}).strict();
const ownerSchema=z.discriminatedUnion('version',[
  ownerBase.extend({version:z.literal(1)}).strict(),
  ownerBase.extend({version:z.literal(2),coordination:z.literal('windows-pipe-v1')}).strict()
]);
type Owner = z.infer<typeof ownerSchema>;
type ProcessEvidence = {state:'alive'|'absent'|'unknown'; startTime?:string; reason?:string};
type Lock = {state:'present'|'absent'|'unsafe'|'unknown'; fingerprint:string|null; owner:Owner|null; reason?:string; identity?:string};
const canonical = (value:string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const identity = (s:BigIntStats) => json([String(s.dev),String(s.ino),String(s.birthtimeNs)]);
const stamp = (s:BigIntStats) => identity(s) + String(s.mtimeNs) + ':' + String(s.size);

async function powershell(script:string) {
  const shell=path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const {stdout}=await execute(shell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,timeout:3000,maxBuffer:8192});
  return JSON.parse(stdout.trim());
}
async function readRegular(file:string,limit:number) {
  await noLinks(file);
  const handle=await fs.open(file,'r');
  try {
    const start=await handle.stat({bigint:true});
    if (!start.isFile() || start.nlink !== 1n) throw new Fault('UNSAFE_PATH','Metadata must be an ordinary file without additional hard links.');
    if (start.size > BigInt(limit)) throw new Fault('LOCK_READ_LIMIT','Metadata exceeds its read limit.');
    const buffer=Buffer.alloc(limit+1);let length=0;
    while (length < buffer.length) {
      const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);
      if (!bytesRead) break;length+=bytesRead;
    }
    if (length > limit) throw new Fault('LOCK_READ_LIMIT','Metadata exceeds its read limit.');
    if (stamp(start) !== stamp(await handle.stat({bigint:true})) || stamp(start) !== stamp(await fs.lstat(file,{bigint:true}))) throw new Fault('LOCK_CHANGED','Metadata changed during inspection.');
    return buffer.subarray(0,length);
  } finally { await handle.close(); }
}

// Fixed, read-only local query. No command line, arbitrary script, remote host or public PID argument.
async function processEvidence(pid:number):Promise<ProcessEvidence> {
  if (process.platform !== 'win32') return {state:'unknown',reason:'Process start identity is currently implemented only on Windows.'};
  try {
    const script = `$ErrorActionPreference='Stop'; $p=$null; try { $p=[System.Diagnostics.Process]::GetProcessById(${pid}) } catch { if ($_.Exception.GetBaseException() -is [System.ArgumentException]) { @{state='absent'} | ConvertTo-Json -Compress; exit }; throw }; try { if ($p.HasExited) { @{state='absent'} | ConvertTo-Json -Compress } else { @{state='alive'; startTime=$p.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Compress } } finally { $p.Dispose() }`;
    return z.union([
      z.object({state:z.literal('absent')}).strict(),
      z.object({state:z.literal('alive'),startTime:z.string().regex(/^\d{15,20}$/)}).strict()
    ]).parse(await powershell(script));
  } catch { return {state:'unknown',reason:'Local process query failed, was denied or timed out; this is not evidence of exit.'}; }
}

export class WorkspaceLock {
  private owned?:{fingerprint:string; identity:string};
  readonly workspace:string;
  constructor(workspace:string) { this.workspace=path.resolve(workspace); }
  get directory() { return path.join(this.workspace,'server.lock'); }
  get isOwner() { return this.owned !== undefined; }

  // All v2 acquisition, release and recovery mutations share this OS-owned critical section.
  // No persistent guard directory and no application commands are accepted over the pipe.
  private async coordinate<T>(work:()=>Promise<T>):Promise<T> {
    if (process.platform !== 'win32') return work(); // Legacy project operations only; recovery refuses other platforms.
    if (process.env.NODE_PENDING_PIPE_INSTANCES !== undefined) throw new Fault('WORKSPACE_COORDINATION_UNAVAILABLE','Unset NODE_PENDING_PIPE_INSTANCES before using workspace coordination.');
    await noLinks(this.workspace);
    const root=await fs.lstat(this.workspace,{bigint:true}),rootIdentity=identity(root);
    if (!root.isDirectory()) throw new Fault('UNSAFE_PATH','Workspace must be an ordinary directory.');
    const name='\\\\.\\pipe\\we-mcp-workspace-'+hash(rootIdentity);
    const deadline=performance.now()+1000;
    let guard:net.Server;
    for (;;) {
      guard=net.createServer(socket=>{socket.on('error',()=>{});socket.destroy()});
      try {
        await new Promise<void>((resolve,reject)=>{guard.once('error',reject);guard.listen({path:name,exclusive:true},resolve)});
        break;
      } catch(e) {
        await new Promise<void>(resolve=>guard.close(()=>resolve()));
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw new Fault('WORKSPACE_COORDINATION_UNAVAILABLE','Cannot acquire the workspace coordination pipe.');
        if (performance.now() >= deadline) throw new Fault('WORKSPACE_COORDINATION_BUSY','Another workspace transition is in progress; diagnose again and retry.');
        await delay(25);
      }
    }
    try {
      await noLinks(this.workspace);
      if (identity(await fs.lstat(this.workspace,{bigint:true})) !== rootIdentity) throw new Fault('WORKSPACE_OWNERSHIP_LOST','Workspace changed during coordination.');
      return await work();
    } finally { await new Promise<void>(resolve=>guard.close(()=>resolve())); }
  }

  private async read(directory=this.directory):Promise<Lock> {
    try {
      await noLinks(directory);
      let before:BigIntStats;
      try { before=await fs.lstat(directory,{bigint:true}); }
      catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {state:'absent',fingerprint:null,owner:null}; throw e; }
      if (!before.isDirectory()) throw new Fault('UNSAFE_PATH','Workspace lock is not an ordinary directory.');
      const entries:string[]=[];
      for await (const entry of await fs.opendir(directory)) {
        entries.push(entry.name);
        if (entries.length > 8) throw new Fault('LOCK_READ_LIMIT','Lock directory has unexpected entries.');
      }
      let raw:Buffer|null=null, owner:Owner|null=null, reason='missing-owner-metadata';
      if (entries.includes('owner.json')) {
        raw=await readRegular(path.join(directory,'owner.json'),8192);
        reason='invalid-owner-metadata';
        try {
          const parsed=ownerSchema.parse(JSON.parse(raw.toString('utf8')));
          if (canonical(parsed.workspace) === canonical(this.workspace)) {owner=parsed;reason='owner-recorded';}
        } catch { /* Invalid metadata is unknown, never a stale-lock signal. */ }
      }
      if (entries.some(name=>name !== 'owner.json')) {owner=null;reason='unexpected-lock-entries';}
      const after=await fs.lstat(directory,{bigint:true});
      if (stamp(before) !== stamp(after)) throw new Fault('LOCK_CHANGED','Lock directory changed during inspection.');
      return {state:'present',identity:identity(after),fingerprint:hash(json([stamp(after),entries.sort(),raw === null ? null : hash(raw)])),owner,reason};
    } catch(e) {
      return {state:e instanceof Fault && e.code === 'UNSAFE_PATH' ? 'unsafe' : 'unknown',fingerprint:null,owner:null,reason:e instanceof Fault ? e.code : ((e as NodeJS.ErrnoException).code ?? 'LOCK_READ_FAILED')};
    }
  }

  async acquire() {
    await noLinks(this.workspace);
    await fs.mkdir(this.workspace,{recursive:true});
    await this.coordinate(()=>this.create());
  }
  private async create() {
    try { await fs.mkdir(this.directory); }
    catch(e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Fault('WORKSPACE_LOCKED','Workspace lock exists. Use we_workspace_diagnose; no automatic recovery is attempted.');
      throw e;
    }
    const acquiredIdentity=identity(await fs.lstat(this.directory,{bigint:true}));
    const evidence=await processEvidence(process.pid);
    const owner:Owner={...(process.platform === 'win32' ? {version:2,coordination:'windows-pipe-v1'} as const : {version:1} as const),service:'wallpaper-engine-mcp',sessionId:randomUUID(),pid:process.pid,host:os.hostname(),platform:process.platform,processStartTime:evidence.startTime ?? null,workspace:this.workspace,createdAt:new Date().toISOString()};
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
    await this.coordinate(async()=>{
      await this.assertOwned();
      await fs.unlink(path.join(this.directory,'owner.json'));
      if (identity(await fs.lstat(this.directory,{bigint:true})) !== this.owned!.identity) throw new Fault('WORKSPACE_OWNERSHIP_LOST','Lock directory was replaced during release.');
      await fs.rmdir(this.directory); // Non-recursive: never delete unexpected contents.
      this.owned=undefined;
    });
  }

  private async eligibility(lock:Lock,holder:Record<string,unknown>) {
    let reason='OWNER_UNKNOWN';
    if (this.owned) reason='SESSION_ALREADY_OWNS_LOCK';
    else if (lock.owner) {
      if (lock.owner.version !== 2) reason='LEGACY_LOCK_PROTOCOL';
      else if (holder.state !== 'exited') reason='OWNER_NOT_PROVEN_EXITED';
      else if (process.platform !== 'win32' || process.env.NODE_PENDING_PIPE_INSTANCES !== undefined) reason='UNSUPPORTED_COORDINATION';
      else {
        try {
          const physical=await fs.realpath(this.workspace),drive=/^([a-z]):\\/i.exec(physical)?.[1];
          if (drive) {
            const info=await powershell(`$ErrorActionPreference='Stop'; $d=[System.IO.DriveInfo]::new('${drive}'); @{kind=$d.DriveType.ToString(); format=$d.DriveFormat} | ConvertTo-Json -Compress`);
            if (info.kind === 'Fixed' && info.format === 'NTFS') return {available:true,reason:'Recorded owner exited; fingerprint and all conditions will be rechecked under coordination.',requiresConfirmation:true};
          }
          reason='LOCAL_FIXED_NTFS_REQUIRED';
        } catch { reason='FILESYSTEM_QUERY_UNAVAILABLE'; }
      }
    }
    return {available:false,reason,requiresConfirmation:true};
  }

  async recover(expectedFingerprint:string) {
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Fault('INVALID_LOCK_FINGERPRINT','Use the fingerprint returned by we_workspace_diagnose.');
    return this.coordinate(async()=>{
      const evidence=await this.diagnose();
      if (evidence.lock.fingerprint !== expectedFingerprint) throw new Fault('WORKSPACE_LOCK_CHANGED','Lock no longer matches the supplied fingerprint; diagnose again.');
      if (!evidence.recovery.available) throw new Fault('WORKSPACE_RECOVERY_REFUSED','Lock does not meet controlled recovery conditions.',evidence);
      const recoveryId=randomUUID(),archive=path.join(this.workspace,'lock-recoveries',recoveryId);
      const record=path.join(archive,'record.json');let phase='preparing';
      try {
        await noLinks(archive);await fs.mkdir(archive,{recursive:true});
        const audit={recoveryId,createdAt:new Date().toISOString(),expectedFingerprint,previousOwner:evidence.lock.owner};
        await atomicWrite(record,json({...audit,state:'prepared'}));
        let previousRegistry:{state:string;path?:string;sha256?:string;bytes?:number}={state:'absent'};
        try {
          const registry=await readRegular(path.join(this.workspace,'active-previews.json'),1024*1024);
          const target=path.join(archive,'active-previews.json');await fs.writeFile(target,registry,{flag:'wx'});
          previousRegistry={state:'archived',path:target,sha256:hash(registry),bytes:registry.length};
        } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if ((await this.read()).fingerprint !== expectedFingerprint) throw new Fault('WORKSPACE_LOCK_CHANGED','Lock changed before archival.');
        await fs.rename(this.directory,path.join(archive,'server.lock'));phase='archived';
        if ((await this.read(path.join(archive,'server.lock'))).fingerprint !== expectedFingerprint) throw new Fault('WORKSPACE_LOCK_CHANGED','Archived lock no longer matches the inspected evidence.');
        await atomicWrite(record,json({...audit,state:'archived',previousRegistry}));
        await this.create();phase='acquired';
        await atomicWrite(record,json({...audit,state:'acquired',previousRegistry}));
        return {state:'recovered',mode:'owner',recoveryId,archive,previousRegistry,previewOwnership:'not-adopted',nextAction:'Inspect project revision and validation before editing. Interrupted project edits and previous previews have not been repaired or adopted.'};
      } catch(e) {
        throw new Fault('WORKSPACE_RECOVERY_INCOMPLETE','Recovery stopped; evidence and any acquired lock are preserved. Diagnose before retrying.',{recoveryId,archive,phase,mode:this.isOwner ? 'owner' : 'diagnostic',cause:e instanceof Fault ? e.code : (e as NodeJS.ErrnoException).code ?? 'OPERATION_FAILED'});
      }
    });
  }

  async diagnose() {
    const lock=await this.read();
    const mode=this.owned && lock.fingerprint === this.owned.fingerprint ? 'owner' : 'diagnostic';
    let holder:{state:'alive'|'exited'|'pid-reused'|'unknown'|'none';reason?:string;observedStartTime?:string}={state:lock.state === 'absent' ? 'none' : 'unknown',reason:lock.owner ? 'Recorded host, platform or process start identity cannot be verified locally.' : lock.reason};
    if (lock.owner?.host === os.hostname() && lock.owner.platform === process.platform && lock.owner.processStartTime) {
      const evidence=await processEvidence(lock.owner.pid);
      holder=evidence.state === 'absent' ? {state:'exited'} : evidence.state === 'alive' ? {state:evidence.startTime === lock.owner.processStartTime ? 'alive' : 'pid-reused',observedStartTime:evidence.startTime} : {state:'unknown',reason:evidence.reason};
    }
    const recovery=await this.eligibility(lock,holder),after=await this.read();
    if (after.fingerprint !== lock.fingerprint) return this.report(after,'diagnostic',{state:'unknown',reason:'Lock changed during inspection.'},{available:false,reason:'LOCK_CHANGED',requiresConfirmation:true});
    return this.report(lock,mode,holder,recovery);
  }
  private report(lock:Lock,mode:string,holder:Record<string,unknown>,recovery:{available:boolean;reason:string;requiresConfirmation:boolean}) {
    const {identity:_,...publicLock}=lock;
    return {workspace:this.workspace,observedAt:new Date().toISOString(),mode,lock:publicLock,holder,recovery};
  }
}
