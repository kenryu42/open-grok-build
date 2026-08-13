import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as oauth from '../../src/auth/oauth.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig, selectAccount } from '../../src/config.js';
import { EXHAUSTED_BALANCE_ERROR } from '../../src/opencode/rotation.js';
import { GrokBuildRuntime } from '../../src/opencode/runtime.js';
import { getOpenCodeDataDirectory, writeFileAtomic } from '../../src/storage.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-runtime-');

function runtime() {
  return new GrokBuildRuntime({
    client: { auth: { set: vi.fn(async () => ({ data: true })) } },
    serverUrl: new URL('http://127.0.0.1:4096'),
  } as never);
}

function secondaryAuth() {
  return {
    type: 'oauth',
    access: 'secondary-access',
    refresh: 'secondary-refresh',
    expires: Date.now() + 60_000,
  };
}

function primaryAuth() {
  return {
    type: 'oauth',
    access: 'primary-access',
    refresh: 'primary-refresh',
    expires: Date.now() + 60_000,
  };
}

function configureAccounts() {
  saveConfig({
    ...DEFAULT_CONFIG,
    accounts: {
      nextAccountNumber: 3,
      selectedProvider: 'grok-build',
      items: [
        { provider: 'grok-build', label: 'Primary' },
        { provider: 'grok-build-2', label: 'Secondary' },
      ],
    },
  });
  writeFileAtomic(
    join(getOpenCodeDataDirectory(), 'auth.json'),
    JSON.stringify({
      'grok-build': primaryAuth(),
      'grok-build-2': secondaryAuth(),
    }),
  );
}

function configureThreeAccounts() {
  saveConfig({
    ...DEFAULT_CONFIG,
    accounts: {
      nextAccountNumber: 4,
      selectedProvider: 'grok-build',
      items: [
        { provider: 'grok-build', label: 'Primary' },
        { provider: 'grok-build-2', label: 'Secondary' },
        { provider: 'grok-build-3', label: 'Tertiary' },
      ],
    },
  });
  writeFileAtomic(
    join(getOpenCodeDataDirectory(), 'auth.json'),
    JSON.stringify({
      'grok-build': primaryAuth(),
      'grok-build-2': secondaryAuth(),
      'grok-build-3': {
        type: 'oauth',
        access: 'tertiary-access',
        refresh: 'tertiary-refresh',
        expires: Date.now() + 60_000,
      },
    }),
  );
}

