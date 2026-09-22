import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imageFileToDataUri, MAX_SOURCE_IMAGE_BYTES } from '../../src/imagine/imageUrl.js';
import { NON_IMAGE_CONTENT, SOURCE_IMAGE_SIZES, TEST_PNG_BASE64, tempDir } from './helpers.js';

function writeSource(contents: Buffer | string, name = 'source.png') {
  const path = join(tempDir('imagine-source-'), name);
  writeFileSync(path, contents);
  return path;
}

describe('imageFileToDataUri', () => {
  it.each(SOURCE_IMAGE_SIZES)('enforces the 400 KiB limit for a %i-byte file', async (size) => {
    const bytes = Buffer.alloc(size);
    Buffer.from(TEST_PNG_BASE64, 'base64').copy(bytes);
    const path = writeSource(bytes);

    if (size > MAX_SOURCE_IMAGE_BYTES) {
      await expect(imageFileToDataUri(path)).rejects.toThrow('400 KiB');
      return;
    }
    await expect(imageFileToDataUri(path)).resolves.toBe(
      `data:image/png;base64,${bytes.toString('base64')}`,
    );
  });

  it.each(NON_IMAGE_CONTENT)('rejects unrecognized file content %j', async (content) => {
    await expect(imageFileToDataUri(writeSource(content))).rejects.toThrow('Unsupported image');
  });

  it.each([
    ['image/png', Buffer.from(TEST_PNG_BASE64, 'base64')],
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])],
    ['image/webp', Buffer.concat([Buffer.from('RIFF0000WEBPVP8 '), Buffer.alloc(16)])],
  ])('recognizes %s data', async (mime, bytes) => {
    await expect(imageFileToDataUri(writeSource(bytes))).resolves.toBe(
      `data:${mime};base64,${bytes.toString('base64')}`,
    );
  });
});
