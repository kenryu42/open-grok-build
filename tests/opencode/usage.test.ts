import { describe, expect, it, vi } from 'vitest';
import type { HostAccount } from '../../src/opencode/accounts.js';
import { saveQuotaUsage } from '../../src/opencode/quotaCache.js';
import { buildGrokBuildUsageReport } from '../../src/opencode/usage.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';
import { billingJsonResponse } from './billingTestHelpers.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-usage-');
const KEY = 'credential:cred_1';

function account(environment = false): HostAccount {
  return environment
    ? {
        key: 'env:GROK_BUILD_OAUTH_TOKEN',
        label: 'Environment token',
        environment: true,
        connection: { type: 'env', name: 'GROK_BUILD_OAUTH_TOKEN' },
      }
    : {
        key: KEY,
        label: 'Work',
        environment: false,
        connection: { type: 'credential', id: 'cred_1', label: 'Work' },
      };
}

describe('Grok Build usage report', () => {
  it('reports the refreshed quota and caches it under the account key', async () => {
    useTempHome();
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(4000, 500, '2026-08-01T00:00:00.000Z'),
    );

    const report = await buildGrokBuildUsageReport({ account: account(), token: 'secret-token' });

    expect(report[0]).toContain('Work');
    expect(report.join('\n')).not.toContain('secret-token');
    expect(report.join('\n')).toContain('Weekly Limit');
  });

  it('falls back to the cached quota when the refresh fails', async () => {
    useTempHome();
    await saveQuotaUsage(
      KEY,
      { monthly: { monthlyLimit: 4000, used: 500, billingPeriodEnd: '2026-08-01T00:00:00.000Z' } },
      '2026-07-25T00:00:00.000Z',
    );
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('', { status: 500 }));

    const report = (await buildGrokBuildUsageReport({ account: account(), token: 'bad' })).join(
      '\n',
    );

    expect(report).toContain('billing refresh failed');
    expect(report).toContain('Cached usage from 2026-07-25T00:00:00.000Z');
  });

  it('warns about the environment token and skips the fetch without one', async () => {
    useTempHome();
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(4000, 500, '2026-08-01T00:00:00.000Z'),
    );

    const report = (
      await buildGrokBuildUsageReport({ account: account(true), token: undefined })
    ).join('\n');

    expect(report).toContain('GROK_BUILD_OAUTH_TOKEN');
    expect(report).toContain('billing data unavailable');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
