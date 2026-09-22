import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/config.js';
import {
  connectionKey,
  credentialID,
  ENVIRONMENT_ACCOUNT_LABEL,
  GrokBuildAccounts,
  type HostAccount,
  refreshAccountQuotas,
} from '../../src/opencode/accounts.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';
import { CRED_A, CRED_B, fakeContext } from './fakeContext.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-accounts-');
const CRED_1 = 'credential:cred_1';
const CRED_2 = 'credential:cred_2';
const ENV_KEY = 'env:GROK_BUILD_OAUTH_TOKEN';

function host() {
  return fakeContext({
    connections: [
      { type: 'credential', id: 'cred_1', label: 'Work' },
      { type: 'credential', id: 'cred_2', label: 'Personal' },
      { type: 'env', name: 'GROK_BUILD_OAUTH_TOKEN' },
    ],
    credentials: {
      cred_1: { type: 'oauth', access: 'tok-1', refresh: 'r1', expires: 1, methodID: 'browser' },
      cred_2: { type: 'key', key: 'tok-2' },
    },
    environmentToken: 'env-token',
  });
}

function accountsFor(fake = host()) {
  return { fake, accounts: new GrokBuildAccounts(fake.ctx.integration) };
}

function fakeAccount(key: string): HostAccount {
  return {
    key,
    label: key,
    environment: false,
    connection: { type: 'credential', id: key, label: key },
  };
}

describe('Grok Build host accounts', () => {
  it('derives stable keys from host connections', () => {
    expect(connectionKey({ type: 'credential', id: 'cred_1', label: 'Work' })).toBe(CRED_1);
    expect(connectionKey({ type: 'env', name: 'GROK_BUILD_OAUTH_TOKEN' })).toBe(ENV_KEY);
    expect(credentialID(CRED_1)).toBe('cred_1');
    expect(credentialID(ENV_KEY)).toBeUndefined();
  });

  it('caches the connection listing until it is invalidated', async () => {
    const { fake, accounts } = accountsFor();

    expect(await accounts.list()).toEqual([
      {
        key: CRED_1,
        label: 'Work',
        environment: false,
        connection: { type: 'credential', id: 'cred_1', label: 'Work' },
      },
      {
        key: CRED_2,
        label: 'Personal',
        environment: false,
        connection: { type: 'credential', id: 'cred_2', label: 'Personal' },
      },
      {
        key: ENV_KEY,
        label: ENVIRONMENT_ACCOUNT_LABEL,
        environment: true,
        connection: { type: 'env', name: 'GROK_BUILD_OAUTH_TOKEN' },
      },
    ]);
    await accounts.list();
    expect(fake.calls.integrationGet).toBe(1);

    accounts.invalidate();
    await accounts.list();
    expect(fake.calls.integrationGet).toBe(2);
  });

  it('resolves OAuth, key and missing credentials', async () => {
    const { accounts } = accountsFor();
    const listed = await accounts.list();

    expect(await Promise.all(listed.map((account) => accounts.token(account)))).toEqual([
      'tok-1',
      'tok-2',
      'env-token',
    ]);
    expect(await accounts.token(fakeAccount('credential:missing'))).toBeUndefined();
  });

  it('selects the configured account and falls back to the first one', async () => {
    useTempHome();
    const { accounts } = accountsFor();

    expect((await accounts.selected())?.key).toBe(CRED_1);

    saveConfig({ ...DEFAULT_CONFIG, accounts: { selected: CRED_2 } });
    expect((await accounts.selected())?.key).toBe(CRED_2);

    saveConfig({ ...DEFAULT_CONFIG, accounts: { selected: 'credential:gone' } });
    expect((await accounts.selected())?.key).toBe(CRED_1);
  });

  it('falls back to the host active connection when nothing is selected', async () => {
    useTempHome();
    const { accounts } = accountsFor(
      fakeContext({ connections: [CRED_A, CRED_B], active: CRED_B }),
    );

    expect((await accounts.selected())?.key).toBe('credential:cred_b');
  });

  it('an explicit selection clears session pins', async () => {
    useTempHome();
    const { accounts } = accountsFor(fakeContext({ connections: [CRED_A, CRED_B] }));

    await accounts.select('credential:cred_b', 'ses_1');
    await accounts.select('credential:cred_a');

    expect((await accounts.selected('ses_1'))?.key).toBe('credential:cred_a');
  });

  it('pins a session to an account until the session is forgotten', async () => {
    useTempHome();
    const { accounts } = accountsFor();

    await accounts.select(ENV_KEY, 'ses_1');

    expect(loadConfig().config.accounts.selected).toBe(ENV_KEY);
    saveConfig({ ...DEFAULT_CONFIG, accounts: { selected: CRED_2 } });
    expect((await accounts.selected('ses_1'))?.key).toBe(ENV_KEY);
    expect((await accounts.selected('ses_2'))?.key).toBe(CRED_2);

    accounts.forgetSession('ses_1');
    expect((await accounts.selected('ses_1'))?.key).toBe(CRED_2);
    await expect(accounts.select('credential:gone')).rejects.toThrow(
      'Unknown Grok Build account: credential:gone',
    );
  });

  it('reports no account when the host has no connection', async () => {
    useTempHome();
    const { accounts } = accountsFor(fakeContext());

    expect(await accounts.selected()).toBeUndefined();
  });

  it('refreshes quotas in bounded batches and reports failures', async () => {
    const concurrency = { active: 0, peak: 0 };
    const saved: string[] = [];
    const result = await refreshAccountQuotas({
      accounts: ['a', 'b', 'c', 'd', 'e'].map(fakeAccount),
      resolveToken: (account) =>
        Promise.resolve(account.key === 'd' ? undefined : `token-${account.key}`),
      signal: AbortSignal.timeout(10_000),
      fetchUsage: async (token) => {
        concurrency.active += 1;
        concurrency.peak = Math.max(concurrency.peak, concurrency.active);
        await Promise.resolve();
        concurrency.active -= 1;
        if (token === 'token-e') throw new Error('offline');
        return {
          credits: { creditUsagePercent: 10, billingPeriodEnd: '2026-08-01T00:00:00.000Z' },
        };
      },
      saveUsage: (key) => {
        saved.push(key);
        return Promise.resolve();
      },
    });

    expect(result).toEqual({ updated: 3, failed: ['d', 'e'] });
    expect(saved).toEqual(['a', 'b', 'c']);
    expect(concurrency.peak).toBeLessThanOrEqual(3);
  });

  it('clears the cached listing when the host listing fails', async () => {
    const failing = { integrationGet: 0 };
    const accounts = new GrokBuildAccounts({
      get: () => {
        failing.integrationGet += 1;
        return Promise.reject(new Error('host offline'));
      },
      connection: { active: () => Promise.resolve(undefined), resolve: vi.fn() },
    } as never);

    await expect(accounts.list()).rejects.toThrow('host offline');
    await expect(accounts.list()).rejects.toThrow('host offline');
    expect(failing.integrationGet).toBe(2);
  });
});
