import { isAbsolute, resolve } from 'node:path';
import { generateImage } from './generate.js';
import { imageFileToDataUri } from './imageUrl.js';
import { imagineImagesDirectory, saveImage } from './save.js';

export const IMAGINE_AUTH_ERROR =
  'Imagine requires a Grok Build connection. Run /connect and choose Grok Build, or set GROK_BUILD_OAUTH_TOKEN.';

export interface ImagineDependencies {
  generateImage: typeof generateImage;
  saveImage: typeof saveImage;
}

export const DEFAULT_IMAGINE_DEPENDENCIES: ImagineDependencies = { generateImage, saveImage };

export interface ImagineRequest {
  token: string | undefined;
  prompt: string;
  aspectRatio: string;
  resolution?: string;
  imagePath?: string;
  outPath?: string;
  directory: string;
  sessionID: string | undefined;
  signal?: AbortSignal;
}

export async function generateAndSaveImage(
  request: ImagineRequest,
  dependencies: ImagineDependencies = DEFAULT_IMAGINE_DEPENDENCIES,
) {
  if (!request.token) throw new Error(IMAGINE_AUTH_ERROR);
  const generated = await dependencies.generateImage({
    token: request.token,
    prompt: request.prompt,
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
    signal: request.signal,
    ...(request.imagePath
      ? {
          imageUrl: await imageFileToDataUri(
            resolve(request.directory, request.imagePath),
            request.signal,
          ),
        }
      : {}),
  });
  return dependencies.saveImage({
    b64: generated.b64,
    directory: imagineImagesDirectory(request.sessionID),
    ...(request.outPath
      ? {
          outPath: isAbsolute(request.outPath)
            ? request.outPath
            : resolve(request.directory, request.outPath),
        }
      : {}),
  });
}
