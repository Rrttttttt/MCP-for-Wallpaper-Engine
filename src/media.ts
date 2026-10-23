import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Fault, hash, json, type Config } from './files.js';
import { readAssetSource, prepareAssetImport, type AssetImport } from './assets.js';
import type { Projects } from './projects.js';

const maxBytes = 40 * 1024 * 1024;
interface Track {
  type: string; format?: string; codec?: string; profile?: string; duration?: number; bitRate?: number;
  width?: number; height?: number; frameRate?: number; rotation?: number; channels?: number; sampleRate?: number; encrypted?: boolean;
}
function active(signal?: AbortSignal) { if (signal?.aborted) throw new Fault('MEDIA_CANCELLED', 'Media probing was cancelled before saving an asset.'); }
async function probe(data: Buffer, signal?: AbortSignal) {
  active(signal);
  const signature = data.toString('ascii', 0, 4);
  const container = signature === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE' ? 'wav' :
    signature.startsWith('ID3') || data[0] === 255 && ((data[1] ?? 0) & 224) === 224 ? 'mp3' :
    data.toString('ascii', 4, 8) === 'ftyp' ? 'mp4' : data.subarray(0, 4).equals(Buffer.from([26,69,223,163])) ? 'webm' : undefined;
  if (!container) throw new Fault('MEDIA_FORMAT', 'Only WAV, MP3, MP4 and WebM containers are supported.');
  if (container === 'wav' && (data.length < 44 || data.readUInt32LE(4) + 8 > data.length)) throw new Fault('INVALID_MEDIA', 'WAV declared size exceeds the available bytes.');
  const raw = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('./media-probe.js', import.meta.url))], {
      shell: false, windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, signal,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
    }, (error, stdout) => error ? reject(new Fault(signal?.aborted ? 'MEDIA_CANCELLED' : 'MEDIA_PROBE_FAILED', 'Media parser was cancelled, failed or exceeded its 5 second process/output limits.')) : resolve(stdout));
    child.stdin?.on('error', () => {}); // A rejected/terminated parser may close its input early.
    child.stdin?.end(data);
  });
  let result: { library?: { name?: string; version?: string }; tracks: Track[] };
  try { result = JSON.parse(raw); } catch { throw new Fault('INVALID_MEDIA', 'Media parser returned invalid metadata.'); }
  if (!Array.isArray(result.tracks) || result.tracks.length > 32) throw new Fault('INVALID_MEDIA', 'Invalid track inventory.');
  const general = result.tracks.find(track => track.type === 'General');
  const audio = result.tracks.filter(track => track.type === 'Audio'), video = result.tracks.filter(track => track.type === 'Video');
  const formatMatches = { wav: general?.format === 'Wave', mp3: general?.format === 'MPEG Audio' && audio.every(track => track.profile === 'Layer 3'), mp4: general?.format === 'MPEG-4', webm: general?.format === 'WebM' };
  if (!formatMatches[container] || !audio.length && !video.length) throw new Fault('MEDIA_FORMAT', 'Container or media tracks were not confirmed by the parser.');
  const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  const duration = general?.duration ?? Math.max(0, ...[...audio, ...video].map(track => track.duration ?? 0));
  if (!finite(duration, 0.001, 3600) || [...audio, ...video].some(track => track.encrypted)) throw new Fault('MEDIA_LIMIT', 'Media must have a known duration up to 1 hour and no reported encryption.');
  if ((container === 'wav' || container === 'mp3') && (video.length || !audio.length)) throw new Fault('MEDIA_FORMAT', 'Audio container has unexpected tracks.');
  for (const track of video) if (!finite(track.width, 1, 8192) || !finite(track.height, 1, 8192) || track.width * track.height > 16777216 || !finite(track.frameRate, 0.001, 240)) throw new Fault('MEDIA_LIMIT', 'Video dimensions or frame rate exceed the metadata budget.');
  for (const track of audio) if (!finite(track.channels, 1, 8) || !finite(track.sampleRate, 1, 192000)) throw new Fault('MEDIA_LIMIT', 'Audio channel or sampling rate exceeds the metadata budget.');
  return { kind: video.length ? 'video' : 'audio', container, durationSeconds: duration, audio, video,
    bytes: data.length, sha256: hash(data), parser: { package: 'mediainfo.js@0.3.8', library: result.library },
    validation: 'metadata-only', playability: 'unverified', warnings: ['Metadata inspection does not fully decode the media or prove Wallpaper Engine/CEF codec support, sound output or frame presentation.'] };
}

export async function inspectMedia(config: Config, sourceRoot: number, sourcePath: string, signal?: AbortSignal) {
  active(signal);
  return { sourceRoot, sourcePath, media: await probe(await readAssetSource(config, sourceRoot, sourcePath, maxBytes, 'MEDIA_LIMIT'), signal) };
}
export async function createVideo(projects: Projects, args: { name: string; title: string; sourceRoot: number; sourcePath: string; expectedSourceHash: string }, signal?: AbortSignal) {
  active(signal);
  const data = await readAssetSource(projects.config,args.sourceRoot,args.sourcePath,maxBytes,'MEDIA_LIMIT');
  if (hash(data) !== args.expectedSourceHash) throw new Fault('SOURCE_CHANGED','Source hash differs from the inspected video; inspect again.');
  const media = await probe(data,signal);
  if (media.kind !== 'video' || !['mp4','webm'].includes(media.container)) throw new Fault('VIDEO_REQUIRED','Video creation requires an MP4/WebM container with a video track.');
  const entry = 'wallpaper.' + media.container;
  const files = new Map([['project.json',Buffer.from(json({title:args.title,type:'video',file:entry}))],[entry,data]]);
  active(signal);
  return { ...await projects.createFiles(args.name,args.title,files,{sourceProjectId:null,templateId:null,mediaSourceHash:media.sha256}), media, originalBytesPreserved:true,
    nextStep:'Open an owned preview and inspect changing decoded frames. Native video codec support, sound and playback are still unverified; this is not a Web video element.' };
}
export async function importMedia(projects: Projects, args: AssetImport, signal?: AbortSignal) {
  active(signal);
  const next = await prepareAssetImport(projects, args, 'MEDIA_EXISTS');
  const data = await readAssetSource(projects.config, args.sourceRoot, args.sourcePath, maxBytes, 'MEDIA_LIMIT');
  if (hash(data) !== args.expectedSourceHash) throw new Fault('SOURCE_CHANGED', 'Source hash differs from the inspected media; inspect again.');
  const media = await probe(data, signal);
  if (path.posix.extname(args.targetPath).toLowerCase() !== '.' + media.container) throw new Fault('MEDIA_EXTENSION', 'Destination extension must match the detected container.');
  next.set(args.targetPath, data);
  active(signal);
  return { ...await projects.replace(args.projectId, args.expectedRevision, next), targetPath: args.targetPath, media, originalBytesPreserved: true,
    nextStep: 'Reference the asset in a suitable project, then verify actual decoding/playback in the official engine. No video project, transcoding or audio-response validation was performed.' };
}
