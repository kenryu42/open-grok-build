import * as oauth from '../auth/oauth.js';
import { GROK_BUILD_ACCOUNT_ID, loadConfig } from '../config.js';
import {
  type AccountSnapshot,
  buildAccountsSnapshot,
  GrokBuildAccountManager,
  refreshAccountQuotas,
} from './accounts.js';
import type {
  AccountDashboardManager,
  DashboardAccount,
  DashboardLoginInteraction,
} from './dashboard/server.js';
import { isCachedQuotaFresh, loadQuotaCache, removeQuotaUsage } from './quotaCache.js';

export interface AccountRuntime {
  authenticatedProviders(): string[];
  environmentProviders(): string[];
  token(provider: string): Promise<string | undefined>;
  setAuth(
    provider: string,
    auth: { type: 'oauth'; access: string; refresh: string; expires: number },
  ): Promise<unknown>;
  removeAuth(provider: string): Promise<unknown>;
  activate(provider: string): void;
  rotation: { clearRecentExhaustion(provider: string): void };
}

function dashboardAccount(account: AccountSnapshot): DashboardAccount {
  return {
    provider: account.provider,
    label: account.label,
    status: account.status,
    authenticated: account.authenticated,
    active: account.active,
    environment: account.environment,
    ...(account.quota?.subscriptionTier ? { plan: account.quota.subscriptionTier } : {}),
    ...(account.quota
      ? { quota: { ...account.quota, fresh: isCachedQuotaFresh(account.quota) } }
      : {}),
  };
}

export class OpenCodeAccountDashboardManager implements AccountDashboardManager {
  private readonly accounts = new GrokBuildAccountManager();

  constructor(private readonly runtime: AccountRuntime) {}

  snapshot() {
    const environment = new Set(this.runtime.environmentProviders());
    return {
      accounts: buildAccountsSnapshot(
        loadConfig().config,
        this.runtime.authenticatedProviders(),
        loadQuotaCache(),
        process.env.GROK_BUILD_OAUTH_TOKEN ? GROK_BUILD_ACCOUNT_ID : undefined,
      ).accounts.map((account) =>
        dashboardAccount({
          ...account,
          environment: account.environment || environment.has(account.provider),
        }),
      ),
    };
  }

  add(label: string) {
    const account = this.accounts.add(label);
    const snapshot = buildAccountsSnapshot(
      loadConfig().config,
      this.runtime.authenticatedProviders(),
    ).accounts.find((candidate) => candidate.provider === account.provider);
    if (!snapshot) throw new Error(`Could not add Grok Build account: ${account.provider}`);
    return dashboardAccount(snapshot);
  }

  rename(provider: string, label: string) {
    this.accounts.rename(provider, label);
  }

  activate(provider: string) {
    this.runtime.activate(provider);
  }

  async logout(provider: string) {
    if (this.runtime.environmentProviders().includes(provider)) {
      throw new Error(`${provider} uses environment authentication and cannot be logged out here.`);
    }
    this.accounts.bump(provider);
    await this.runtime.removeAuth(provider);
    await removeQuotaUsage(provider);
  }

  async remove(provider: string) {
    if (provider === GROK_BUILD_ACCOUNT_ID) {
      throw new Error('The primary Grok Build account cannot be removed.');
    }
    if (this.runtime.environmentProviders().includes(provider)) {
      throw new Error(`${provider} uses environment authentication and cannot be removed here.`);
    }
    await this.runtime.removeAuth(provider);
    this.accounts.remove(provider);
    await removeQuotaUsage(provider);
  }

  async refresh(signal: AbortSignal) {
    const authenticated = new Set(this.runtime.authenticatedProviders());
    return refreshAccountQuotas({
      accounts: loadConfig().config.accounts.items.filter((account) =>
        authenticated.has(account.provider),
      ),
      resolveToken: (provider) => this.runtime.token(provider),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      manager: this.accounts,
    });
  }

  async refreshOne(provider: string, signal: AbortSignal) {
    const account = loadConfig().config.accounts.items.find(
      (candidate) => candidate.provider === provider,
    );
    if (!account) throw new Error(`Unknown Grok Build account: ${provider}`);
    const result = await refreshAccountQuotas({
      accounts: [account],
      resolveToken: (credential) => this.runtime.token(credential),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      manager: this.accounts,
    });
    if (!result.updated) throw new Error(`Quota refresh failed for ${provider}.`);
  }

  async login(provider: string, interaction: DashboardLoginInteraction) {
    if (!loadConfig().config.accounts.items.some((account) => account.provider === provider)) {
      throw new Error(`Unknown Grok Build account: ${provider}`);
    }
    if (this.runtime.environmentProviders().includes(provider)) {
      throw new Error(`${provider} uses environment authentication and cannot sign in here.`);
    }
    const session = await oauth.beginGrokBuildOAuth('open-grok-build-dashboard');
    interaction.onAuthorizationUrl(session.url);
    interaction.onProgress('Waiting for xAI authorization…');
    const cancel = () => session.cancel?.();
    interaction.signal.addEventListener('abort', cancel, { once: true });
    void (async () => {
      while (session.submitManual && !interaction.signal.aborted) {
        const code = await interaction.waitForManualCode();
        if (interaction.signal.aborted) return;
        const error = session.submitManual(code);
        if (!error) return;
        interaction.onProgress(error);
      }
    })().catch(() => undefined);
    try {
      const credentials = await session.finish();
      if (interaction.signal.aborted) return;
      await this.runtime.setAuth(provider, {
        type: 'oauth',
        access: credentials.access,
        refresh: credentials.refresh,
        expires: credentials.expires,
      });
      if (interaction.signal.aborted) {
        await this.runtime.removeAuth(provider);
        return;
      }
      this.accounts.bump(provider);
      this.runtime.rotation.clearRecentExhaustion(provider);
      interaction.onProgress('Login complete.');
    } finally {
      interaction.signal.removeEventListener('abort', cancel);
    }
  }
}
