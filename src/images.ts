import path from 'node:path';
import sharp from 'sharp';
import { Fault, hash, type Config } from './files.js';
import { readAssetSource, prepareAssetImport, type AssetImport } from './assets.js';
import type { Projects } from './projects.js';

const maxBytes = 20 * 1024 * 1024, maxPixels = 16777216, maxEdge = 8192;

export async function imageMetadata(data: Buffer) {
  const format = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' :
    data.subarray(0, 3).equals(Buffer.from([255,216,255])) ? 'jpeg' :
    data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : undefined;
  if (!format) throw new Fault('IMAGE_FORMAT', 'Only static PNG, JPEG and WebP are supported.');
  if (format === 'png') {
    for (let offset = 8; offset + 12 <= data.length;) {
      if (data.toString('ascii', offset + 4, offset + 8) === 'acTL') throw new Fault('IMAGE_FORMAT', 'Animated PNG is not supported.');
      offset += 12 + data.readUInt32BE(offset);
    }
  }
  try {
    const decoder = sharp(data, { failOn: 'warning', limitInputPixels: maxPixels });
    const m = await decoder.metadata();
    if (m.format !== format || (m.pages ?? 1) !== 1) throw new Fault('IMAGE_FORMAT', 'Only single-frame PNG, JPEG and WebP are supported.');
    if (!m.width || !m.height || m.width > maxEdge || m.height > maxEdge || m.width * m.height > maxPixels) throw new Fault('IMAGE_LIMIT', 'Image exceeds 8192 per edge or 16777216 pixels.');
    // metadata() reads headers only; decode every pixel before accepting the original bytes.
    await decoder.timeout({ seconds: 10 }).raw().toBuffer();
    const swapped = m.orientation !== undefined && m.orientation >= 5 && m.orientation <= 8;
    return { format, width: m.width, height: m.height, displayWidth: swapped ? m.height : m.width, displayHeight: swapped ? m.width : m.height,
      orientation: m.orientation ?? 1, channels: m.channels, hasAlpha: m.hasAlpha, space: m.space, depth: m.depth, hasProfile: m.hasProfile,
      bytes: data.length, sha256: hash(data), validation: 'decoded' as const };
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault('INVALID_IMAGE', 'Image could not be fully decoded within the configured limits.');
  }
}

export async function inspectImage(config: Config, sourceRoot: number, sourcePath: string) {
  const data = await readAssetSource(config, sourceRoot, sourcePath, maxBytes, 'IMAGE_LIMIT');
  return { sourceRoot, sourcePath, image: await imageMetadata(data) };
}

export async function importImage(projects: Projects, args: AssetImport) {
  const next = await prepareAssetImport(projects, args, 'IMAGE_EXISTS');
  const data = await readAssetSource(projects.config, args.sourceRoot, args.sourcePath, maxBytes, 'IMAGE_LIMIT');
  if (hash(data) !== args.expectedSourceHash) throw new Fault('SOURCE_CHANGED', 'Source hash differs from the inspected image; inspect again.');
  const image = await imageMetadata(data);
  const extensions: Record<string, string[]> = { png: ['.png'], jpeg: ['.jpg', '.jpeg'], webp: ['.webp'] };
  if (!extensions[image.format]?.includes(path.posix.extname(args.targetPath).toLowerCase())) throw new Fault('IMAGE_EXTENSION', 'Destination extension must match the decoded image format.');
  next.set(args.targetPath, data);
  const saved = await projects.replace(args.projectId, args.expectedRevision, next);
  return { ...saved, targetPath: args.targetPath, image, originalBytesPreserved: true,
    nextStep: 'Reference the imported asset in the project and verify it in the official engine. No resize, orientation correction, Scene TEX compilation or visual quality assessment was performed.' };
}
