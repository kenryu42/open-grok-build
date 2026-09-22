import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { GrokBuildAccounts } from '../../src/opencode/accounts.js';
import { saveQuotaUsage } from '../../src/opencode/quotaCache.js';
import { ExhaustionRotation } from '../../src/opencode/rotation.js';
import {
  accountsList,
  accountsSelect,
  findAccount,
  quotasRefresh,
  usageReport,
} from '../../src/opencode/rpcHandlers.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';
import { billingJsonResponse } from './billingTestHelpers.js';
import { fakeContext } from './fakeContext.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-rpc-');
const CRED_1 = 'credential:cred_1';
const CRED_2 = 'credential:cred_2';
const SIGNAL = AbortSignal.timeout(10_000);

function deps() {
  useTempHome();
  const fake = fakeContext({
    connections: [
      { type: 'credential', id: 'cred_1', label: 'Work' },
      { type: 'credential', id: 'cred_2', label: 'Personal' },
    ],
    credentials: {
      cred_1: { type: 'key', key: 'tok-1' },
      cred_2: { type: 'key', key: 'tok-2' },
    },
  });
  return {
    accounts: new GrokBuildAccounts(fake.ctx.integration),
    rotation: new ExhaustionRotation(),
  };
}

describe('Grok Build RPC handlers', () => {
  it('summarizes accounts with selection, exhaustion and cached quota freshness', async () => {
    const context = deps();
    const now = Date.parse('2026-07-25T10:00:00.000Z');
    await saveQuotaUsage(
      CRED_1,
      { credits: { creditUsagePercent: 25, billingPeriodEnd: '2026-08-01T00:00:00.000Z' } },
      new Date(now).toISOString(),
    );
    context.rotation.markExhausted(CRED_2, now);

    expect(await accountsList(context, now)).toEqual({
      accounts: [
        {
          key: CRED_1,
          label: 'Work',
          selected: true,
          environment: false,
          exhausted: false,
          quota: {
            updatedAt: new Date(now).toISOString(),
            fresh: true,
            credits: { creditUsagePercent: 25, billingPeriodEnd: '2026-08-01T00:00:00.000Z' },
          },
        },
        {
          key: CRED_2,
          label: 'Personal',
          selected: false,
          environment: false,
          exhausted: true,
        },
      ],
    });
  });

  it('persists a selected account and resolves accounts by key', async () => {
    const context = deps();

    expect(await accountsSelect(context, CRED_2)).toEqual({ ok: true });
    expect(loadConfig().config.accounts.selected).toBe(CRED_2);
    expect((await findAccount(context, undefined))?.key).toBe(CRED_2);
    expect((await findAccount(context, CRED_1))?.key).toBe(CRED_1);
    expect(await findAccount(context, 'credential:gone')).toBeUndefined();
  });

  it('reports usage for one account without leaking its token', async () => {
    const context = deps();
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(4000, 500, '2026-08-01T00:00:00.000Z'),
    );
    const account = await findAccount(context, CRED_1);
    if (!account) throw new Error('missing account');

    const report = await usageReport(context, account, SIGNAL);

    expect(report.lines.join('\n')).toContain('Work');
    expect(report.lines.join('\n')).not.toContain('tok-1');
  });

  it('refreshes only the requested quotas', async () => {
    const context = deps();
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(4000, 500, '2026-08-01T00:00:00.000Z'),
    );

    expect(await quotasRefresh(context, [CRED_2], SIGNAL)).toEqual({ updated: 1, failed: [] });
    expect((await accountsList(context)).accounts.map((account) => Boolean(account.quota))).toEqual(
      [false, true],
    );
    expect(await quotasRefresh(context, undefined, SIGNAL)).toEqual({ updated: 2, failed: [] });
  });
});
