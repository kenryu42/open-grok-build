import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
import { generateImage } from '../../src/imagine/generate.js';
import { GROK_BUILD_VERSION } from '../../src/opencode/identity.js';
import { TEST_JPEG_BASE64 } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const okFetch = () =>
  vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: TEST_JPEG_BASE64 }] }));

describe('generateImage', () => {
  it('sends a source image to the JSON editing endpoint', async () => {
    const fetchImpl = okFetch();
    await generateImage({
      token: 'secret',
      prompt: 'Make it blue',
      imageUrl: 'data:image/png;base64,source',
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.x.ai/v1/images/edits');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      prompt: 'Make it blue',
      image: { url: 'data:image/png;base64,source', type: 'image_url' },
    });
  });

  it('sends the Grok Build identity and returns JPEG base64', async () => {
    const fetchImpl = okFetch();

    await expect(
      generateImage({ token: 'secret', prompt: 'a cat', aspectRatio: '16:9', fetchImpl }),
    ).resolves.toEqual({ b64: TEST_JPEG_BASE64, mimeType: 'image/jpeg' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.x.ai/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer secret',
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': `open-grok-build/${packageJson.version}`,
          'x-grok-client-version': GROK_BUILD_VERSION,
        }),
        body: JSON.stringify({
          model: 'grok-imagine-image-quality',
          prompt: 'a cat',
          n: 1,
          aspect_ratio: '16:9',
          resolution: '1k',
          response_format: 'b64_json',
        }),
      }),
    );
  });

  it('honors the Imagine base URL and model environment overrides', async () => {
    vi.stubEnv('GROK_BUILD_IMAGINE_BASE_URL', 'https://imagine.test/v1/');
    vi.stubEnv('GROK_BUILD_IMAGINE_MODEL', 'grok-imagine-fast');
    const fetchImpl = okFetch();

    await generateImage({ token: 'secret', prompt: 'cat', fetchImpl });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://imagine.test/v1/images/generations');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'grok-imagine-fast',
    });
  });

  it('maps authorization and malformed response errors', async () => {
    await expect(
      generateImage({
        token: 'secret',
        prompt: 'cat',
        fetchImpl: async () => new Response('denied', { status: 401 }),
      }),
    ).rejects.toThrow('Run /connect and choose Grok Build');

    await expect(
      generateImage({
        token: 'secret',
        prompt: 'cat',
        fetchImpl: async () => Response.json({ data: [] }),
      }),
    ).rejects.toThrow('missing image data');
  });

  it('retries retryable responses up to three attempts', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: TEST_JPEG_BASE64 }] }));
    const result = generateImage({ token: 'secret', prompt: 'cat', fetchImpl });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ b64: TEST_JPEG_BASE64, mimeType: 'image/jpeg' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
