import { describe, expect, it, vi } from 'vitest';
import {
  type DashboardHost,
  OpenCodeAccountDashboardManager,
} from '../../src/opencode/accountDashboardManager.js';
import { loadQuotaCache, saveQuotaUsage } from '../../src/opencode/quotaCache.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-dashboard-manager-');
const CRED_1 = 'credential:cred_1';
const ENV_KEY = 'env:GROK_BUILD_OAUTH_TOKEN';

function accounts() {
  return {
    accounts: [
      {
        key: CRED_1,
        label: 'Work',
        selected: true,
        environment: false,
        exhausted: false,
        quota: {
          updatedAt: '2026-07-25T00:00:00.000Z',
          fresh: true,
          subscriptionTier: 'x-premium',
          credits: { creditUsagePercent: 40 },
        },
      },
      {
        key: ENV_KEY,
        label: 'Environment token',
        selected: false,
        environment: true,
        exhausted: false,
      },
    ],
  };
}

function host(overrides: Partial<DashboardHost> = {}) {
  const calls = {
    accountsSelect: vi.fn(() => Promise.resolve(undefined)),
    quotasRefresh: vi.fn(() => Promise.resolve({ updated: 1, failed: [] as string[] })),
    activate: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    connect: vi.fn(() =>
      Promise.resolve({
        data: {
          attemptID: 'attempt_1',
          url: 'https://auth.x.ai/authorize',
          instructions: 'Open the link',
          mode: 'auto' as const,
        },
      }),
    ),
    status: vi.fn(() => Promise.resolve({ data: { status: 'complete' as const } })),
    cancel: vi.fn(() => Promise.resolve()),
  };
  const base: DashboardHost = {
    accountsList: () => Promise.resolve(accounts()),
    accountsSelect: calls.accountsSelect,
    quotasRefresh: calls.quotasRefresh,
    credential: { activate: calls.activate, update: calls.update, remove: calls.remove },
    oauth: { connect: calls.connect, status: calls.status, cancel: calls.cancel },
  };
  return { calls, manager: new OpenCodeAccountDashboardManager({ ...base, ...overrides }, 0) };
}

function interaction(signal = new AbortController().signal) {
  const progress: string[] = [];
  const urls: string[] = [];
  return {
    progress,
    urls,
    interaction: {
      signal,
      onAuthorizationUrl: (url: string) => urls.push(url),
      onProgress: (message: string) => progress.push(message),
      waitForManualCode: () => new Promise<string>(() => {}),
    },
  };
}

