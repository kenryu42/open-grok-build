import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as oauth from '../auth/oauth.js';
import { GROK_BUILD_ACCOUNT_ID, isGrokBuildAccount, loadConfig } from '../config.js';
import { getOpenCodeDataDirectory } from '../storage.js';
import { fetchBillingUsage, formatQuota } from './billing.js';
import { loadQuotaCache, saveQuotaUsage } from './quotaCache.js';

export const GROK_BUILD_USAGE_COMMAND = 'grok-build-usage';

export const GROK_BUILD_USAGE_DESCRIPTION =
  'Show Grok Build provider status, billing quota, and token health';

type StoredAuth = {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
};

export type GrokBuildAuthWriter = (
  provider: string,
  auth: { type: 'oauth'; access: string; refresh: string; expires: number },
) => Promise<unknown>;

const tokenRefreshes = new Map<string, Promise<string>>();
const freshTokens = new Map<
  string,
  {
    source: string;
    access: string;
    refresh: string;
    expires: number;
  }
>();

function opencodeAuthPath() {
  return join(getOpenCodeDataDirectory(), 'auth.json');
}

function parseAuth(raw: string | undefined): Record<string, StoredAuth> {
  if (!raw) return {};
  try {
    const payload: unknown = JSON.parse(raw);
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, StoredAuth>)
      : {};
  } catch {
    return {};
  }
}

function readOpencodeAuthFile() {
  try {
    return parseAuth(readFileSync(opencodeAuthPath(), 'utf8'));
  } catch {
    return {};
  }
}

function storedAuth() {
  const file = readOpencodeAuthFile();
  const environment = parseAuth(process.env.OPENCODE_AUTH_CONTENT);
  return {
    ...file,
    ...Object.fromEntries(
      Object.entries(environment).filter(([provider, entry]) => {
        const persisted = file[provider];
        return (
          entry.type !== 'oauth' ||
          persisted?.type !== 'oauth' ||
          typeof entry.expires !== 'number' ||
          typeof persisted.expires !== 'number' ||
          persisted.expires <= entry.expires
        );
      }),
    ),
  };
}

function oauthFingerprint(entry: StoredAuth) {
  return `${entry.access ?? ''}:${entry.refresh ?? ''}:${entry.expires ?? ''}`;
}

export function invalidateFreshGrokBuildAccessToken(provider: string) {
  freshTokens.delete(provider);
}

export function resolveGrokBuildAccessToken(
  provider = loadConfig().config.accounts.selectedProvider,
): string | undefined {
  if (!isGrokBuildAccount(provider)) return undefined;
  if (provider === GROK_BUILD_ACCOUNT_ID && process.env.GROK_BUILD_OAUTH_TOKEN) {
    return process.env.GROK_BUILD_OAUTH_TOKEN;
  }
  const entry = storedAuth()[provider];
  if (!entry || typeof entry !== 'object') return undefined;
  if (entry.type === 'oauth' && typeof entry.access === 'string' && entry.access) {
    return entry.access;
  }
  if (entry.type === 'api' && typeof entry.key === 'string' && entry.key) return entry.key;
  return undefined;
}

