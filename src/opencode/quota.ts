import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const QUOTA_CACHE_FILE = 'grok-cli-quota.json';

interface RateLimitInfo {
  remainingRequests: number;
  limitRequests: number;
  remainingTokens: number;
  limitTokens: number;
  contextWindow: number;
  zeroDataRetention: boolean;
  capturedAt: number;
}

const cachedRateLimits = new Map<string, RateLimitInfo>();

function quotaCachePath() {
  return join(homedir(), '.config', 'opencode', QUOTA_CACHE_FILE);
}

function isRateLimitInfo(value: unknown): value is RateLimitInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.remainingRequests === 'number' &&
    typeof info.limitRequests === 'number' &&
    typeof info.remainingTokens === 'number' &&
    typeof info.limitTokens === 'number' &&
    typeof info.contextWindow === 'number' &&
    typeof info.zeroDataRetention === 'boolean' &&
    typeof info.capturedAt === 'number'
  );
}

export function loadQuotaCache() {
  cachedRateLimits.clear();
  if (!existsSync(quotaCachePath())) return;

  try {
    const payload = JSON.parse(readFileSync(quotaCachePath(), 'utf8')) as Record<string, unknown>;
    const models = payload.models;
    if (!models || typeof models !== 'object') return;

    Object.entries(models).forEach(([model, rateLimit]) => {
      if (isRateLimitInfo(rateLimit)) cachedRateLimits.set(model, rateLimit);
    });
  } catch {
    cachedRateLimits.clear();
  }
}

function persistQuotaCache() {
  try {
    mkdirSync(dirname(quotaCachePath()), { recursive: true });
    writeFileSync(
      quotaCachePath(),
      JSON.stringify({ version: 1, models: Object.fromEntries(cachedRateLimits) }, null, '\t'),
    );
  } catch {
    // Cache-only; persistence failures should not break requests.
  }
}

function extractRateLimit(h: Record<string, string>): RateLimitInfo | undefined {
  const remainingReqs = Number(h['x-ratelimit-remaining-requests']);
  const limitReqs = Number(h['x-ratelimit-limit-requests']);
  const remainingTokens = Number(h['x-ratelimit-remaining-tokens']);
  const limitTokens = Number(h['x-ratelimit-limit-tokens']);
  const contextWindow = Number(h['x-grok-context-window']);

  if (
    [remainingReqs, limitReqs, remainingTokens, limitTokens].some(
      (value) => !Number.isFinite(value),
    )
  ) {
    return undefined;
  }

  return {
    remainingRequests: remainingReqs,
    limitRequests: limitReqs,
    remainingTokens,
    limitTokens,
    contextWindow: contextWindow || 512_000,
    zeroDataRetention: h['x-zero-data-retention'] === 'true',
    capturedAt: Date.now(),
  };
}

export function captureRateLimit(modelId: string, headers: Record<string, string>) {
  const rateLimit = extractRateLimit(headers);
  if (!rateLimit) return;
  cachedRateLimits.set(modelId, rateLimit);
  persistQuotaCache();
}

export function getCachedRateLimit(modelId: string): RateLimitInfo | undefined {
  return cachedRateLimits.get(modelId);
}