describe('OpenCode account dashboard manager', () => {
  it('maps host accounts onto dashboard rows', async () => {
    const snapshot = await host().manager.snapshot();

    expect(snapshot.accounts).toEqual([
      {
        provider: CRED_1,
        label: 'Work',
        status: 'active',
        authenticated: true,
        active: true,
        environment: false,
        plan: 'x-premium',
        quota: {
          updatedAt: '2026-07-25T00:00:00.000Z',
          fresh: true,
          credits: { creditUsagePercent: 40 },
        },
      },
      {
        provider: ENV_KEY,
        label: 'Environment token',
        status: 'authenticated',
        authenticated: true,
        active: false,
        environment: true,
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('access');
  });

  it('adds a pending account that cannot be activated before login', async () => {
    const { manager } = host();

    const added = await manager.add('  Second  ');

    expect(added).toMatchObject({
      label: 'Second',
      authenticated: false,
      status: 'login-required',
    });
    expect(added.provider.startsWith('pending:')).toBe(true);
    expect((await manager.snapshot()).accounts).toHaveLength(3);
    await expect(manager.activate(added.provider)).rejects.toThrow('Log in before');

    await manager.remove(added.provider);

    expect((await manager.snapshot()).accounts).toHaveLength(2);
  });

  it('activates a credential account in the host and in the plugin config', async () => {
    const { calls, manager } = host();

    await manager.activate(CRED_1);

    expect(calls.accountsSelect).toHaveBeenCalledWith(CRED_1);
    expect(calls.activate).toHaveBeenCalledWith({ credentialID: 'cred_1' });

    await manager.activate(ENV_KEY);

    expect(calls.activate).toHaveBeenCalledTimes(1);
  });

  it('renames credential accounts and refuses environment ones', async () => {
    const { calls, manager } = host();

    await manager.rename(CRED_1, ' Personal ');

    expect(calls.update).toHaveBeenCalledWith({ credentialID: 'cred_1', label: 'Personal' });
    await expect(manager.rename(CRED_1, '  ')).rejects.toThrow('cannot be empty');
    await expect(manager.rename(ENV_KEY, 'Nope')).rejects.toThrow('cannot be renamed');
  });

  it('removes a credential account and clears its cached quota', async () => {
    useTempHome();
    await saveQuotaUsage(CRED_1, {
      credits: { creditUsagePercent: 10, billingPeriodEnd: '2026-08-01T00:00:00.000Z' },
    });
    const { calls, manager } = host();

    await manager.logout(CRED_1);

    expect(calls.remove).toHaveBeenCalledWith({ credentialID: 'cred_1' });
    expect(Object.keys(loadQuotaCache().accounts)).toEqual([]);
    await expect(manager.remove(ENV_KEY)).rejects.toThrow('cannot be removed here');
  });

  it('refreshes all quotas and reports a single failed refresh', async () => {
    const { calls, manager } = host();

    expect(await manager.refresh(AbortSignal.timeout(10_000))).toEqual({ updated: 1, failed: [] });
    expect(calls.quotasRefresh.mock.calls[0]?.[0]).toBeUndefined();

    await manager.refreshOne(CRED_1, AbortSignal.timeout(10_000));

    expect(calls.quotasRefresh.mock.calls[1]?.[0]).toEqual([CRED_1]);
    calls.quotasRefresh.mockResolvedValueOnce({ updated: 0, failed: [CRED_1] });
    await expect(manager.refreshOne(CRED_1, AbortSignal.timeout(10_000))).rejects.toThrow(
      'Quota refresh failed',
    );
  });

  it('drives a host OAuth attempt to completion', async () => {
    useTempHome();
    const { calls, manager } = host();
    const pending = await manager.add('Second');
    const session = interaction();

    await manager.login(pending.provider, session.interaction);

    expect(calls.connect).toHaveBeenCalledWith({
      integrationID: 'grok-build',
      methodID: 'browser',
      label: 'Second',
    });
    expect(session.urls).toEqual(['https://auth.x.ai/authorize']);
    expect(session.progress).toEqual(['Waiting for xAI authorization…', 'Login complete.']);
    expect((await manager.snapshot()).accounts).toHaveLength(2);
  });

  it('replaces the old credential when an existing account logs in again', async () => {
    useTempHome();
    const { calls, manager } = host();

    await manager.login(CRED_1, interaction().interaction);

    expect(calls.connect).toHaveBeenCalledWith({
      integrationID: 'grok-build',
      methodID: 'browser',
      label: 'Work',
    });
    expect(calls.remove).toHaveBeenCalledWith({ credentialID: 'cred_1' });
  });

  it('surfaces a failed attempt and cancels an aborted one', async () => {
    const { calls, manager } = host();
    calls.status.mockResolvedValue({ data: { status: 'failed', message: 'denied' } } as never);

    await expect(manager.login(CRED_1, interaction().interaction)).rejects.toThrow('denied');

    const aborted = new AbortController();
    const cancellable = host();
    cancellable.calls.status.mockImplementation(() => {
      aborted.abort();
      return Promise.resolve({ data: { status: 'pending' as const } });
    });
    const session = interaction(aborted.signal);

    await cancellable.manager.login(CRED_1, session.interaction);

    expect(cancellable.calls.cancel).toHaveBeenCalledWith({
      integrationID: 'grok-build',
      attemptID: 'attempt_1',
    });
    expect(session.progress).not.toContain('Login complete.');
  });

  it('refuses to sign in an environment account', async () => {
    const { manager } = host();

    await expect(manager.login(ENV_KEY, interaction().interaction)).rejects.toThrow(
      'cannot sign in here',
    );
  });
});
