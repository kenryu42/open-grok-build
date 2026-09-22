import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';

const tempDirs: string[] = [];

export const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';

export const TEST_JPEG_BASE64 = '/9j/2Q==';

export const SOURCE_IMAGE_SIZES = [400 * 1024 - 1, 400 * 1024, 400 * 1024 + 1];

export const NON_IMAGE_CONTENT = ['not an image', 'RIFF0000WAVEfmt ', '\u0089PNG'];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function imagineDependencies() {
  return {
    generateImage: vi.fn(async () => ({ b64: TEST_JPEG_BASE64, mimeType: 'image/jpeg' as const })),
    saveImage: vi.fn(async () => ({ absolutePath: '/images/ses_1/cat.jpg', filename: 'cat.jpg' })),
  };
}