async function expectSinglePaymentResponse(fetchMock: ReturnType<typeof vi.fn>) {
  const response = await runtime().fetch('https://cli-chat-proxy.grok.com/v1/responses');
  expect(response.status).toBe(402);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(loadConfig().config.accounts.selectedProvider).toBe('grok-build');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GrokBuildRuntime account router', () => {
  it('replays an exact pre-stream exhaustion response with the next account', async () => {
    useTempHome();
    configureAccounts();
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        if (requests.length === 1) {
          return new Response('402 "Grok Build usage balance exhausted"', { status: 402 });
        }
        return new Response('ok');
      }),
    );

    const response = await runtime().fetch(
      new Request('https://cli-chat-proxy.grok.com/v1/responses', {
        method: 'POST',
        headers: { 'x-grok-conv-id': 'ses_rotation' },
        body: '{"input":"hello"}',
      }),
    );

    expect(await response.text()).toBe('ok');
    expect(requests.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer primary-access',
      'Bearer secondary-access',
    ]);
    expect(await requests[1]?.text()).toBe('{"input":"hello"}');
    expect(requests[1]?.headers.get('x-grok-client-version')).toBe('0.2.111');
    expect(loadConfig().config.accounts.selectedProvider).toBe('grok-build-2');
  });

  it('returns non-payment responses without inspecting their streaming body', async () => {
    useTempHome();
    configureAccounts();
    const response = new Response('stream');
    const clone = vi.spyOn(response, 'clone');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );

    const result = await runtime().fetch('https://cli-chat-proxy.grok.com/v1/responses');

    expect(result).toBe(response);
    expect(clone).not.toHaveBeenCalled();
  });

  it('continues an exhaustion chain after an account cannot refresh a revoked token', async () => {
    useTempHome();
    configureThreeAccounts();
    vi.spyOn(oauth, 'refresh').mockRejectedValue(new Error('invalid refresh token'));
    const authorizations: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        authorizations.push(request.headers.get('authorization'));
        if (authorizations.length === 1) {
          return new Response('Grok Build usage balance exhausted', { status: 402 });
        }
        if (authorizations.length === 2) return new Response('unauthorized', { status: 401 });
        return new Response('ok');
      }),
    );

    const response = await runtime().fetch('https://cli-chat-proxy.grok.com/v1/responses');

    expect(await response.text()).toBe('ok');
    expect(authorizations).toEqual([
      'Bearer primary-access',
      'Bearer secondary-access',
      'Bearer tertiary-access',
    ]);
  });

  it('keeps the exhaustion response when the final account has no usable token', async () => {
    useTempHome();
    configureAccounts();
    const expired = secondaryAuth();
    expired.expires = 1;
    writeFileAtomic(
      join(getOpenCodeDataDirectory(), 'auth.json'),
      JSON.stringify({
        'grok-build': primaryAuth(),
        'grok-build-2': expired,
      }),
    );
    vi.spyOn(oauth, 'refresh').mockRejectedValue(new Error('invalid refresh token'));
    const fetchMock = vi.fn(
      async () => new Response('Grok Build usage balance exhausted', { status: 402 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expectSinglePaymentResponse(fetchMock);
  });

  it('records the authenticated account used for a session fallback', async () => {
    useTempHome();
    configureAccounts();
    writeFileAtomic(
      join(getOpenCodeDataDirectory(), 'auth.json'),
      JSON.stringify({
        'grok-build-2': secondaryAuth(),
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    const accountRuntime = runtime();

    await accountRuntime.fetch(
      new Request('https://cli-chat-proxy.grok.com/v1/responses', {
        headers: { 'x-grok-conv-id': 'fallback-session' },
      }),
    );

    expect(accountRuntime.selectedProvider('fallback-session')).toBe('grok-build-2');
  });

  it('does not rotate on unrelated payment errors or malformed credential slots', async () => {
    useTempHome();
    configureAccounts();
    writeFileAtomic(
      join(getOpenCodeDataDirectory(), 'auth.json'),
      JSON.stringify({
        'grok-build': { type: 'oauth', access: 'primary-access' },
        'grok-build-2': secondaryAuth(),
      }),
    );
    const fetchMock = vi.fn(async () => new Response('payment required', { status: 402 }));
    vi.stubGlobal('fetch', fetchMock);

    await expectSinglePaymentResponse(fetchMock);
  });

  it('invalidates seeded credentials when the OpenCode auth store changes', async () => {
    useTempHome();
    configureAccounts();
    const accountRuntime = runtime();
    accountRuntime.seed('grok-build', {
      type: 'oauth',
      access: 'primary-access',
      refresh: 'primary-refresh',
      expires: Date.now() + 60_000,
    });

    writeFileAtomic(
      join(getOpenCodeDataDirectory(), 'auth.json'),
      JSON.stringify({
        'grok-build-2': secondaryAuth(),
      }),
    );

    expect(await accountRuntime.token('grok-build')).toBeUndefined();
    expect(accountRuntime.authenticatedProviders()).toEqual(['grok-build-2']);
  });

  it('uses a persisted OAuth rotation after an environment snapshot becomes stale', async () => {
    useTempHome();
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      'grok-build': {
        type: 'oauth',
        access: 'stale-environment-access',
        refresh: 'stale-environment-refresh',
        expires: 1,
      },
    });
    writeFileAtomic(
      join(getOpenCodeDataDirectory(), 'auth.json'),
      JSON.stringify({
        'grok-build': {
          type: 'oauth',
          access: 'persisted-rotated-access',
          refresh: 'persisted-rotated-refresh',
          expires: Date.now() + 60_000,
        },
      }),
    );
    const refresh = vi.spyOn(oauth, 'refresh');

    await expect(runtime().token('grok-build')).resolves.toBe('persisted-rotated-access');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not seed a stale loader snapshot over a persisted OAuth rotation', async () => {
    useTempHome();
    writeFileAtomic(
      join(getOpenCodeDataDirectory(), 'auth.json'),
      JSON.stringify({
        'grok-build': {
          type: 'oauth',
          access: 'newer-persisted-access',
          refresh: 'newer-persisted-refresh',
          expires: Date.now() + 60_000,
        },
      }),
    );
    const accountRuntime = runtime();
    accountRuntime.seed('grok-build', {
      type: 'oauth',
      access: 'stale-loader-access',
      refresh: 'stale-loader-refresh',
      expires: 1,
    });
    const refresh = vi.spyOn(oauth, 'refresh');

    await expect(accountRuntime.token('grok-build')).resolves.toBe('newer-persisted-access');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('uses an external account selection for an existing session', () => {
    useTempHome();
    configureAccounts();
    const accountRuntime = runtime();
    accountRuntime.activate('grok-build', 'existing-session');

    saveConfig(selectAccount(loadConfig().config, 'grok-build-2'));

    expect(accountRuntime.selectedProvider('existing-session')).toBe('grok-build-2');
  });

  it('keeps the continuation model when no agent is supplied', () => {
    const accountRuntime = runtime();

    accountRuntime.trackSession('session-without-agent', 'grok-code-fast-1');

    expect(accountRuntime.continuation('session-without-agent')).toEqual({
      model: 'grok-code-fast-1',
    });
  });

  it('keeps unavailable accounts excluded during automatic rotation', () => {
    useTempHome();
    configureAccounts();
    const accountRuntime = runtime();
    accountRuntime.rotation.markUnavailable('grok-build');

    expect(accountRuntime.rotate(undefined, 'grok-build')).toBe('grok-build-2');

    expect(
      accountRuntime.rotation.candidates({
        config: loadConfig().config,
        currentProvider: 'grok-build-2',
        authenticatedProviders: ['grok-build', 'grok-build-2'],
      }),
    ).toEqual([]);
  });

  it('keeps account exhaustion cooldowns when a session is deleted', () => {
    useTempHome();
    configureAccounts();
    const accountRuntime = runtime();
    const exhaustedAt = Date.now();
    accountRuntime.rotation.markExhausted('grok-build-2', EXHAUSTED_BALANCE_ERROR, exhaustedAt);

    accountRuntime.clearSession('finished-session');

    expect(
      accountRuntime.rotation.candidates({
        config: loadConfig().config,
        currentProvider: 'grok-build',
        authenticatedProviders: ['grok-build', 'grok-build-2'],
        now: exhaustedAt,
      }),
    ).toEqual([]);
  });
});
