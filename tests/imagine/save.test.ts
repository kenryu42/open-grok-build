import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imagineImagesDirectory, saveImage } from '../../src/imagine/save.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';
import { TEST_JPEG_BASE64, tempDir } from './helpers.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-imagine-save-');

describe('saveImage', () => {
  it('writes timestamped images and never overwrites a concurrent sibling', async () => {
    const directory = join(tempDir('imagine-images-'), 'ses_1');
    const saved = await Promise.all(
      Array.from({ length: 4 }, () => saveImage({ b64: TEST_JPEG_BASE64, directory })),
    );

    expect(new Set(saved.map((image) => image.filename)).size).toBe(4);
    for (const image of saved) {
      expect(image.filename).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z(-\d+)?\.jpg$/);
      expect(await fs.readFile(image.absolutePath)).toEqual(
        Buffer.from(TEST_JPEG_BASE64, 'base64'),
      );
    }
  });

  it('honors an output override and creates its parent directory', async () => {
    const outPath = join(tempDir('imagine-out-'), 'nested', 'cat.jpg');

    await expect(
      saveImage({ b64: TEST_JPEG_BASE64, directory: '/nonexistent', outPath }),
    ).resolves.toEqual({ absolutePath: outPath, filename: 'cat.jpg' });
  });

  it('rejects non-JPEG image data', async () => {
    await expect(
      saveImage({ b64: 'aGVsbG8=', directory: tempDir('imagine-bad-') }),
    ).rejects.toThrow('valid JPEG');
  });
});

describe('imagineImagesDirectory', () => {
  it('keeps images per session under the plugin data directory', () => {
    const home = useTempHome();

    expect(imagineImagesDirectory('ses_1')).toBe(
      join(home, '.local', 'share', 'opencode', 'open-grok-build', 'images', 'ses_1'),
    );
    expect(imagineImagesDirectory(undefined).endsWith(join('images', 'no-session'))).toBe(true);
  });
});
