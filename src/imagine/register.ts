import type { Plugin } from '@opencode/plugin';
import { z } from 'zod';
import { loadConfig, saveConfig } from '../config.js';
import { normalizeAspectRatio } from './aspect.js';
import { parseImagineArgs } from './parseArgs.js';
import {
  DEFAULT_IMAGINE_DEPENDENCIES,
  generateAndSaveImage,
  type ImagineDependencies,
} from './workflow.js';

export const IMAGE_GEN_TOOL = 'image_gen';
export const IMAGINE_COMMAND = 'grok-build-imagine';
export const IMAGINE_TOOL_COMMAND = 'grok-build-imagine:tool';
export const IMAGE_GEN_DESCRIPTION =
  "Generate or edit an image with Grok Imagine; returns the saved image's absolute path. Pass image to edit an existing local file. For a request for one image, call this tool exactly once. Call it multiple times only when the user explicitly requests multiple images. Do not re-read or re-display the image unless the user asks.";

const ImageGenInput = z.object({
  prompt: z
    .string()
    .describe('Describe the image to generate, or the changes to apply to the source image.'),
  image: z
    .string()
    .optional()
    .describe(
      'Local PNG, JPEG, or WebP path to edit. Relative paths use the project working directory.',
    ),
  aspect_ratio: z
    .string()
    .optional()
    .describe(
      "Aspect ratio of the generated image. Defaults to 'auto'. Examples: 1:1, 16:9, 9:16, 3:2, 2:3.",
    ),
});

type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0];
type CommandInvocation = Parameters<Parameters<CommandEditor['add']>[0]['execute']>[0];

export interface ImagineHost {
  ctx: Pick<Plugin.Context, 'tool' | 'command' | 'session' | 'location'>;
  token: (sessionID: string) => Promise<string | undefined>;
  dependencies?: ImagineDependencies;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function registerImagine(host: ImagineHost) {
  const dependencies = host.dependencies ?? DEFAULT_IMAGINE_DEPENDENCIES;
  const active = { tool: false };

  const run = async (input: {
    sessionID: string;
    prompt: string;
    aspectRatio?: string;
    resolution?: string;
    imagePath?: string;
    outPath?: string;
    signal?: AbortSignal;
  }) => {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('Prompt is required');
    if (input.imagePath !== undefined && !input.imagePath.trim()) {
      throw new Error('Image path is required');
    }
    return generateAndSaveImage(
      {
        token: await host.token(input.sessionID),
        prompt,
        aspectRatio: normalizeAspectRatio(input.aspectRatio),
        resolution: input.resolution,
        imagePath: input.imagePath?.trim(),
        outPath: input.outPath,
        directory: host.ctx.location.directory,
        sessionID: input.sessionID,
        signal: input.signal,
      },
      dependencies,
    );
  };

  const say = (sessionID: string, text: string) =>
    host.ctx.session.synthetic({ sessionID, text }).then(() => undefined);

  const toggle = async (invocation: CommandInvocation) => {
    const argument = invocation.prompt.text.trim().toLowerCase();
    if (argument && argument !== 'on' && argument !== 'off' && argument !== 'status') {
      return say(invocation.sessionID, `Usage: /${IMAGINE_TOOL_COMMAND} [on|off|status]`);
    }
    const loaded = loadConfig();
    if (loaded.warning) await say(invocation.sessionID, loaded.warning);
    if (argument === 'status') {
      return say(
        invocation.sessionID,
        `image_gen persisted: ${loaded.config.imagine.enabled ? 'on' : 'off'}; active: ${active.tool ? 'on' : 'off'}`,
      );
    }
    const enabled = argument ? argument === 'on' : !loaded.config.imagine.enabled;
    return Promise.resolve()
      .then(() => saveConfig({ ...loaded.config, imagine: { enabled } }))
      .then(() => host.ctx.tool.reload())
      .then(
        () => say(invocation.sessionID, `image_gen: ${enabled ? 'on' : 'off'}`),
        (error: unknown) =>
          say(invocation.sessionID, `Could not save image_gen setting: ${errorMessage(error)}`),
      );
  };

  await host.ctx.tool.transform((editor) => {
    active.tool = loadConfig().config.imagine.enabled;
    if (!active.tool) return;
    editor.add({
      name: IMAGE_GEN_TOOL,
      description: IMAGE_GEN_DESCRIPTION,
      input: ImageGenInput,
      execute: (input, context) =>
        run({
          sessionID: context.sessionID,
          prompt: input.prompt,
          aspectRatio: input.aspect_ratio,
          imagePath: input.image,
          signal: context.signal,
        }).then(
          (saved) => ({ content: `Saved image to ${saved.absolutePath}` }),
          (error: unknown) => ({ content: `Image Gen error: ${errorMessage(error)}` }),
        ),
    });
  });

  await host.ctx.command.transform((editor) => {
    editor.add({
      name: IMAGINE_COMMAND,
      description: 'Generate or edit an image with Grok Imagine',
      execute: (invocation) =>
        Promise.resolve()
          .then(() => parseImagineArgs(invocation.prompt.text))
          .then((parsed) => run({ sessionID: invocation.sessionID, ...parsed }))
          .then(
            (saved) => say(invocation.sessionID, `Saved image to ${saved.absolutePath}`),
            (error: unknown) => say(invocation.sessionID, `Imagine failed: ${errorMessage(error)}`),
          ),
    });
    editor.add({
      name: IMAGINE_TOOL_COMMAND,
      description: 'Turn the image_gen tool on or off (on|off|status)',
      execute: toggle,
    });
  });
}
