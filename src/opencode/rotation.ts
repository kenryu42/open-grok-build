import { remainingQuotaFraction } from './billing.js';
import { type CachedQuota, isCachedQuotaFresh, type QuotaCache } from './quotaCache.js';

const EXHAUSTED_BALANCE_MESSAGE = 'Grok Build usage balance exhausted';
export const RECENT_EXHAUSTION_COOLDOWN_MS = 5 * 60_000;

export function isExactExhaustionResponse(status: number, body: string) {
  if (status !== 402) return false;
  const trimmed = body.trim();
  if (
    trimmed === `402 "${EXHAUSTED_BALANCE_MESSAGE}"` ||
    trimmed === `"${EXHAUSTED_BALANCE_MESSAGE}"` ||
    trimmed === EXHAUSTED_BALANCE_MESSAGE
  ) {
    return true;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== 'object') return false;
    const error = 'error' in value ? value.error : undefined;
    if (typeof error === 'string') return error === EXHAUSTED_BALANCE_MESSAGE;
    return (
      Boolean(error) &&
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      error.message === EXHAUSTED_BALANCE_MESSAGE
    );
  } catch {
    return false;
  }
}

function circularKeys(keys: readonly string[], current: string) {
  const index = keys.indexOf(current);
  if (index < 0) return [...keys];
  return [...keys.slice(index + 1), ...keys.slice(0, index)];
}

function quotaScore(entry: CachedQuota | undefined, now: number) {
  if (!entry || !isCachedQuotaFresh(entry, now)) return undefined;
  return remainingQuotaFraction(entry);
}

export function orderAccountsByQuota(
  keys: string[],
  accounts: QuotaCache['accounts'],
  now = Date.now(),
) {
  const scored = keys.flatMap((key, index) => {
    const score = quotaScore(accounts[key], now);
    return score === undefined ? [] : [{ key, index, score }];
  });
  const ranked = [...scored].sort(
    (left, right) => right.score - left.score || left.index - right.index,
  );
  return keys.map((key, index) => {
    const scoredIndex = scored.findIndex((candidate) => candidate.index === index);
    return scoredIndex < 0 ? key : (ranked[scoredIndex]?.key ?? key);
  });
}

export interface RotationCandidates {
  accounts: readonly string[];
  current: string;
  quota?: QuotaCache;
  now?: number;
}

export class ExhaustionRotation {
  private exhausted = new Set<string>();
  private unavailable = new Set<string>();
  private recentlyExhausted = new Map<string, number>();

  markExhausted(key: string, now = Date.now()) {
    this.exhausted.add(key);
    this.recentlyExhausted.set(key, now);
  }

  markUnavailable(key: string) {
    this.unavailable.add(key);
  }

  clearRecentExhaustion(key: string) {
    this.recentlyExhausted.delete(key);
  }

  clearChain() {
    this.exhausted.clear();
    this.unavailable.clear();
  }

  isExhausted(key: string, now = Date.now()) {
    return this.exhausted.has(key) || this.isRecentlyExhausted(key, now);
  }

  candidates(options: RotationCandidates) {
    const now = options.now ?? Date.now();
    if (!options.accounts.includes(options.current)) return [];
    const keys = circularKeys(options.accounts, options.current).filter(
      (key) =>
        key !== options.current &&
        !this.exhausted.has(key) &&
        !this.unavailable.has(key) &&
        !this.isRecentlyExhausted(key, now),
    );
    return orderAccountsByQuota(keys, options.quota?.accounts ?? {}, now);
  }

  private isRecentlyExhausted(key: string, now: number) {
    const exhaustedAt = this.recentlyExhausted.get(key);
    if (exhaustedAt === undefined) return false;
    if (now - exhaustedAt < RECENT_EXHAUSTION_COOLDOWN_MS) return true;
    this.recentlyExhausted.delete(key);
    return false;
  }
}
