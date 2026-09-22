import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getOpenGrokBuildDirectory } from '../storage.js';

export function imagineImagesDirectory(sessionID: string | undefined) {
  return join(getOpenGrokBuildDirectory(), 'images', sessionID || 'no-session');
}

function writeUnique(
  directory: string,
  stamp: string,
  bytes: Buffer,
  attempt: number,
): Promise<string> {
  const imagePath = join(directory, attempt === 1 ? `${stamp}.jpg` : `${stamp}-${attempt}.jpg`);
  return fs.writeFile(imagePath, bytes, { flag: 'wx' }).then(
    () => imagePath,
    (error: NodeJS.ErrnoException) =>
      error.code === 'EEXIST'
        ? writeUnique(directory, stamp, bytes, attempt + 1)
        : Promise.reject(error),
  );
}

export async function saveImage(options: { b64: string; directory: string; outPath?: string }) {
  const bytes = Buffer.from(options.b64, 'base64');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Imagine did not return valid JPEG data');
  }
  const outPath = options.outPath ? resolve(options.outPath) : undefined;
  await fs.mkdir(outPath ? dirname(outPath) : options.directory, { recursive: true });
  if (outPath) {
    await fs.writeFile(outPath, bytes);
    return { absolutePath: outPath, filename: basename(outPath) };
  }
  const absolutePath = await writeUnique(
    options.directory,
    new Date().toISOString().replace(/[:.]/g, '-'),
    bytes,
    1,
  );
  return { absolutePath, filename: basename(absolutePath) };
}
