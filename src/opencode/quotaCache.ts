import { existsSync, readFileSync } from 'node:fs';
import { isGrokBuildAccount } from '../config.js';
import { getQuotaCachePath, withFileLock, writeFileAtomic } from '../storage.js';
import {
  type BillingUsage,
  type CreditsUsage,
  isBillingDate,
  isBillingObject,
  type MonthlyUsage,
  type WeeklyUsage,
} from './billing.js';

export interface CachedQuota extends BillingUsage {
  updatedAt: string;
}

export interface QuotaCache {
  version: 1;
  accounts: Record<string, CachedQuota>;
}

export const QUOTA_FRESHNESS_MS = 30 * 60_000;

const emptyCache = (): QuotaCache => ({ version: 1, accounts: {} });

function isOptionalFiniteNumber(value: unknown) {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isMonthlyUsage(value: unknown): value is MonthlyUsage {
  if (!isBillingObject(value)) return false;
  return (
    typeof value.monthlyLimit === 'number' &&
    Number.isFinite(value.monthlyLimit) &&
    typeof value.used === 'number' &&
    Number.isFinite(value.used) &&
    isBillingDate(value.billingPeriodEnd)
  );
}

function isWeeklyUsage(value: unknown): value is WeeklyUsage {
  if (!isBillingObject(value)) return false;
  return (
    typeof value.creditUsagePercent === 'number' &&
    Number.isFinite(value.creditUsagePercent) &&
    isBillingDate(value.billingPeriodEnd)
  );
}

function isCreditsUsage(value: unknown): value is CreditsUsage {
  if (!isBillingObject(value)) return false;
  return (
    typeof value.creditUsagePercent === 'number' &&
    Number.isFinite(value.creditUsagePercent) &&
    isBillingDate(value.billingPeriodEnd) &&
    (value.billingPeriodStart === undefined || isBillingDate(value.billingPeriodStart)) &&
    (value.periodType === undefined || typeof value.periodType === 'string') &&
    isOptionalFiniteNumber(value.prepaidBalance) &&
    isOptionalFiniteNumber(value.onDemandCap) &&
    isOptionalFiniteNumber(value.onDemandUsed) &&
    (value.isUnifiedBillingUser === undefined || typeof value.isUnifiedBillingUser === 'boolean')
  );
}

function parseCachedQuota(value: unknown): CachedQuota | undefined {
  if (!isBillingObject(value) || !isBillingDate(value.updatedAt)) return undefined;
  if (value.credits !== undefined && !isCreditsUsage(value.credits)) return undefined;
  if (value.monthly !== undefined && !isMonthlyUsage(value.monthly)) return undefined;
  if (value.weekly !== undefined && !isWeeklyUsage(value.weekly)) return undefined;
  if (!value.credits && !value.monthly) return undefined;
  if (value.onDemandEnabled !== undefined && typeof value.onDemandEnabled !== 'boolean') {
    return undefined;
  }
  if (value.subscriptionTier !== undefined && typeof value.subscriptionTier !== 'string') {
    return undefined;
  }
  return {
    updatedAt: value.updatedAt,
    ...(value.credits ? { credits: value.credits } : {}),
    ...(value.monthly ? { monthly: value.monthly } : {}),
    ...(value.weekly ? { weekly: value.weekly } : {}),
    ...(typeof value.onDemandEnabled === 'boolean'
      ? { onDemandEnabled: value.onDemandEnabled }
      : {}),
    ...(typeof value.subscriptionTier === 'string'
      ? { subscriptionTier: value.subscriptionTier }
      : {}),
  };
}

export function loadQuotaCache(path = getQuotaCachePath()): QuotaCache {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isBillingObject(raw) || raw.version !== 1 || !isBillingObject(raw.accounts)) {
      return emptyCache();
    }
    return {
      version: 1,
      accounts: Object.fromEntries(
        Object.entries(raw.accounts).flatMap(([provider, value]) => {
          const entry = isGrokBuildAccount(provider) ? parseCachedQuota(value) : undefined;
          return entry ? [[provider, entry]] : [];
        }),
      ),
    };
  } catch {
    return emptyCache();
  }
}

const cacheUpdates = new Map<string, Promise<void>>();

async function updateQuotaCache(
  update: (cache: QuotaCache) => boolean,
  path = getQuotaCachePath(),
) {
  const previous = cacheUpdates.get(path) ?? Promise.resolve();
  const operation = () =>
    withFileLock(path, () => {
      const cache = loadQuotaCache(path);
      if (!update(cache)) return;
      writeFileAtomic(path, `${JSON.stringify(cache, null, 2)}\n`);
    });
  const next = previous.then(operation, operation);
  cacheUpdates.set(path, next);
  try {
    await next;
  } finally {
    if (cacheUpdates.get(path) === next) cacheUpdates.delete(path);
  }
}

export function saveQuotaUsage(
  provider: string,
  usage: BillingUsage,
  updatedAt = new Date().toISOString(),
  path = getQuotaCachePath(),
) {
  if (!isGrokBuildAccount(provider)) {
    return Promise.reject(new Error(`Invalid Grok Build account ID: ${provider}`));
  }
  const entry = parseCachedQuota({ updatedAt, ...usage });
  if (!entry) return Promise.reject(new Error('Invalid quota usage'));
  return updateQuotaCache((cache) => {
    cache.accounts[provider] = entry;
    return true;
  }, path);
}

export function removeQuotaUsage(provider: string, path = getQuotaCachePath()) {
  return updateQuotaCache((cache) => {
    if (!existsSync(path) || !cache.accounts[provider]) return false;
    delete cache.accounts[provider];
    return true;
  }, path);
}

function formatAge(updatedAt: string, now: number) {
  const age = Math.max(0, now - new Date(updatedAt).getTime());
  if (age < 60_000) return 'just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}

export function isCachedQuotaFresh(entry: CachedQuota, now = Date.now()) {
  return Math.max(0, now - new Date(entry.updatedAt).getTime()) < QUOTA_FRESHNESS_MS;
}

export function formatCachedQuota(entry: CachedQuota, now = Date.now()) {
  const usage = entry.credits
    ? `Included ${Math.round(entry.credits.creditUsagePercent)}% used`
    : entry.monthly
      ? `Monthly ${entry.monthly.used.toLocaleString()} / ${entry.monthly.monthlyLimit.toLocaleString()} used`
      : 'Usage unavailable';
  return [
    usage,
    ...(!entry.credits && entry.weekly
      ? [`Weekly ${Math.round(entry.weekly.creditUsagePercent)}% used`]
      : []),
    ...(!isCachedQuotaFresh(entry, now) ? ['stale'] : []),
    formatAge(entry.updatedAt, now),
  ].join(' · ');
}
