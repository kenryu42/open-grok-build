import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchBillingUsage, formatQuota } from './billing.js';
import { GROK_BUILD_PROVIDER_ID } from './grokModels.js';

export const GROK_BUILD_USAGE_COMMAND = 'grok-build-usage';

export const GROK_BUILD_USAGE_DESCRIPTION =
  'Show Grok Build provider status, billing quota, and token health';

type StoredAuth = {
  type?: string;
  access?: string;
  key?: string;
};

function opencodeAuthPath() {
  return join(homedir(), '.local', 'share', 'opencode', 'auth.json');
}

function readOpencodeAuthFile(): Record<string, StoredAuth> {
  const path = opencodeAuthPath();
  if (!existsSync(path)) return {};
  try {
    const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!payload || typeof payload !== 'object') return {};
    return payload as Record<string, StoredAuth>;
  } catch {
    return {};
  }
}

function readOpencodeAuthFromEnv(): Record<string, StoredAuth> {
  const raw = process.env.OPENCODE_AUTH_CONTENT;
  if (!raw) return {};
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (!payload || typeof payload !== 'object') return {};
    return payload as Record<string, StoredAuth>;
  } catch {
    return {};
  }
}

export function resolveGrokBuildAccessToken(): string | undefined {
  const envToken = process.env.GROK_BUILD_OAUTH_TOKEN;
  if (envToken) return envToken;

  const auth = { ...readOpencodeAuthFile(), ...readOpencodeAuthFromEnv() };
  const entry = auth[GROK_BUILD_PROVIDER_ID];
  if (!entry || typeof entry !== 'object') return undefined;
  if (entry.type === 'oauth' && typeof entry.access === 'string' && entry.access) {
    return entry.access;
  }
  if (entry.type === 'api' && typeof entry.key === 'string' && entry.key) return entry.key;
  return undefined;
}

export async function buildGrokBuildUsageReport(): Promise<string[]> {
  const lines: string[] = [];

  if (process.env.GROK_BUILD_OAUTH_TOKEN) {
    lines.push('  ⚠️  Using GROK_BUILD_OAUTH_TOKEN env bypass — no auto-refresh available');
  }

  const token = resolveGrokBuildAccessToken();
  if (!token) {
    lines.push(...formatQuota(undefined));
    return lines;
  }

  try {
    lines.push(...formatQuota(await fetchBillingUsage(token)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lines.push(`  billing refresh failed: ${message}`);
    lines.push(...formatQuota(undefined));
  }

  return lines;
}
