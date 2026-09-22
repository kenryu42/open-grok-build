import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/config.js';
import {
  IMAGE_GEN_TOOL,
  IMAGINE_COMMAND,
  IMAGINE_TOOL_COMMAND,
  registerImagine,
} from '../../src/imagine/register.js';
import { getOpenGrokBuildDirectory } from '../../src/storage.js';
import { applyTransforms, type FakeContext, fakeContext } from '../opencode/fakeContext.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';
import { imagineDependencies, TEST_PNG_BASE64, tempDir } from './helpers.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-imagine-register-');
const SESSION = 'ses_1';

async function setup(token: string | null = 'tok') {
  const home = useTempHome();
  const directory = tempDir('imagine-cwd-');
  const fake = fakeContext({ directory });
  const dependencies = imagineDependencies();
  const resolveToken = vi.fn(async () => token ?? undefined);
  await registerImagine({ ctx: fake.ctx, token: resolveToken, dependencies });
  return {
    fake,
    home,
    directory,
    dependencies,
    resolveToken,
    editors: applyTransforms(fake),
    reapply: () => applyTransforms(fake),
  };
}

function said(fake: FakeContext) {
  return fake.synthetic.mock.calls.at(-1)?.[0]?.text;
}

function callTool(test: Awaited<ReturnType<typeof setup>>, input: Record<string, unknown>) {
  const tool = test.editors.tool.tools.get(IMAGE_GEN_TOOL);
  if (!tool) throw new Error('image_gen was not registered');
  return tool.execute(input, { sessionID: SESSION });
}

function runCommand(test: Awaited<ReturnType<typeof setup>>, name: string, text: string) {
  const command = test.editors.command.commands.get(name);
  if (!command) throw new Error(`${name} was not registered`);
  return command.execute({ sessionID: SESSION, prompt: { text } });
}

describe('registerImagine tool', () => {
  it('registers image_gen with the single-call guidance', async () => {
    const test = await setup();
    const tool = test.editors.tool.tools.get(IMAGE_GEN_TOOL);

    expect(tool?.description).toContain('For a request for one image, call this tool exactly once');
    expect(tool?.description).toContain('only when the user explicitly requests multiple images');
  });

  it('generates an image with the session account token', async () => {
    const test = await setup();

    await expect(callTool(test, { prompt: 'a cat' })).resolves.toEqual({
      content: 'Saved image to /images/ses_1/cat.jpg',
    });
    expect(test.resolveToken).toHaveBeenCalledWith(SESSION);
    expect(test.dependencies.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'tok', prompt: 'a cat', aspectRatio: 'auto' }),
    );
  });

  it.each([
    [{ prompt: '  ' }, 'Prompt is required'],
    [{ prompt: 'cat', image: ' ' }, 'Image path is required'],
    [{ prompt: 'cat', aspect_ratio: '5:4' }, 'Unsupported aspect ratio'],
  ])('reports %j as a tool error without generating', async (input, expected) => {
    const test = await setup();

    await expect(callTool(test, input)).resolves.toEqual({
      content: expect.stringContaining(`Image Gen error: ${expected}`),
    });
    expect(test.dependencies.generateImage).not.toHaveBeenCalled();
  });

  it('points at /connect when no account is connected', async () => {
    const test = await setup(null);

    await expect(callTool(test, { prompt: 'cat' })).resolves.toEqual({
      content: expect.stringContaining('/connect'),
    });
    expect(test.dependencies.generateImage).not.toHaveBeenCalled();
  });
});

describe('registerImagine commands', () => {
  it.each(['--image', '--edit'])('edits a local image with %s', async (flag) => {
    const test = await setup();
    writeFileSync(join(test.directory, 'source image.png'), Buffer.from(TEST_PNG_BASE64, 'base64'));

    await runCommand(test, IMAGINE_COMMAND, `${flag} "source image.png" Make it blue`);

    expect(test.dependencies.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Make it blue',
        imageUrl: `data:image/png;base64,${TEST_PNG_BASE64}`,
      }),
    );
    expect(said(test.fake)).toBe('Saved image to /images/ses_1/cat.jpg');
  });

  it('reports argument failures without generating', async () => {
    const test = await setup();

    await runCommand(test, IMAGINE_COMMAND, '--wat cat');

    expect(said(test.fake)).toContain('Imagine failed: Unknown option');
    expect(test.dependencies.generateImage).not.toHaveBeenCalled();
  });

  it('toggles the persisted tool setting and reloads tools', async () => {
    const test = await setup();

    await runCommand(test, IMAGINE_TOOL_COMMAND, '');
    expect(loadConfig().config.imagine).toEqual({ enabled: false });
    expect(said(test.fake)).toBe('image_gen: off');
    expect(test.fake.reloads.tool).toBe(1);
    expect(test.reapply().tool.tools.has(IMAGE_GEN_TOOL)).toBe(false);

    await runCommand(test, IMAGINE_TOOL_COMMAND, '');
    expect(loadConfig().config.imagine).toEqual({ enabled: true });
    expect(said(test.fake)).toBe('image_gen: on');
    expect(test.reapply().tool.tools.has(IMAGE_GEN_TOOL)).toBe(true);
  });

  it.each([
    ['on', true],
    ['off', false],
  ])('applies an explicit %s argument', async (argument, enabled) => {
    const test = await setup();

    await runCommand(test, IMAGINE_TOOL_COMMAND, argument);

    expect(loadConfig().config.imagine).toEqual({ enabled });
    expect(said(test.fake)).toBe(`image_gen: ${argument}`);
  });

  it('reports persisted and active state without changing anything', async () => {
    const test = await setup();
    saveConfig({ ...DEFAULT_CONFIG, imagine: { enabled: false } });

    await runCommand(test, IMAGINE_TOOL_COMMAND, 'status');

    expect(said(test.fake)).toBe('image_gen persisted: off; active: on');
    expect(loadConfig().config.imagine).toEqual({ enabled: false });
    expect(test.fake.reloads.tool).toBe(0);
  });

  it('rejects unknown arguments', async () => {
    const test = await setup();

    await runCommand(test, IMAGINE_TOOL_COMMAND, 'all');

    expect(said(test.fake)).toBe('Usage: /grok-build-imagine:tool [on|off|status]');
    expect(loadConfig().config.imagine).toEqual({ enabled: true });
    expect(test.fake.reloads.tool).toBe(0);
  });

  it('keeps the tool registered when the setting cannot be saved', async () => {
    const test = await setup();
    mkdirSync(dirname(getOpenGrokBuildDirectory()), { recursive: true });
    writeFileSync(getOpenGrokBuildDirectory(), 'not a directory');

    await runCommand(test, IMAGINE_TOOL_COMMAND, 'off');

    expect(said(test.fake)).toContain('Could not save image_gen setting:');
    expect(test.fake.reloads.tool).toBe(0);
  });
});
