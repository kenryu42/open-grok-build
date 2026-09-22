import type { HostAccount } from './accounts.js';
import { fetchBillingUsage, formatQuota } from './billing.js';
import { loadQuotaCache, saveQuotaUsage } from './quotaCache.js';

export const GROK_BUILD_USAGE_COMMAND = 'grok-build-usage';

export const GROK_BUILD_USAGE_DESCRIPTION = 'Show Grok Build billing quota and token health';

export interface UsageReportOptions {
  account: HostAccount;
  token: string | undefined;
  signal?: AbortSignal;
}

export async function buildGrokBuildUsageReport(options: UsageReportOptions): Promise<string[]> {
  const lines = [`  Account: ${options.account.label}`];
  if (options.account.environment) {
    lines.push('  ⚠️  Using GROK_BUILD_OAUTH_TOKEN — no auto-refresh available');
  }
  if (!options.token) {
    lines.push(...formatQuota(undefined));
    return lines;
  }

  try {
    const usage = await fetchBillingUsage(
      options.token,
      options.signal ?? AbortSignal.timeout(30_000),
    );
    await saveQuotaUsage(options.account.key, usage).catch((error: unknown) => {
      lines.push(
        `  quota cache update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    lines.push(...formatQuota(usage));
  } catch (error) {
    lines.push(
      `  billing refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    const cached = loadQuotaCache().accounts[options.account.key];
    if (!cached) {
      lines.push(...formatQuota(undefined));
      return lines;
    }
    lines.push(`  Cached usage from ${cached.updatedAt}:`);
    lines.push(...formatQuota(cached));
  }

  return lines;
}
