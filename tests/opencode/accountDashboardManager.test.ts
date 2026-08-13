import { afterEach, describe, expect, it, vi } from 'vitest';
import * as oauth from '../../src/auth/oauth.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/config.js';
import {
  type AccountRuntime,
  OpenCodeAccountDashboardManager,
} from '../../src/opencode/accountDashboardManager.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-dashboard-manager-');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function runtime(): AccountRuntime {
  return {
    authenticatedProviders: () => ['grok-build'],
    environmentProviders: () => [],
    token: vi.fn(async () => 'access'),
    setAuth: vi.fn(async () => undefined),
    removeAuth: vi.fn(async () => undefined),
    activate: vi.fn(),
    rotation: { clearRecentExhaustion: vi.fn() },
  };
}

describe('OpenCodeAccountDashboardManager', () => {
  it('adds accounts without exposing credentials and activates through the router', () => {
    useTempHome();
    saveConfig(DEFAULT_CONFIG);
    const accountRuntime = runtime();
    const manager = new OpenCodeAccountDashboardManager(accountRuntime);

    const added = manager.add('Work');
    manager.activate(added.provider);

    expect(added).toMatchObject({
      provider: 'grok-build-2',
      label: 'Work',
      authenticated: false,
    });
    expect(added).not.toHaveProperty('access');
    expect(accountRuntime.activate).toHaveBeenCalledWith('grok-build-2');
  });

  it('rejects primary-account removal before touching OpenCode credentials', async () => {
    useTempHome();
    saveConfig(DEFAULT_CONFIG);
    const accountRuntime = runtime();
    const manager = new OpenCodeAccountDashboardManager(accountRuntime);

    await expect(manager.remove('grok-build')).rejects.toThrow('cannot be removed');

    expect(accountRuntime.removeAuth).not.toHaveBeenCalled();
  });

  it('marks environment credentials immutable', async () => {
    useTempHome();
    saveConfig(DEFAULT_CONFIG);
    const accountRuntime = runtime();
    accountRuntime.environmentProviders = () => ['grok-build'];
    const manager = new OpenCodeAccountDashboardManager(accountRuntime);

    expect(manager.snapshot().accounts[0]?.environment).toBe(true);
    await expect(manager.logout('grok-build')).rejects.toThrow('environment authentication');
    expect(accountRuntime.removeAuth).not.toHaveBeenCalled();
  });

  it('limits dashboard quota refresh requests to 30 seconds', async () => {
    useTempHome();
    saveConfig(DEFAULT_CONFIG);
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const refresh = new OpenCodeAccountDashboardManager(runtime()).refresh(
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    timeout.abort();

    await expect(refresh).resolves.toEqual({ updated: 0, failed: ['grok-build'] });
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it('accepts a valid manual OAuth code after an invalid code', async () => {
    useTempHome();
    saveConfig(DEFAULT_CONFIG);
    const accountRuntime = runtime();
    const submitManual = vi.fn((code: string) =>
      code === 'invalid' ? 'OAuth state did not match.' : undefined,
    );
    vi.spyOn(oauth, 'beginGrokBuildOAuth').mockResolvedValue({
      url: 'https://accounts.x.ai/authorize',
      instructions: 'Authorize',
      submitManual,
      finish: async () => ({
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
      }),
    });
    const onProgress = vi.fn();

    await new OpenCodeAccountDashboardManager(accountRuntime).login('grok-build', {
      signal: new AbortController().signal,
      onAuthorizationUrl: vi.fn(),
      onProgress,
      waitForManualCode: vi.fn().mockResolvedValueOnce('invalid').mockResolvedValueOnce('valid'),
    });

    await vi.waitFor(() => expect(submitManual).toHaveBeenCalledTimes(2));
    expect(submitManual.mock.calls.map(([code]) => code)).toEqual(['invalid', 'valid']);
    expect(onProgress).toHaveBeenCalledWith('OAuth state did not match.');
  });

  it('removes credentials when login is cancelled during the auth write', async () => {
    useTempHome();
    saveConfig(DEFAULT_CONFIG);
    const accountRuntime = runtime();
    let finishAuthWrite = () => {};
    accountRuntime.setAuth = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finishAuthWrite = resolve;
        }),
    );
    vi.spyOn(oauth, 'beginGrokBuildOAuth').mockResolvedValue({
      url: 'https://accounts.x.ai/authorize',
      instructions: 'Authorize',
      finish: async () => ({
        access: 'cancelled-access-token',
        refresh: 'cancelled-refresh-token',
        expires: Date.now() + 60_000,
      }),
    });
    const controller = new AbortController();
    const onProgress = vi.fn();
    const login = new OpenCodeAccountDashboardManager(accountRuntime).login('grok-build', {
      signal: controller.signal,
      onAuthorizationUrl: vi.fn(),
      onProgress,
      waitForManualCode: vi.fn(),
    });
    await vi.waitFor(() => expect(accountRuntime.setAuth).toHaveBeenCalledOnce());

    controller.abort();
    finishAuthWrite();
    await login;

    expect(accountRuntime.removeAuth).toHaveBeenCalledWith('grok-build');
    expect(accountRuntime.rotation.clearRecentExhaustion).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalledWith('Login complete.');
  });
});
