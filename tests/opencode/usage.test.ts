import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as oauth from '../../src/auth/oauth.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/config.js';
import { saveQuotaUsage } from '../../src/opencode/quotaCache.js';
import {
  authenticatedGrokBuildAccounts,
  buildGrokBuildUsageReport,
  resolveFreshGrokBuildAccessToken,
  resolveGrokBuildAccessToken,
} from '../../src/opencode/usage.js';
import { getOpenCodeDataDirectory, writeFileAtomic } from '../../src/storage.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';
import { billingJsonResponse, creditsJsonResponse } from './billingTestHelpers.js';

describe('grok-build-usage command', () => {
  const originalFetch = globalThis.fetch;
  const useTempHome = useTempOpenCodeHome('open-grok-build-usage-');

  beforeEach(() => {
    useTempHome();
    vi.stubEnv('GROK_BUILD_BASE_URL', 'https://cli-chat-proxy.grok.com/v1');
    delete process.env.GROK_BUILD_OAUTH_TOKEN;
    delete process.env.OPENCODE_AUTH_CONTENT;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('resolves and reports the selected account alias', async () => {
    saveConfig({
      ...DEFAULT_CONFIG,
      accounts: {
        nextAccountNumber: 3,
        selectedProvider: 'grok-build-2',
        items: [
          { provider: 'grok-build', label: 'Personal' },
          { provider: 'grok-build-2', label: 'Work' },
        ],
      },
    });
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      'grok-build': { type: 'oauth', access: 'personal-token' },
      'grok-build-2': { type: 'oauth', access: 'work-token' },
    });
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer work-token' });
      return input.toString().includes('format=credits')
        ? creditsJsonResponse(100, 10, '2026-08-01T00:00:00.000Z')
        : billingJsonResponse(100, 10, '2026-08-01T00:00:00.000Z');
    });

    const report = await buildGrokBuildUsageReport();

    expect(report.join('\n')).toContain('10%');
    expect(resolveGrokBuildAccessToken()).toBe('work-token');
    expect(authenticatedGrokBuildAccounts()).toEqual(['grok-build', 'grok-build-2']);
  });

  it('uses the environment token only for the primary account and warns', async () => {
    process.env.GROK_BUILD_OAUTH_TOKEN = 'env-token';
    globalThis.fetch = vi.fn<typeof fetch>(async (input) =>
      input.toString().includes('format=credits')
        ? creditsJsonResponse(100, 5, '2026-08-01T00:00:00.000Z')
        : billingJsonResponse(100, 5, '2026-08-01T00:00:00.000Z'),
    );

    const report = await buildGrokBuildUsageReport();

    expect(report.join('\n')).toContain('GROK_BUILD_OAUTH_TOKEN');
    expect(report.join('\n')).toContain('5%');
    expect(resolveGrokBuildAccessToken('grok-build-2')).toBeUndefined();
  });

  it('uses an explicitly supplied live token instead of stale persisted auth', async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      'grok-build': { type: 'oauth', access: 'stale-token' },
    });
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer live-token' });
      return input.toString().includes('format=credits')
        ? creditsJsonResponse(100, 20, '2026-08-01T00:00:00.000Z')
        : billingJsonResponse(100, 20, '2026-08-01T00:00:00.000Z');
    });

    await buildGrokBuildUsageReport({ token: 'live-token' });
  });

  it('refreshes and persists expired tokens for TUI features with singleflight', async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      'grok-build': {
        type: 'oauth',
        access: 'expired-token',
        refresh: 'refresh-token',
        expires: 1,
      },
    });
    vi.spyOn(oauth, 'refresh').mockResolvedValue({
      access: 'fresh-token',
      refresh: 'rotated-refresh',
      expires: Date.now() + 60_000,
    });
    const writeAuth = vi.fn(async () => undefined);

    const tokens = await Promise.all([
      resolveFreshGrokBuildAccessToken('grok-build', writeAuth),
      resolveFreshGrokBuildAccessToken('grok-build', writeAuth),
    ]);

    expect(tokens).toEqual(['fresh-token', 'fresh-token']);
    expect(oauth.refresh).toHaveBeenCalledOnce();
    expect(writeAuth).toHaveBeenCalledOnce();
    expect(writeAuth.mock.calls[0]?.[1]).toMatchObject({
      access: 'fresh-token',
      refresh: 'rotated-refresh',
    });
    expect(await resolveFreshGrokBuildAccessToken('grok-build', writeAuth)).toBe('fresh-token');
    expect(oauth.refresh).toHaveBeenCalledOnce();
  });

  it('reuses a rotated environment refresh token after the fresh access token expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      'grok-build': {
        type: 'oauth',
        access: 'expired-token',
        refresh: 'environment-refresh',
        expires: 1,
      },
    });
    const refresh = vi
      .spyOn(oauth, 'refresh')
      .mockResolvedValueOnce({
        access: 'fresh-token-1',
        refresh: 'rotated-refresh-1',
        expires: 1_700_000_001_000,
      })
      .mockResolvedValueOnce({
        access: 'fresh-token-2',
        refresh: 'rotated-refresh-2',
        expires: 1_700_000_003_000,
      });
    const writeAuth = vi.fn(async () => undefined);

    expect(await resolveFreshGrokBuildAccessToken('grok-build', writeAuth)).toBe('fresh-token-1');
    vi.setSystemTime(1_700_000_002_000);
    expect(await resolveFreshGrokBuildAccessToken('grok-build', writeAuth)).toBe('fresh-token-2');
    expect(refresh.mock.calls[1]?.[0].refresh).toBe('rotated-refresh-1');
  });

  it('keeps rotated credentials when auth persistence fails', async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      'grok-build': {
        type: 'oauth',
        access: 'persistence-expired-token',
        refresh: 'persistence-environment-refresh',
        expires: 2,
      },
    });
    const refresh = vi.spyOn(oauth, 'refresh').mockResolvedValue({
      access: 'fresh-token',
      refresh: 'rotated-refresh',
      expires: Date.now() + 60_000,
    });
    const writeAuth = vi.fn(async () => {
      throw new Error('auth persistence failed');
    });

    await expect(resolveFreshGrokBuildAccessToken('grok-build', writeAuth)).resolves.toBe(
      'fresh-token',
    );
    await expect(resolveFreshGrokBuildAccessToken('grok-build', writeAuth)).resolves.toBe(
      'fresh-token',
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('uses a persisted OAuth rotation after an environment snapshot becomes stale', async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      'grok-build': {
        type: 'oauth',
        access: 'usage-stale-environment-access',
        refresh: 'usage-stale-environment-refresh',
        expires: 1,
      },
    });
    writeFileAtomic(
      join(getOpenCodeDataDirectory(), 'auth.json'),
      JSON.stringify({
        'grok-build': {
          type: 'oauth',
          access: 'usage-persisted-rotated-access',
          refresh: 'usage-persisted-rotated-refresh',
          expires: Date.now() + 60_000,
        },
      }),
    );
    const refresh = vi.spyOn(oauth, 'refresh');

    await expect(resolveFreshGrokBuildAccessToken('grok-build', vi.fn())).resolves.toBe(
      'usage-persisted-rotated-access',
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('falls back to the selected account cache when billing refresh fails', async () => {
    process.env.GROK_BUILD_OAUTH_TOKEN = 'bad-token';
    await saveQuotaUsage(
      'grok-build',
      {
        monthly: {
          monthlyLimit: 4000,
          used: 500,
          billingPeriodEnd: '2026-08-01T00:00:00.000Z',
        },
      },
      '2026-07-25T00:00:00.000Z',
    );
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('', { status: 500 }));

    const report = await buildGrokBuildUsageReport();

    expect(report.join('\n')).toContain('billing refresh failed');
    expect(report.join('\n')).toContain('Cached usage from 2026-07-25T00:00:00.000Z');
    expect(report.join('\n')).toContain('weekly usage unavailable');
  });

  it('shows unavailable when no token or cached authenticated usage exists', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(100, 10, '2026-08-01T00:00:00.000Z'),
    );

    const report = await buildGrokBuildUsageReport();

    expect(report.join('\n')).toContain('billing data unavailable');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