export async function resolveFreshGrokBuildAccessToken(
  provider = loadConfig().config.accounts.selectedProvider,
  writeAuth?: GrokBuildAuthWriter,
) {
  if (!isGrokBuildAccount(provider)) return;
  if (provider === GROK_BUILD_ACCOUNT_ID && process.env.GROK_BUILD_OAUTH_TOKEN) {
    return process.env.GROK_BUILD_OAUTH_TOKEN;
  }
  const entry = storedAuth()[provider];
  if (!entry || typeof entry !== 'object') return;
  if (entry.type === 'api' && typeof entry.key === 'string' && entry.key) return entry.key;
  if (
    entry.type !== 'oauth' ||
    typeof entry.access !== 'string' ||
    !entry.access ||
    typeof entry.refresh !== 'string' ||
    !entry.refresh
  ) {
    return;
  }
  const source = oauthFingerprint(entry);
  const fresh = freshTokens.get(provider);
  if (fresh && fresh.source !== source) freshTokens.delete(provider);
  const credentials =
    fresh?.source === source
      ? fresh
      : { access: entry.access, refresh: entry.refresh, expires: entry.expires ?? 0 };
  if (
    typeof credentials.expires === 'number' &&
    Number.isFinite(credentials.expires) &&
    credentials.expires > Date.now()
  ) {
    return credentials.access;
  }
  if (!writeAuth) return;
  const active = tokenRefreshes.get(provider);
  if (active) return active;
  const refresh = oauth
    .refresh({
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires ?? 0,
    })
    .then(async (credentials) => {
      freshTokens.set(provider, {
        source,
        access: credentials.access,
        refresh: credentials.refresh,
        expires: credentials.expires,
      });
      await writeAuth(provider, {
        type: 'oauth',
        access: credentials.access,
        refresh: credentials.refresh,
        expires: credentials.expires,
      }).catch(() => undefined);
      return credentials.access;
    })
    .finally(() => tokenRefreshes.delete(provider));
  tokenRefreshes.set(provider, refresh);
  return refresh;
}

export function authenticatedGrokBuildAccounts() {
  const auth = storedAuth();
  return loadConfig().config.accounts.items.flatMap((account) => {
    if (
      (account.provider === GROK_BUILD_ACCOUNT_ID && process.env.GROK_BUILD_OAUTH_TOKEN) ||
      (auth[account.provider]?.type === 'oauth' &&
        typeof auth[account.provider]?.access === 'string' &&
        auth[account.provider].access) ||
      (auth[account.provider]?.type === 'api' &&
        typeof auth[account.provider]?.key === 'string' &&
        auth[account.provider].key)
    ) {
      return [account.provider];
    }
    return [];
  });
}

export function environmentGrokBuildAccounts() {
  const environment = parseAuth(process.env.OPENCODE_AUTH_CONTENT);
  return loadConfig().config.accounts.items.flatMap((account) => {
    if (
      (account.provider === GROK_BUILD_ACCOUNT_ID && process.env.GROK_BUILD_OAUTH_TOKEN) ||
      environment[account.provider]?.type === 'oauth' ||
      environment[account.provider]?.type === 'api'
    ) {
      return [account.provider];
    }
    return [];
  });
}

export interface UsageReportOptions {
  provider?: string;
  token?: string;
  signal?: AbortSignal;
}

export async function buildGrokBuildUsageReport(
  options: UsageReportOptions = {},
): Promise<string[]> {
  const provider = options.provider ?? loadConfig().config.accounts.selectedProvider;
  if (!isGrokBuildAccount(provider)) {
    return [`  Unknown Grok Build account: ${provider}`, ...formatQuota(undefined)];
  }
  const lines: string[] = [];

  if (provider === GROK_BUILD_ACCOUNT_ID && process.env.GROK_BUILD_OAUTH_TOKEN) {
    lines.push('  ⚠️  Using GROK_BUILD_OAUTH_TOKEN env bypass — no auto-refresh available');
  }

  const token = options.token ?? resolveGrokBuildAccessToken(provider);
  if (!token) {
    lines.push(...formatQuota(undefined));
    return lines;
  }

  try {
    const usage = await fetchBillingUsage(token, options.signal ?? AbortSignal.timeout(30_000));
    try {
      await saveQuotaUsage(provider, usage);
    } catch (error) {
      lines.push(
        `  quota cache update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    lines.push(...formatQuota(usage));
  } catch (error) {
    lines.push(
      `  billing refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    const cached = loadQuotaCache().accounts[provider];
    if (cached) {
      lines.push(`  Cached usage from ${cached.updatedAt}:`);
      lines.push(...formatQuota(cached));
    } else {
      lines.push(...formatQuota(undefined));
    }
  }

  return lines;
}
