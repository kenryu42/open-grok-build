import { readFileSync } from 'node:fs';
import { getConfigPath, withFileLock, writeFileAtomic } from './storage.js';

export { getConfigPath } from './storage.js';

export const CONFIG_VERSION = 2 as const;

export interface AccountsConfig {
  selected?: string;
}

export interface ImagineConfig {
  enabled: boolean;
}

export interface OpenGrokBuildConfig {
  version: typeof CONFIG_VERSION;
  accounts: AccountsConfig;
  imagine: ImagineConfig;
}

export interface LoadedConfig {
  config: OpenGrokBuildConfig;
  warning?: string;
}

export const DEFAULT_CONFIG: OpenGrokBuildConfig = {
  version: CONFIG_VERSION,
  accounts: {},
  imagine: { enabled: true },
};

function defaultConfig(): OpenGrokBuildConfig {
  return { version: CONFIG_VERSION, accounts: {}, imagine: { enabled: true } };
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

function normalizeAccountsConfig(raw: unknown, warnings: string[]): AccountsConfig {
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    warnings.push('accounts must be a JSON object. Using defaults.');
    return {};
  }
  if (raw.selected === undefined) return {};
  const selected = typeof raw.selected === 'string' ? raw.selected.trim() : '';
  if (!selected || hasTerminalControlCharacters(selected)) {
    warnings.push('accounts.selected must be a non-empty string. Ignoring it.');
    return {};
  }
  return { selected };
}

function normalizeImagineConfig(raw: unknown, warnings: string[]): ImagineConfig {
  if (raw === undefined) return { enabled: true };
  if (!isObject(raw)) {
    warnings.push('imagine must be a JSON object. Using defaults.');
    return { enabled: true };
  }
  if (typeof raw.enabled === 'boolean') return { enabled: raw.enabled };
  if (raw.enabled !== undefined) {
    warnings.push('imagine.enabled must be true or false. Using enabled=true.');
  }
  return { enabled: true };
}

export function normalizeConfig(raw: unknown, warnings: string[] = []): OpenGrokBuildConfig {
  const value = isObject(raw) ? raw : {};
  if (raw !== undefined && !isObject(raw)) warnings.push('config must be a JSON object.');
  return {
    version: CONFIG_VERSION,
    accounts: normalizeAccountsConfig(value.accounts, warnings),
    imagine: normalizeImagineConfig(value.imagine, warnings),
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
    if (raw.version === 1) {
      saveConfig(defaultConfig(), path);
      return {
        config: defaultConfig(),
        warning: `Config ${path} was written by open-grok-build v1 and was reset to defaults. Reconnect extra accounts with /connect.`,
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
