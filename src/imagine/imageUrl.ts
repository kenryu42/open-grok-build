import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';

export const MAX_SOURCE_IMAGE_BYTES = 400 * 1024;

const SIZE_ERROR = 'Source image exceeds the 400 KiB limit. Resize or compress it before editing.';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SIGNATURE = Buffer.from([255, 216, 255]);

function sniffImageMime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

export async function imageFileToDataUri(filePath: string, signal?: AbortSignal) {
  if ((await stat(filePath)).size > MAX_SOURCE_IMAGE_BYTES) throw new Error(SIZE_ERROR);
  // Read at most one byte beyond the limit, even if the file grows after stat.
  const bytes = await buffer(createReadStream(filePath, { end: MAX_SOURCE_IMAGE_BYTES, signal }));
  if (bytes.length > MAX_SOURCE_IMAGE_BYTES) throw new Error(SIZE_ERROR);
  const mime = sniffImageMime(bytes);
  if (!mime)
    throw new Error(`Unsupported image file: ${filePath}. Use a PNG, JPEG, or WebP image.`);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
