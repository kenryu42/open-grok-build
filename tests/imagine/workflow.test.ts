import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imagineImagesDirectory } from '../../src/imagine/save.js';
import { generateAndSaveImage, IMAGINE_AUTH_ERROR } from '../../src/imagine/workflow.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';
import { imagineDependencies, TEST_PNG_BASE64, tempDir } from './helpers.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-imagine-workflow-');

function request(directory: string, overrides: Record<string, unknown> = {}) {
  return {
    token: 'tok',
    prompt: 'a cat',
    aspectRatio: 'auto',
    directory,
    sessionID: 'ses_1',
    ...overrides,
  };
}

describe('generateAndSaveImage', () => {
  it('refuses to call Imagine without a token', async () => {
    useTempHome();
    const dependencies = imagineDependencies();

    await expect(
      generateAndSaveImage(request(tempDir('imagine-cwd-'), { token: undefined }), dependencies),
    ).rejects.toThrow(IMAGINE_AUTH_ERROR);
    expect(dependencies.generateImage).not.toHaveBeenCalled();
  });

  it('saves into the session image directory', async () => {
    useTempHome();
    const dependencies = imagineDependencies();

    await generateAndSaveImage(request(tempDir('imagine-cwd-')), dependencies);

    expect(dependencies.saveImage).toHaveBeenCalledWith({
      b64: expect.any(String),
      directory: imagineImagesDirectory('ses_1'),
    });
  });

  it.each(['relative', 'absolute'])('edits a source image given its %s path', async (kind) => {
    useTempHome();
    const directory = tempDir('imagine-cwd-');
    const path = join(directory, 'source.png');
    writeFileSync(path, Buffer.from(TEST_PNG_BASE64, 'base64'));
    const dependencies = imagineDependencies();

    await generateAndSaveImage(
      request(directory, { imagePath: kind === 'absolute' ? path : 'source.png' }),
      dependencies,
    );

    expect(dependencies.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: `data:image/png;base64,${TEST_PNG_BASE64}` }),
    );
  });

  it('resolves a relative output override against the project directory', async () => {
    useTempHome();
    const directory = tempDir('imagine-cwd-');
    const dependencies = imagineDependencies();

    await generateAndSaveImage(request(directory, { outPath: 'out/cat.jpg' }), dependencies);

    expect(dependencies.saveImage).toHaveBeenCalledWith(
      expect.objectContaining({ outPath: join(directory, 'out', 'cat.jpg') }),
    );
  });
});
