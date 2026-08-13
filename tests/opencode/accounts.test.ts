import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type OpenGrokBuildConfig } from '../../src/config.js';
import {
  addAccount,
  buildAccountsSnapshot,
  GrokBuildAccountManager,
  refreshAccountQuotas,
  removeAccount,
  renameAccount,
  selectAccount,
} from '../../src/opencode/accounts.js';

function config(): OpenGrokBuildConfig {
  return {
    ...DEFAULT_CONFIG,
    accounts: {
      nextAccountNumber: 2,
      selectedProvider: 'grok-build',
      items: [{ provider: 'grok-build', label: 'Personal' }],
    },
  };
}

describe('Grok Build accounts', () => {
  it('adds accounts using default labels and the lowest free credential alias', () => {
    const first = addAccount(config(), ' Work ');
    const withGap = removeAccount(first.config, 'grok-build-2');
    const replacement = addAccount(
      {
        ...withGap,
        accounts: {
          ...withGap.accounts,
          items: [...withGap.accounts.items, { provider: 'grok-build-3', label: 'Client' }],
        },
      },
      '',
    );

    expect(first.account).toEqual({ provider: 'grok-build-2', label: 'Work' });
    expect(replacement.account).toEqual({ provider: 'grok-build-2', label: 'Account 2' });
  });

  it('chooses a unique default label when the account-number label already exists', () => {
    const current = config();
    current.accounts.items[0] = { provider: 'grok-build', label: 'Account 2' };

    expect(addAccount(current).account).toEqual({
      provider: 'grok-build-2',
      label: 'Account 3',
    });
  });

  it('validates unique safe labels', () => {
    const current = addAccount(config(), 'Work').config;

    expect(() => addAccount(current, 'work')).toThrow('already exists');
    expect(() => renameAccount(current, 'grok-build-2', 'bad\nlabel')).toThrow(
      'control characters',
    );
    expect(() => renameAccount(current, 'grok-build-2', 'x'.repeat(41))).toThrow('40 characters');
  });

  it('selects known aliases and returns to the permanent base after removing the selection', () => {
    const current = addAccount(config(), 'Work').config;
    const selected = selectAccount(current, 'grok-build-2');

    expect(removeAccount(selected, 'grok-build-2').accounts.selectedProvider).toBe('grok-build');
    expect(() => selectAccount(current, 'missing')).toThrow('Unknown Grok Build account');
    expect(() => removeAccount(current, 'grok-build')).toThrow('cannot be removed');
  });

  it('builds credential-free account snapshots with cached quota', () => {
    const current = selectAccount(addAccount(config(), 'Work').config, 'grok-build-2');
    const snapshot = buildAccountsSnapshot(
      current,
      ['grok-build-2'],
      {
        version: 1,
        accounts: {
          'grok-build-2': {
            updatedAt: '2026-07-25T00:00:00.000Z',
            credits: {
              creditUsagePercent: 35,
              billingPeriodEnd: '2026-08-01T00:00:00.000Z',
              periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
            },
          },
        },
      },
      'grok-build',
    );

    expect(snapshot.accounts).toEqual([
      expect.objectContaining({
        provider: 'grok-build',
        status: 'authenticated',
        environment: true,
      }),
      expect.objectContaining({
        provider: 'grok-build-2',
        status: 'active',
        authenticated: true,
        quota: expect.objectContaining({ updatedAt: '2026-07-25T00:00:00.000Z' }),
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('token');
  });

  it('tracks account generations so stale quota refreshes can be rejected', () => {
    let current = config();
    const save = vi.fn((next: OpenGrokBuildConfig) => {
      current = next;
    });
    const manager = new GrokBuildAccountManager(() => current, save);
    const account = manager.add('Work');
    const generation = manager.generation(account.provider);

    expect(manager.isCurrent(account.provider, generation)).toBe(true);

    manager.remove(account.provider);

    expect(manager.isCurrent(account.provider, generation)).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('refreshes quota in bounded batches and rejects stale account results', async () => {
    let current = config();
    const manager = new GrokBuildAccountManager(
      () => current,
      (next) => {
        current = next;
      },
    );
    manager.add('Work');
    manager.add('Client');
    manager.add('Reserve');
    const active = new Set<string>();
    let peak = 0;
    const saved: string[] = [];
    const result = await refreshAccountQuotas({
      accounts: current.accounts.items,
      resolveToken: async (provider) => `${provider}-token`,
      signal: new AbortController().signal,
      manager,
      fetchUsage: async (token) => {
        active.add(token);
        peak = Math.max(peak, active.size);
        await Promise.resolve();
        active.delete(token);
        if (token === 'grok-build-2-token') manager.bump('grok-build-2');
        return {
          credits: {
            creditUsagePercent: 10,
            billingPeriodEnd: '2026-08-01T00:00:00.000Z',
          },
        };
      },
      saveUsage: async (provider) => {
        saved.push(provider);
      },
    });

    expect(peak).toBe(3);
    expect(result).toEqual({ updated: 3, failed: ['grok-build-2'] });
    expect(saved).toEqual(['grok-build', 'grok-build-3', 'grok-build-4']);
  });
});
