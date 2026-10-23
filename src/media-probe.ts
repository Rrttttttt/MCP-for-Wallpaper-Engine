import { readFileSync } from 'node:fs';
import mediaInfoFactory from 'mediainfo.js';

// Receives only an immutable byte buffer; no user path, URL or external reference is opened.
const data = readFileSync(0);
if (!data.length || data.length > 40 * 1024 * 1024) throw new Error('Media input limit.');
const parser = await mediaInfoFactory({ format: 'object', coverData: false, full: false });
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 120) : undefined;
const number = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : undefined;
try {
  const result = await parser.analyzeData(data.length, (size, offset) => {
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || size < 0 || offset < 0) throw new Error('Invalid chunk request.');
    return data.subarray(offset, Math.min(offset + size, data.length));
  });
  // Never return tags, cover art, filenames, chapters or arbitrary parser JSON to the client.
  const tracks = result.media?.track ?? [];
  if (tracks.length > 32) throw new Error('Track limit.');
  process.stdout.write(JSON.stringify({ library: { name: 'MediaInfoLib', version: text(result.creatingLibrary?.version) }, tracks: tracks.map(track => ({
    type: track['@type'], format: text(track.Format), codec: text(track.CodecID), profile: text(track.Format_Profile),
    duration: 'Duration' in track ? number(track.Duration) : undefined, bitRate: 'BitRate' in track ? number(track.BitRate) : undefined, width: 'Width' in track ? number(track.Width) : undefined,
    height: 'Height' in track ? number(track.Height) : undefined, frameRate: 'FrameRate' in track ? number(track.FrameRate) : undefined,
    rotation: 'Rotation' in track ? number(track.Rotation) : undefined, channels: 'Channels' in track ? number(track.Channels) : undefined,
    sampleRate: 'SamplingRate' in track ? number(track.SamplingRate) : undefined,
    encrypted: 'Encryption' in track && track.Encryption !== undefined
  })) }));
} finally { parser.close(); }
