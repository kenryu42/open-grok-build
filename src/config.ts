import { readFileSync } from 'node:fs';
import { getConfigPath, withFileLock, writeFileAtomic } from './storage.js';

export { getConfigPath } from './storage.js';

export const CONFIG_VERSION = 1 as const;
export const GROK_BUILD_ACCOUNT_ID = 'grok-build';

export interface GrokBuildAccount {
  provider: string;
  label: string;
}

export interface AccountsConfig {
  nextAccountNumber: number;
  selectedProvider: string;
  items: GrokBuildAccount[];
}

export interface OpenGrokBuildConfig {
  version: typeof CONFIG_VERSION;
  accounts: AccountsConfig;
}

export interface LoadedConfig {
  config: OpenGrokBuildConfig;
  warning?: string;
}

export const DEFAULT_ACCOUNTS_CONFIG: AccountsConfig = {
  nextAccountNumber: 2,
  selectedProvider: GROK_BUILD_ACCOUNT_ID,
  items: [{ provider: GROK_BUILD_ACCOUNT_ID, label: 'Account 1' }],
};

export const DEFAULT_CONFIG: OpenGrokBuildConfig = {
  version: CONFIG_VERSION,
  accounts: DEFAULT_ACCOUNTS_CONFIG,
};

function defaultConfig(): OpenGrokBuildConfig {
  return {
    version: CONFIG_VERSION,
    accounts: {
      ...DEFAULT_ACCOUNTS_CONFIG,
      items: DEFAULT_ACCOUNTS_CONFIG.items.map((account) => ({ ...account })),
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function hasTerminalControlCharacters(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

export function accountNumber(provider: string) {
  if (provider === GROK_BUILD_ACCOUNT_ID) return 1;
  const match = /^grok-build-((?:[2-9]|[1-9]\d+))$/.exec(provider);
  return match ? Number(match[1]) : undefined;
}

export function isGrokBuildAccount(provider: string | undefined): boolean {
  return typeof provider === 'string' && accountNumber(provider) !== undefined;
}

export function findAvailableAccountNumber(
  providers: Iterable<string>,
  reservedProviders: Iterable<string> = [],
) {
  const unavailable = new Set([...providers, ...reservedProviders]);
  const find = (number: number): number =>
    unavailable.has(`${GROK_BUILD_ACCOUNT_ID}-${number}`) ? find(number + 1) : number;
  return find(2);
}

export function selectAccount(config: OpenGrokBuildConfig, provider: string) {
  if (!config.accounts.items.some((account) => account.provider === provider)) {
    throw new Error(`Unknown Grok Build account: ${provider}`);
  }
  return {
    ...config,
    accounts: {
      ...config.accounts,
      selectedProvider: provider,
      items: config.accounts.items.map((account) => ({ ...account })),
    },
  };
}

function normalizeAccountsConfig(raw: unknown, warnings: string[]): AccountsConfig {
  if (raw === undefined) return defaultConfig().accounts;
  if (!isObject(raw) || !Array.isArray(raw.items)) {
    warnings.push('accounts must be an object with an items array. Using defaults.');
    return defaultConfig().accounts;
  }

  const invalid: unknown[] = [];
  const providers = new Set<string>();
  const labels = new Set<string>();
  const baseIndex = raw.items.findIndex(
    (value) =>
      isObject(value) &&
      value.provider === GROK_BUILD_ACCOUNT_ID &&
      typeof value.label === 'string' &&
      Boolean(value.label.trim()) &&
      [...value.label.trim()].length <= 40 &&
      !hasTerminalControlCharacters(value.label.trim()),
  );
  const values =
    baseIndex >= 0
      ? [raw.items[baseIndex], ...raw.items.filter((_value, index) => index !== baseIndex)]
      : [{ provider: GROK_BUILD_ACCOUNT_ID, label: 'Account 1' }, ...raw.items];
  const items = values.flatMap((value) => {
    if (!isObject(value) || typeof value.provider !== 'string' || typeof value.label !== 'string') {
      invalid.push(value);
      return [];
    }
    const label = value.label.trim();
    const normalizedLabel = label.toLocaleLowerCase();
    if (
      accountNumber(value.provider) === undefined ||
      !label ||
      [...label].length > 40 ||
      hasTerminalControlCharacters(label) ||
      providers.has(value.provider) ||
      labels.has(normalizedLabel)
    ) {
      invalid.push(value);
      return [];
    }
    providers.add(value.provider);
    labels.add(normalizedLabel);
    return [{ provider: value.provider, label }];
  });

  if (invalid.length)
    warnings.push('accounts contains invalid or duplicate entries. Ignoring them.');
  return {
    nextAccountNumber: findAvailableAccountNumber(providers),
    selectedProvider:
      typeof raw.selectedProvider === 'string' && providers.has(raw.selectedProvider)
        ? raw.selectedProvider
        : GROK_BUILD_ACCOUNT_ID,
    items,
  };
}

export function normalizeConfig(raw: unknown, warnings: string[] = []): OpenGrokBuildConfig {
  const value = isObject(raw) ? raw : {};
  if (raw !== undefined && !isObject(raw)) warnings.push('config must be a JSON object.');
  return {
    version: CONFIG_VERSION,
    accounts: normalizeAccountsConfig(value.accounts, warnings),
  };
}

export function loadConfig(path = getConfigPath()): LoadedConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObject(raw)) {
      return {
        config: defaultConfig(),
        warning: `Config ${path} must be a JSON object. Using defaults.`,
      };
    }
    if (raw.version !== CONFIG_VERSION) {
      return {
        config: defaultConfig(),
        warning: `Unsupported config version ${String(raw.version)} in ${path}. Using defaults.`,
      };
    }
    const warnings: string[] = [];
    const config = normalizeConfig(raw, warnings);
    return warnings.length
      ? { config, warning: `Invalid ${path}: ${warnings.join(' ')}` }
      : { config };
  } catch (error) {
    const code = isObject(error) ? error.code : undefined;
    if (code === 'ENOENT') return { config: defaultConfig() };
    return {
      config: defaultConfig(),
      warning: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}. Using defaults.`,
    };
  }
}

export function saveConfig(config: OpenGrokBuildConfig, path = getConfigPath()) {
  writeFileAtomic(path, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
}

export function updateConfig(
  update: (config: OpenGrokBuildConfig) => OpenGrokBuildConfig,
  path = getConfigPath(),
) {
  return withFileLock(path, () => {
    const loaded = loadConfig(path);
    if (loaded.warning) throw new Error(loaded.warning);
    const config = normalizeConfig(update(loaded.config));
    saveConfig(config, path);
    return config;
  });
}
