import {
  accountNumber,
  findAvailableAccountNumber,
  GROK_BUILD_ACCOUNT_ID,
  type GrokBuildAccount,
  hasTerminalControlCharacters,
  loadConfig,
  type OpenGrokBuildConfig,
  saveConfig,
  selectAccount as selectAccountConfig,
  updateConfig,
} from '../config.js';
import { type BillingUsage, fetchBillingUsage } from './billing.js';
import { type QuotaCache, saveQuotaUsage } from './quotaCache.js';

export type AccountStatus = 'active' | 'authenticated' | 'login-required';

export interface AccountSnapshot {
  provider: string;
  label: string;
  status: AccountStatus;
  authenticated: boolean;
  active: boolean;
  environment: boolean;
  quota?: QuotaCache['accounts'][string];
}

export interface AccountsSnapshot {
  accounts: AccountSnapshot[];
}

export interface QuotaRefreshProgress {
  provider: string;
  completed: number;
  total: number;
  updated: boolean;
}

export interface RefreshAccountQuotasOptions {
  accounts: GrokBuildAccount[];
  resolveToken: (provider: string) => Promise<string | undefined>;
  signal: AbortSignal;
  manager?: Pick<GrokBuildAccountManager, 'generation' | 'isCurrent'>;
  fetchUsage?: (token: string, signal: AbortSignal) => Promise<BillingUsage>;
  saveUsage?: (provider: string, usage: BillingUsage) => Promise<void>;
  onProgress?: (progress: QuotaRefreshProgress) => void;
}

export function defaultAccountLabel(provider: string) {
  const number = accountNumber(provider);
  if (number === undefined) throw new Error(`Invalid Grok Build account ID: ${provider}`);
  return `Account ${number}`;
}

export function accountLabelError(config: OpenGrokBuildConfig, provider: string, label: string) {
  if (!label) return 'Account labels cannot be empty.';
  if ([...label].length > 40) return 'Account labels must be 40 characters or fewer.';
  if (hasTerminalControlCharacters(label)) {
    return 'Account labels cannot contain control characters.';
  }
  if (
    config.accounts.items.some(
      (account) =>
        account.provider !== provider &&
        account.label.toLocaleLowerCase() === label.toLocaleLowerCase(),
    )
  ) {
    return `An account named “${label}” already exists.`;
  }
  return undefined;
}

export function normalizeAccountLabel(
  config: OpenGrokBuildConfig,
  provider: string,
  value: string,
) {
  const label = value.trim() || defaultAccountLabel(provider);
  const error = accountLabelError(config, provider, label);
  if (error) throw new Error(error);
  return label;
}

function copyConfig(config: OpenGrokBuildConfig): OpenGrokBuildConfig {
  return {
    ...config,
    accounts: {
      ...config.accounts,
      items: config.accounts.items.map((account) => ({ ...account })),
    },
  };
}

function requireAccount(config: OpenGrokBuildConfig, provider: string) {
  const account = config.accounts.items.find((candidate) => candidate.provider === provider);
  if (!account) throw new Error(`Unknown Grok Build account: ${provider}`);
  return account;
}

export function addAccount(
  config: OpenGrokBuildConfig,
  label = '',
  reservedProviders: Iterable<string> = [],
) {
  const next = copyConfig(config);
  const number = findAvailableAccountNumber(
    next.accounts.items.map((account) => account.provider),
    reservedProviders,
  );
  const account = {
    provider: `${GROK_BUILD_ACCOUNT_ID}-${number}`,
    label: '',
  };
  const availableDefaultLabel = (candidate: number): string => {
    const value = `Account ${candidate}`;
    return next.accounts.items.some(
      (existing) => existing.label.toLocaleLowerCase() === value.toLocaleLowerCase(),
    )
      ? availableDefaultLabel(candidate + 1)
      : value;
  };
  account.label = normalizeAccountLabel(
    next,
    account.provider,
    label.trim() ? label : availableDefaultLabel(number),
  );
  next.accounts.items.push(account);
  next.accounts.nextAccountNumber = findAvailableAccountNumber(
    next.accounts.items.map((item) => item.provider),
    reservedProviders,
  );
  return { config: next, account };
}

export function renameAccount(config: OpenGrokBuildConfig, provider: string, label: string) {
  const next = copyConfig(config);
  requireAccount(next, provider).label = normalizeAccountLabel(next, provider, label);
  return next;
}

export { selectAccount } from '../config.js';

