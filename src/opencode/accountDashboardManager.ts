import { randomUUID } from 'node:crypto';
import { credentialID } from './accounts.js';
import type {
  AccountDashboardManager,
  DashboardAccount,
  DashboardLoginInteraction,
} from './dashboard/server.js';
import { GROK_BUILD_INTEGRATION_ID } from './integration.js';
import { removeQuotaUsage } from './quotaCache.js';
import type { AccountsListOutput } from './rpc.js';

export type OAuthAttemptStatus =
  | { status: 'pending' }
  | { status: 'complete' }
  | { status: 'failed'; message: string }
  | { status: 'expired' };

export interface DashboardHost {
  accountsList(): Promise<AccountsListOutput>;
  accountsSelect(key: string): Promise<unknown>;
  quotasRefresh(
    keys: string[] | undefined,
    signal: AbortSignal,
  ): Promise<{ updated: number; failed: string[] }>;
  credential: {
    activate(input: { credentialID: string }): Promise<void>;
    update(input: { credentialID: string; label: string }): Promise<void>;
    remove(input: { credentialID: string }): Promise<void>;
  };
  oauth: {
    connect(input: { integrationID: string; methodID: string; label?: string }): Promise<{
      data: { attemptID: string; url: string; instructions: string; mode: 'auto' | 'code' };
    }>;
    status(input: {
      integrationID: string;
      attemptID: string;
    }): Promise<{ data: OAuthAttemptStatus }>;
    cancel(input: { integrationID: string; attemptID: string }): Promise<void>;
  };
}

export const PENDING_KEY_PREFIX = 'pending:';

const isPending = (key: string) => key.startsWith(PENDING_KEY_PREFIX);

function pendingAccount(key: string, label: string): DashboardAccount {
  return {
    provider: key,
    label,
    status: 'login-required',
    authenticated: false,
    active: false,
    environment: false,
  };
}

export class OpenCodeAccountDashboardManager implements AccountDashboardManager {
  private readonly pending = new Map<string, string>();

  constructor(
    private readonly host: DashboardHost,
    private readonly pollIntervalMs = 1_000,
  ) {}

  async snapshot() {
    const listed = await this.host.accountsList();
    return {
      accounts: [
        ...listed.accounts.map((account): DashboardAccount => {
          const quota = account.quota;
          return {
            provider: account.key,
            label: account.label,
            status: account.selected ? 'active' : 'authenticated',
            authenticated: true,
            active: account.selected,
            environment: account.environment,
            ...(quota?.subscriptionTier ? { plan: quota.subscriptionTier } : {}),
            ...(quota
              ? {
                  quota: {
                    updatedAt: quota.updatedAt,
                    fresh: quota.fresh,
                    ...(quota.credits ? { credits: quota.credits } : {}),
                    ...(quota.monthly ? { monthly: quota.monthly } : {}),
                    ...(quota.weekly ? { weekly: quota.weekly } : {}),
                  },
                }
              : {}),
          };
        }),
        ...[...this.pending].map(([key, label]) => pendingAccount(key, label)),
      ],
    };
  }

  add(label: string) {
    const key = `${PENDING_KEY_PREFIX}${randomUUID()}`;
    this.pending.set(key, label.trim());
    return pendingAccount(key, label.trim());
  }

  async rename(key: string, label: string) {
    const trimmed = label.trim();
    if (!trimmed) throw new Error('Account labels cannot be empty.');
    if (isPending(key)) {
      this.pending.set(key, trimmed);
      return;
    }
    const id = credentialID(key);
    if (!id) throw new Error('Environment accounts cannot be renamed here.');
    await this.host.credential.update({ credentialID: id, label: trimmed });
  }

  async activate(key: string) {
    if (isPending(key)) throw new Error('Log in before selecting this account.');
    await this.host.accountsSelect(key);
    const id = credentialID(key);
    if (id) await this.host.credential.activate({ credentialID: id });
  }

  logout(key: string) {
    return this.remove(key);
  }

  async remove(key: string) {
    if (isPending(key)) {
      this.pending.delete(key);
      return;
    }
    const id = credentialID(key);
    if (!id) throw new Error('Environment accounts cannot be removed here. Unset the variable.');
    await this.host.credential.remove({ credentialID: id });
    await removeQuotaUsage(key);
  }

  refresh(signal: AbortSignal) {
    return this.host.quotasRefresh(
      undefined,
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    );
  }

  async refreshOne(key: string, signal: AbortSignal) {
    const result = await this.host.quotasRefresh(
      [key],
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    );
    if (!result.updated) throw new Error(`Quota refresh failed for ${key}.`);
  }

  async login(key: string, interaction: DashboardLoginInteraction) {
    const label = await this.loginLabel(key);
    const attempt = (
      await this.host.oauth.connect({
        integrationID: GROK_BUILD_INTEGRATION_ID,
        methodID: 'browser',
        ...(label ? { label } : {}),
      })
    ).data;
    interaction.onAuthorizationUrl(attempt.url);
    interaction.onProgress('Waiting for xAI authorization…');
    const completed = await this.poll(attempt.attemptID, interaction.signal);
    if (!completed) {
      await this.host.oauth.cancel({
        integrationID: GROK_BUILD_INTEGRATION_ID,
        attemptID: attempt.attemptID,
      });
      return;
    }
    this.pending.delete(key);
    const id = credentialID(key);
    if (id) {
      await this.host.credential.remove({ credentialID: id });
      await removeQuotaUsage(key);
    }
    interaction.onProgress('Login complete.');
  }

  private async loginLabel(key: string) {
    const pending = this.pending.get(key);
    if (pending !== undefined) return pending;
    if (!credentialID(key)) {
      throw new Error('Environment accounts cannot sign in here.');
    }
    const account = (await this.snapshot()).accounts.find(
      (candidate) => candidate.provider === key,
    );
    if (!account) throw new Error(`Unknown Grok Build account: ${key}`);
    return account.label;
  }

  private async poll(attemptID: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const status = (
      await this.host.oauth.status({ integrationID: GROK_BUILD_INTEGRATION_ID, attemptID })
    ).data;
    if (status.status === 'complete') return true;
    if (status.status === 'failed') throw new Error(status.message);
    if (status.status === 'expired') {
      throw new Error('Login expired. Start again from the dashboard.');
    }
    if (signal.aborted) return false;
    await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    return this.poll(attemptID, signal);
  }
}
