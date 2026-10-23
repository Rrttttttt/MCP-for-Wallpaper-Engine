// Explicit official-engine acceptance. Plays a short low-amplitude synthetic tone on the default output.
// No user artwork, desktop selection, engine settings, system volume or global playback commands are changed.
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import sharp from 'sharp';
import {loadConfig,hash} from '../dist/files.js';
import {Engine} from '../dist/engine.js';
import {Projects} from '../dist/projects.js';
import {nativeCall} from '../dist/native.js';

const root=fileURLToPath(new URL('../',import.meta.url)),base=await loadConfig(path.join(root,'we.config.json'));
const fixtures=path.join(root,'test/fixtures/media'),run=path.join(root,'.we-mcp','av-verification',randomUUID());
const workspace=path.join(run,'data'); await fs.mkdir(run,{recursive:true});
const config=path.join(run,'config.json');
await fs.writeFile(config,JSON.stringify({...base,workspace,assetRoots:[fixtures],projectRoots:[]}));
const report={startedAt:new Date().toISOString(),branches:[],steps:[],cleanupErrors:[],sourceHashes:{}};
for(const name of ['motion.mp4','motion.webm']) report.sourceHashes[name]=hash(await fs.readFile(path.join(fixtures,name)));
const client=new Client({name:'video-audio-acceptance',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js'),'--config',config],stderr:'inherit'});
const active=new Map();
assert.ok(process.argv.length===2 || process.argv.length===3&&process.argv[2]==='--audio-only','Only optional --audio-only is supported.');
const audioOnly=process.argv[2]==='--audio-only';report.scope=audioOnly?'audio-only':'native-mp4-native-webm-web-webm-audio';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function call(name,args={}) {
  const response=await client.callTool({name,arguments:args},{timeout:60000}),value=response.structuredContent;
  assert.ok(response.content.every(c=>c.type==='text'));
  report.steps.push({name,result:value});
  if(name==='we_preview_open') { const p=value.error?.details??value; if(p.previewId) active.set(p.previewId,p); }
  if(name==='we_preview_close'&&!response.isError) active.delete(args.previewId);
  if(response.isError) throw new Error(JSON.stringify(value));
  return value;
}
async function closeAll() { for(const p of [...active.values()]) await call('we_preview_close',{previewId:p.previewId}); }
async function branch(name,work) {
  if(audioOnly&&name!=='real-system-audio-response') return;
  const entry={name,passed:false};report.branches.push(entry);
  try { Object.assign(entry,await work()); entry.passed=true; }
  catch(e) { entry.error=e.stack; console.error(name+': '+e.message); }
  finally { try {await closeAll()} catch(e) {report.cleanupErrors.push(e.message)} }
  console.log(name+': '+(entry.passed?'passed':'FAILED'));
}
async function observe(p,options={}) {
  const r=await call('we_preview_observe',{previewId:p.previewId,...options});
  assert.equal(r.complete,true);assert.deepEqual(r.issues,[]);return r;
}
async function samplePixels(file) {
  const {width,height}=await sharp(file).metadata();
  return sharp(file).extract({left:Math.floor(width*.2),top:Math.floor(height*.2),width:Math.floor(width*.6),height:Math.floor(height*.6)}).resize(80,45).removeAlpha().raw().toBuffer();
}
function difference(a,b) { assert.equal(a.length,b.length);return a.reduce((n,v,i)=>n+Math.abs(v-b[i]),0)/a.length; }
async function motionProof(p,backend) {
  const observation=await observe(p,{backend,count:3,intervalMs:700});
  const frames=await Promise.all(observation.images.map(samplePixels));
  const differences=frames.slice(1).map(frame=>difference(frames[0],frame));
  assert.ok(differences.some(d=>d>2),'Decoded image content did not change; window/frame receipt is insufficient.');
  assert.ok(frames.every(frame=>frame.some(v=>v>80)),'Blank/dark frame');
  return {images:observation.images,differences,diagnostics:observation.evidence?.diagnostics};
}
function toneWav() {
  const rate=48000,seconds=8,bytes=rate*seconds*2,data=Buffer.alloc(44+bytes);
  data.write('RIFF');data.writeUInt32LE(36+bytes,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);
  data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);
  data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(bytes,40);
  for(let i=0;i<rate*seconds;i++) data.writeInt16LE(Math.round(32767*.03*Math.sin(2*Math.PI*110*i/rate)*Math.min(1,i/(rate*.05),(rate*seconds-i)/(rate*.05))),44+i*2);
  return data;
}
let toneCompletion;
try {
  await client.connect(transport);report.probe=await call('we_environment_probe');
  for(const extension of ['mp4','webm']) await branch('native-video-'+extension,async()=>{
    const inspected=await call('we_media_inspect',{sourceRoot:0,sourcePath:'motion.'+extension});
    const project=await call('we_video_create',{name:'video-'+extension,title:'Synthetic native '+extension,sourceRoot:0,sourcePath:'motion.'+extension,expectedSourceHash:inspected.media.sha256});
    assert.equal(project.manifest.type,'video');assert.equal(project.media.playability,'unverified');
    const p=await call('we_preview_open',{projectId:project.projectId,width:960,height:540});
    const proof=await motionProof(p,'native');
    assert.equal((await call('we_project_inspect',{projectId:project.projectId})).revision,project.revision);
    return {...proof,projectId:project.projectId,codec:inspected.media.video,scope:'Visible changing native frames only; sound, HDR and long-run performance unverified.'};
  });
  await branch('web-video-webm',async()=>{
    let project=await call('we_project_create',{name:'web-video',title:'Synthetic WebM video'});
    const media=await call('we_media_import',{projectId:project.projectId,expectedRevision:project.revision,sourceRoot:0,sourcePath:'motion.webm',expectedSourceHash:report.sourceHashes['motion.webm'],targetPath:'media/motion.webm'});
    const html='<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#000}video{width:100%;height:100%;object-fit:contain}</style><video id="video" autoplay muted loop playsinline src="media/motion.webm"></video><script src="video.js"></script>';
    const js="var v=document.getElementById('video');window.__weDiagnostics={ready:true};setInterval(function(){window.__weDiagnostics={ready:true,currentTime:v.currentTime,paused:v.paused,readyState:v.readyState,width:v.videoWidth,height:v.videoHeight,decodedFrames:v.webkitDecodedFrameCount,error:v.error?{code:v.error.code,message:v.error.message}:null}},50);";
    await call('we_project_apply',{projectId:project.projectId,expectedRevision:media.revision,changes:[{path:'index.html',content:html},{path:'video.js',content:js}]});
    const p=await call('we_preview_open',{projectId:project.projectId,width:960,height:540});
    const before=(await observe(p,{backend:'cef'})).evidence.diagnostics;
    const proof=await motionProof(p,'cef'),after=proof.diagnostics;
    assert.equal(after.error,null);assert.equal(after.paused,false);assert.ok(after.readyState>=2);assert.equal(after.width,160);assert.equal(after.height,90);
    assert.ok(after.decodedFrames>before.decodedFrames,'CEF decoded frame count did not advance');
    return {...proof,before,scope:'Muted WebM in owned CEF only; no MP4-in-CEF compatibility claim.'};
  });
  await branch('real-system-audio-response',async()=>{
    const project=await call('we_project_create',{name:'audio-response',title:'Real audio callback acceptance',properties:{speed:0,density:500}});
    const source=await call('we_project_inspect',{projectId:project.projectId,readFiles:['wallpaper.js']});
    const script=source.contents['wallpaper.js'];
    const pointerLines=script.split('\n').filter(line=>line.includes("window.addEventListener('mousemove'"));
    assert.equal(pointerLines.length,1,'Review the acceptance isolation if the template input handler changes.');
    assert.ok(pointerLines[0].includes('mouseX =')&&pointerLines[0].includes('mouseY ='));
    // Controlled test copy only: remove parallax input. The real audio callback and drawing stay verbatim.
    const isolated=script.replace(pointerLines[0],'  // Acceptance copy: mouse parallax disabled for stable audio pixel controls.');
    await call('we_project_apply',{projectId:project.projectId,expectedRevision:source.revision,changes:[{path:'wallpaper.js',content:isolated}]});
    const p=await call('we_preview_open',{projectId:project.projectId,width:1280,height:720});
    async function samples(label) {
      const rows=[];
      for(let i=0;i<3;i++) {
        await delay(250);
        const r=await observe(p,{backend:'cef'});rows.push({diagnostics:r.evidence.diagnostics,image:r.images[0]});
      }
      report.steps.push({name:'audio-samples',label,rows});return rows;
    }
    await delay(600);const silence=await samples('before-stimulus');
    const baseline=Math.max(...silence.map(r=>r.diagnostics.audioBass));
    // Bass is the mean of 16 FFT bins, not the 3% PCM peak; require a floor plus a 10x control ratio.
    const minimumSignal=.001;
    assert.ok(baseline<minimumSignal,'Baseline is not quiet; no system mute or external audio changes attempted.');
    const tone=path.join(run,'tone-110hz.wav');await fs.writeFile(tone,toneWav());
    console.log('Playing 8-second synthetic 110 Hz tone at 3% digital amplitude; system volume unchanged.');
    toneCompletion=new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-File',path.join(root,'scripts/play-test-tone.ps1'),'-WaveFile',tone],{windowsHide:true,shell:false,timeout:12000,maxBuffer:4096},(error,stdout,stderr)=>resolve({error:error?.message,stdout,stderr})));
    await delay(1000);const enabled=await samples('tone-response-on');
    await call('we_preview_set_properties',{previewId:p.previewId,properties:{audio:false}});
    const disabled=await samples('tone-response-off');
    const player=await toneCompletion;assert.equal(player.error,undefined);assert.ok(player.stdout.includes('tone-loaded'));
    await call('we_preview_set_properties',{previewId:p.previewId,properties:{audio:true}});
    await delay(800);const after=await samples('after-stimulus');
    const peak=Math.max(...enabled.map(r=>r.diagnostics.audioBass));
    assert.ok(enabled.at(-1).diagnostics.audioCallbacks>silence.at(-1).diagnostics.audioCallbacks,'No real host audio callbacks during stimulus');
    assert.ok(peak>Math.max(minimumSignal,baseline*10),'Synthetic sound did not produce distinguishable real host input');
    assert.ok(enabled.some(r=>r.diagnostics.renderedAudioGain>minimumSignal));
    assert.ok(disabled.some(r=>r.diagnostics.audioBass>minimumSignal),'Response-off control was not sampled during actual sound');
    assert.ok(disabled.every(r=>r.diagnostics.settings.audio===false&&r.diagnostics.renderedAudioGain===0));
    assert.ok(Math.max(...after.map(r=>r.diagnostics.audioBass))<minimumSignal,'Host input did not settle after stimulus');
    const pixels=await Promise.all([silence.at(-1).image,enabled.reduce((a,b)=>a.diagnostics.renderedAudioGain>b.diagnostics.renderedAudioGain?a:b).image,disabled.at(-1).image,after.at(-1).image].map(samplePixels));
    const [soundDelta,offDelta,afterDelta]=pixels.slice(1).map(frame=>difference(pixels[0],frame));
    report.steps.push({name:'audio-pixel-comparison',baseline,peak,soundDelta,offDelta,afterDelta});
    assert.ok([...silence,...enabled,...disabled,...after].every(r=>r.diagnostics.elapsed===silence[0].diagnostics.elapsed),'Animation time changed during the audio controls');
    assert.ok(offDelta<=.001&&afterDelta<=.001,'Control pixels drifted; do not attribute their change to sound');
    assert.ok(soundDelta>offDelta+.001&&soundDelta>afterDelta+.001,'Sound did not produce a distinct pixel response against controls');
    assert.ok([...silence,...enabled,...disabled,...after].every(r=>r.diagnostics.errors.length===0));
    return {baseline,peak,soundDelta,offDelta,afterDelta,player,isolation:{templateScriptHash:hash(script),acceptanceScriptHash:hash(isolated),change:'Only the mousemove listener is removed in this fresh managed test copy; speed=0. Audio registration, FFT handling and drawing code are unchanged.'},scope:'Host loopback FFT callbacks, rendered gain and controlled frame differences; no acoustic microphone measurement or endpoint volume change.'};
  });
} catch(e) {report.error=e.stack;console.error(e)}
finally {
  if(toneCompletion) report.toneCleanup=await toneCompletion;
  try{await closeAll()}catch(e){report.cleanupErrors.push(e.message)}
  try{await client.close()}catch(e){report.cleanupErrors.push(e.message)}
  try {
    const entries=JSON.parse(await fs.readFile(path.join(workspace,'active-previews.json')));
    // If the transport died, close only this run's persisted, reverified window identities; never delete a lock.
    for(const p of entries) {
      assert.equal(path.dirname(p.directory),path.join(workspace,'previews'));assert.ok(p.windowIdentity);
      const request={windowName:p.windowName,installDir:base.installDir,expected:p.windowIdentity};
      try {await nativeCall('absent',request,300);continue} catch {}
      await nativeCall('verify',request);
      await new Engine(base,new Projects(base)).cli(['-control','closeWallpaper','-location',p.windowName]);
      await nativeCall('absent',request);
    }
    assert.deepEqual(entries,[],'Shutdown left recovery records; diagnose the lock through MCP, never delete it.');
    await assert.rejects(fs.access(path.join(workspace,'server.lock')),{code:'ENOENT'});
    for(const [name,sha] of Object.entries(report.sourceHashes)) assert.equal(hash(await fs.readFile(path.join(fixtures,name))),sha);
  } catch(e) {report.cleanupErrors.push(e.message)}
  report.passed=!report.error&&report.branches.length===(audioOnly?1:4)&&report.branches.every(b=>b.passed)&&report.cleanupErrors.length===0;
  report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Report: '+path.join(run,'report.json'));if(!report.passed)process.exitCode=1;
}
