import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROK_BUILD_PROVIDER_ID } from '../../src/opencode/grokModels.js';
import { buildGrokBuildUsageReport } from '../../src/opencode/usage.js';
import { billingJsonResponse } from './billingTestHelpers.js';

function opencodeAuthPath() {
  return join(homedir(), '.local', 'share', 'opencode', 'auth.json');
}

describe('grok-build-usage command', () => {
  const originalFetch = globalThis.fetch;
  let savedAuth: string | undefined;
  let authExisted: boolean;

  beforeEach(() => {
    vi.stubEnv('GROK_BUILD_BASE_URL', 'https://cli-chat-proxy.grok.com/v1');
    const authPath = opencodeAuthPath();
    authExisted = existsSync(authPath);
    savedAuth = authExisted ? readFileSync(authPath, 'utf8') : undefined;
    delete process.env.GROK_BUILD_OAUTH_TOKEN;
    delete process.env.OPENCODE_AUTH_CONTENT;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    const authPath = opencodeAuthPath();
    if (authExisted && savedAuth !== undefined) {
      mkdirSync(dirname(authPath), { recursive: true });
      writeFileSync(authPath, savedAuth);
      return;
    }
    if (existsSync(authPath)) rmSync(authPath);
  });

  it('builds a usage report from billing when a token is available', async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      [GROK_BUILD_PROVIDER_ID]: {
        type: 'oauth',
        access: 'oauth-access',
        refresh: 'oauth-refresh',
        expires: 9_999_999_999_999,
      },
    });
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(4000, 500, '2026-07-01T00:00:00+00:00'),
    );

    const report = await buildGrokBuildUsageReport();

    expect(report.join('\n')).toContain('500 / 4,000 used');
    expect(report.join('\n')).not.toContain('no billing data available');
  });

  it('uses GROK_BUILD_OAUTH_TOKEN and warns about no auto-refresh', async () => {
    process.env.GROK_BUILD_OAUTH_TOKEN = 'env-bypass-token';
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(100, 10, '2026-07-01T00:00:00+00:00'),
    );

    const report = await buildGrokBuildUsageReport();

    expect(report.join('\n')).toContain('GROK_BUILD_OAUTH_TOKEN');
    expect(report.join('\n')).toContain('10 / 100 used');
  });

  it('shows billing unavailable when refresh fails', async () => {
    process.env.GROK_BUILD_OAUTH_TOKEN = 'bad-token';
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('', { status: 500 }));

    const report = await buildGrokBuildUsageReport();

    expect(report.join('\n')).toContain('billing refresh failed');
    expect(report.join('\n')).toContain('billing data unavailable');
  });
});
