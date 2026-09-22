import { describe, expect, it } from 'vitest';
import { AccountSummary, AccountsList, OpenGrokBuildRpc } from '../../src/opencode/rpc.js';

describe('Grok Build RPC contract', () => {
  it('publishes the account, usage and quota methods', () => {
    expect(OpenGrokBuildRpc.id).toBe('open-grok-build');
    expect(Object.keys(OpenGrokBuildRpc.methods)).toEqual([
      'accounts.list',
      'accounts.select',
      'usage.report',
      'quotas.refresh',
    ]);
    expect(OpenGrokBuildRpc.events).toEqual({});
  });

  it('accepts a summarized account list', () => {
    expect(
      AccountsList.parse({
        accounts: [
          {
            key: 'credential:cred_1',
            label: 'Work',
            selected: true,
            environment: false,
            exhausted: false,
          },
        ],
      }),
    ).toEqual({
      accounts: [
        {
          key: 'credential:cred_1',
          label: 'Work',
          selected: true,
          environment: false,
          exhausted: false,
        },
      ],
    });
  });

  it('never carries credentials and rejects malformed quotas', () => {
    const parsed = AccountSummary.parse({
      key: 'credential:cred_1',
      label: 'Work',
      selected: false,
      environment: false,
      exhausted: false,
      access: 'secret-token',
    });

    expect(parsed).not.toHaveProperty('access');
    expect(
      AccountSummary.safeParse({
        key: 'k',
        label: 'l',
        selected: false,
        environment: false,
        exhausted: false,
        quota: { updatedAt: 12, fresh: true },
      }).success,
    ).toBe(false);
  });
});
