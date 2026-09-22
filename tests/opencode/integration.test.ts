import { describe, expect, it, vi } from 'vitest';
import * as oauth from '../../src/auth/oauth.js';
import { registerGrokBuildIntegration } from '../../src/opencode/integration.js';
import { fakeIntegrationEditor, type MethodRegistration } from './fakeContext.js';

function oauthMethods(methods: MethodRegistration[]) {
  return methods.flatMap((registration) => ('authorize' in registration ? [registration] : []));
}

function fakeSession(credentials: oauth.OAuthCredentials) {
  return {
    url: 'https://auth.x.ai/authorize',
    instructions: 'Open the link',
    finish: vi.fn(() => Promise.resolve(credentials)),
  };
}

function register() {
  const integration = fakeIntegrationEditor();
  registerGrokBuildIntegration(integration.editor as never);
  return integration;
}

const CREDENTIALS = { access: 'a', refresh: 'r', expires: 1_700_000_000_000.7 };

describe('Grok Build integration registration', () => {
  it('registers the integration name, three OAuth methods and the env method', () => {
    const integration = register();

    expect(integration.names.get('grok-build')).toBe('Grok Build');
    expect(integration.methods.map((entry) => entry.method)).toEqual([
      { id: 'browser', type: 'oauth', label: 'Browser login (default)' },
      { id: 'device', type: 'oauth', label: 'Device login (headless)' },
      { id: 'code', type: 'oauth', label: 'Paste callback code (remote)' },
      { type: 'env', names: ['GROK_BUILD_OAUTH_TOKEN'] },
    ]);
    expect(integration.methods.every((entry) => entry.integrationID === 'grok-build')).toBe(true);
  });

  it('authorizes the browser method through the loopback OAuth session', async () => {
    const session = fakeSession(CREDENTIALS);
    const begin = vi.spyOn(oauth, 'beginGrokBuildOAuth').mockResolvedValue(session);
    const method = oauthMethods(register().methods)[0];
    if (!method) throw new Error('missing browser method');

    const authorization = await method.authorize({});

    expect(begin).toHaveBeenCalledWith('open-grok-build');
    expect(authorization.mode).toBe('auto');
    expect(authorization.url).toBe('https://auth.x.ai/authorize');
    expect(authorization.instructions).toBe('Open the link');
    if (authorization.mode !== 'auto') throw new Error('expected an automatic authorization');
    await expect(authorization.callback).resolves.toEqual({
      type: 'oauth',
      methodID: 'browser',
      access: 'a',
      refresh: 'r',
      expires: 1_700_000_000_000,
    });
  });

  it('authorizes the device method without a browser callback', async () => {
    const begin = vi
      .spyOn(oauth, 'beginGrokBuildDeviceOAuth')
      .mockResolvedValue(fakeSession(CREDENTIALS));
    const method = oauthMethods(register().methods)[1];
    if (!method) throw new Error('missing device method');

    const authorization = await method.authorize({});

    expect(begin).toHaveBeenCalledTimes(1);
    expect(authorization.mode).toBe('auto');
  });

  it('completes the code method with a pasted callback', async () => {
    const session = fakeSession(CREDENTIALS);
    const begin = vi.spyOn(oauth, 'beginGrokBuildOAuth').mockResolvedValue(session);
    const method = oauthMethods(register().methods)[2];
    if (!method) throw new Error('missing code method');

    const authorization = await method.authorize({});

    expect(begin).toHaveBeenCalledWith('open-grok-build-manual');
    if (authorization.mode !== 'code') throw new Error('expected a pasted-code authorization');
    await expect(authorization.callback('pasted')).resolves.toMatchObject({ methodID: 'code' });
    expect(session.finish).toHaveBeenCalledWith('pasted');
  });

  it('propagates an authorization failure', async () => {
    vi.spyOn(oauth, 'beginGrokBuildOAuth').mockResolvedValue({
      url: 'https://auth.x.ai/authorize',
      instructions: 'Open the link',
      finish: () => Promise.reject(new Error('denied')),
    });
    const method = oauthMethods(register().methods)[0];
    if (!method) throw new Error('missing browser method');

    const authorization = await method.authorize({});

    if (authorization.mode !== 'auto') throw new Error('expected an automatic authorization');
    await expect(authorization.callback).rejects.toThrow('denied');
  });

  it('refreshes stored credentials while keeping their metadata', async () => {
    const refresh = vi
      .spyOn(oauth, 'refresh')
      .mockResolvedValue({ access: 'a2', refresh: 'r2', expires: 1_800_000_000_000.9 });
    const method = oauthMethods(register().methods)[0];
    if (!method?.refresh) throw new Error('missing refresh callback');

    await expect(
      method.refresh({
        type: 'oauth',
        methodID: 'browser' as never,
        access: 'a',
        refresh: 'r',
        expires: 1_700_000_000_000,
        metadata: { note: 1 },
      }),
    ).resolves.toEqual({
      type: 'oauth',
      methodID: 'browser',
      access: 'a2',
      refresh: 'r2',
      expires: 1_800_000_000_000,
      metadata: { note: 1 },
    });
    expect(refresh).toHaveBeenCalledWith({ access: 'a', refresh: 'r', expires: 1_700_000_000_000 });
  });
});