export function removeAccount(config: OpenGrokBuildConfig, provider: string) {
  if (provider === GROK_BUILD_ACCOUNT_ID) {
    throw new Error('The primary Grok Build account cannot be removed.');
  }
  const next = copyConfig(config);
  requireAccount(next, provider);
  next.accounts.items = next.accounts.items.filter((account) => account.provider !== provider);
  if (next.accounts.selectedProvider === provider) {
    next.accounts.selectedProvider = GROK_BUILD_ACCOUNT_ID;
  }
  next.accounts.nextAccountNumber = findAvailableAccountNumber(
    next.accounts.items.map((account) => account.provider),
  );
  return next;
}

export function buildAccountsSnapshot(
  config: OpenGrokBuildConfig,
  authenticatedProviders: Iterable<string>,
  quota: QuotaCache = { version: 1, accounts: {} },
  environmentProvider?: string,
): AccountsSnapshot {
  const authenticated = new Set(authenticatedProviders);
  if (environmentProvider) authenticated.add(environmentProvider);
  return {
    accounts: config.accounts.items.map((account) => {
      const active = config.accounts.selectedProvider === account.provider;
      const environment = environmentProvider === account.provider;
      const isAuthenticated = authenticated.has(account.provider);
      return {
        provider: account.provider,
        label: account.label,
        status:
          active && isAuthenticated
            ? 'active'
            : isAuthenticated
              ? 'authenticated'
              : 'login-required',
        authenticated: isAuthenticated,
        active,
        environment,
        ...(quota.accounts[account.provider] ? { quota: quota.accounts[account.provider] } : {}),
      };
    }),
  };
}

type ConfigLoader = () => OpenGrokBuildConfig;
type ConfigSaver = (config: OpenGrokBuildConfig) => void;
const loadStoredConfig = () => loadConfig().config;

export class GrokBuildAccountManager {
  private generations = new Map<string, number>();

  constructor(
    private readonly load: ConfigLoader = loadStoredConfig,
    private readonly save: ConfigSaver = saveConfig,
  ) {}

  private update(change: (config: OpenGrokBuildConfig) => OpenGrokBuildConfig) {
    if (this.load === loadStoredConfig && this.save === saveConfig) return updateConfig(change);
    const config = change(this.load());
    this.save(config);
    return config;
  }

  add(label = '', reservedProviders: Iterable<string> = []) {
    let added: GrokBuildAccount | undefined;
    this.update((current) => {
      const result = addAccount(current, label, reservedProviders);
      added = result.account;
      return result.config;
    });
    if (!added) throw new Error('Could not add the Grok Build account.');
    this.bump(added.provider);
    return added;
  }

  rename(provider: string, label: string) {
    const config = this.update((current) => renameAccount(current, provider, label));
    this.bump(provider);
    return requireAccount(config, provider);
  }

  select(provider: string) {
    const config = this.update((current) => selectAccountConfig(current, provider));
    return requireAccount(config, provider);
  }

  remove(provider: string) {
    this.update((current) => removeAccount(current, provider));
    this.bump(provider);
  }

  generation(provider: string) {
    return this.generations.get(provider) ?? 0;
  }

  isCurrent(provider: string, generation: number) {
    return (
      this.generation(provider) === generation &&
      this.load().accounts.items.some((account) => account.provider === provider)
    );
  }

  bump(provider: string) {
    this.generations.set(provider, this.generation(provider) + 1);
    return this.generation(provider);
  }
}

export function accountCredentialIds(config: OpenGrokBuildConfig) {
  return config.accounts.items.map((account: GrokBuildAccount) => account.provider);
}

export async function refreshAccountQuotas(options: RefreshAccountQuotasOptions) {
  const failed: string[] = [];
  let completed = 0;
  let updated = 0;
  const refresh = async (account: GrokBuildAccount) => {
    const generation = options.manager?.generation(account.provider);
    const token = await options.resolveToken(account.provider).catch(() => undefined);
    const usage =
      token && !options.signal.aborted
        ? await (options.fetchUsage ?? fetchBillingUsage)(token, options.signal).catch(
            () => undefined,
          )
        : undefined;
    const current =
      generation === undefined || options.manager?.isCurrent(account.provider, generation) === true;
    const stored =
      usage && current && !options.signal.aborted
        ? await (options.saveUsage ?? saveQuotaUsage)(account.provider, usage).then(
            () => true,
            () => false,
          )
        : false;
    if (stored) {
      updated += 1;
    } else {
      failed.push(account.provider);
    }
    completed += 1;
    options.onProgress?.({
      provider: account.provider,
      completed,
      total: options.accounts.length,
      updated: stored,
    });
  };
  const refreshBatches = async (accounts: GrokBuildAccount[]): Promise<void> => {
    if (options.signal.aborted || !accounts.length) return;
    await Promise.all(accounts.slice(0, 3).map(refresh));
    await refreshBatches(accounts.slice(3));
  };
  await refreshBatches(options.accounts);
  return { updated, failed };
}
