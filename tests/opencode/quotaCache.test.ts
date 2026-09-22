import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BillingUsage } from '../../src/opencode/billing.js';
import {
  formatCachedQuota,
  isCachedQuotaFresh,
  loadQuotaCache,
  removeQuotaUsage,
  saveQuotaUsage,
} from '../../src/opencode/quotaCache.js';
import { getQuotaCachePath } from '../../src/storage.js';
import { runBun, useTempOpenCodeHome } from '../stateTestHelpers.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-quota-');
const CRED_1 = 'credential:cred_1';
const CRED_2 = 'credential:cred_2';
const ENV_KEY = 'env:GROK_BUILD_OAUTH_TOKEN';

function usage(percent: number): BillingUsage {
  return {
    credits: {
      creditUsagePercent: percent,
      billingPeriodEnd: '2026-08-01T00:00:00.000Z',
      periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
    },
  };
}

describe('Grok Build quota cache', () => {
  it('starts empty without creating a file and rejects malformed entries', () => {
    useTempHome();

    expect(loadQuotaCache()).toEqual({ version: 1, accounts: {} });
    expect(existsSync(getQuotaCachePath())).toBe(false);

    const kept = { updatedAt: '2026-07-25T00:00:00.000Z', ...usage(10) };
    mkdirSync(dirname(getQuotaCachePath()), { recursive: true });
    writeFileSync(
      getQuotaCachePath(),
      JSON.stringify({
        version: 1,
        accounts: {
          [CRED_1]: { updatedAt: 'bad', credits: { creditUsagePercent: '10' } },
          'bad\u0000key': kept,
          [ENV_KEY]: kept,
        },
      }),
    );
    expect(loadQuotaCache()).toEqual({ version: 1, accounts: { [ENV_KEY]: kept } });
  });

  it('atomically serializes concurrent private cache updates', async () => {
    useTempHome();
    const updatedAt = '2026-07-25T10:30:00.000Z';

    await Promise.all([
      saveQuotaUsage(CRED_1, usage(30), updatedAt),
      saveQuotaUsage(CRED_2, usage(70), updatedAt),
    ]);

    expect(loadQuotaCache()).toEqual({
      version: 1,
      accounts: {
        [CRED_1]: { updatedAt, ...usage(30) },
        [CRED_2]: { updatedAt, ...usage(70) },
      },
    });
    expect(statSync(getQuotaCachePath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(getQuotaCachePath(), 'utf8')).not.toContain('.tmp');
  });

  it('rejects account keys with control characters', async () => {
    useTempHome();

    await expect(saveQuotaUsage('bad\nkey', usage(10))).rejects.toThrow(
      'Invalid Grok Build account key',
    );
  });

  it('serializes quota updates from separate processes', async () => {
    const home = useTempHome();
    const run = (group: number) =>
      runBun(
        `
            import { saveQuotaUsage } from './src/opencode/quotaCache.ts';
            for (let index = 0; index < 10; index += 1) {
              const number = ${group} * 10 + index + 2;
              await saveQuotaUsage('credential:cred_' + number, {
                credits: {
                  creditUsagePercent: number,
                  billingPeriodEnd: '2026-08-01T00:00:00.000Z',
                },
              });
            }
          `,
        { HOME: home, XDG_DATA_HOME: '' },
      );

    await Promise.all([run(0), run(1), run(2), run(3)]);

    expect(Object.keys(loadQuotaCache().accounts)).toHaveLength(40);
  });

  it('removes only the requested account and recovers after a failed queued update', async () => {
    useTempHome();
    await saveQuotaUsage(CRED_1, usage(30));
    const failed = saveQuotaUsage(CRED_2, {});
    const recovered = saveQuotaUsage(ENV_KEY, usage(50));

    await expect(failed).rejects.toThrow('Invalid quota usage');
    await expect(recovered).resolves.toBeUndefined();
    await removeQuotaUsage(ENV_KEY);

    expect(Object.keys(loadQuotaCache().accounts)).toEqual([CRED_1]);
  });

  it('formats fresh and stale credits explicitly as consumed quota', () => {
    const entry = {
      updatedAt: '2026-07-25T10:22:00.000Z',
      ...usage(30),
    };

    expect(formatCachedQuota(entry, Date.parse('2026-07-25T10:30:00.000Z'))).toBe(
      'Included 30% used · 8m ago',
    );
    expect(isCachedQuotaFresh(entry, Date.parse('2026-07-25T10:51:59.999Z'))).toBe(true);
    expect(isCachedQuotaFresh(entry, Date.parse('2026-07-25T10:52:00.000Z'))).toBe(false);
    expect(formatCachedQuota(entry, Date.parse('2026-07-25T10:52:00.000Z'))).toContain('stale');
  });
});
