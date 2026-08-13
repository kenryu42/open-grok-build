import type { OpenGrokBuildConfig } from '../config.js';
import { isGrokBuildAccount } from '../config.js';
import { remainingQuotaFraction } from './billing.js';
import { type CachedQuota, isCachedQuotaFresh, type QuotaCache } from './quotaCache.js';

export const EXHAUSTED_BALANCE_ERROR =
  'OpenAI API error (402): 402 "Grok Build usage balance exhausted"';
export const ROTATION_CONTINUATION =
  'Continue the previous request using the newly selected Grok account. Do not repeat completed work.';
export const RECENT_EXHAUSTION_COOLDOWN_MS = 5 * 60_000;

export function isExactExhaustionError(errorMessage: unknown) {
  return typeof errorMessage === 'string' && errorMessage.trim() === EXHAUSTED_BALANCE_ERROR;
}

function circularProviders(providers: string[], current: string) {
  const index = providers.indexOf(current);
  if (index < 0) return providers;
  return [...providers.slice(index + 1), ...providers.slice(0, index)];
}

function quotaScore(entry: CachedQuota | undefined, now: number) {
  if (!entry || !isCachedQuotaFresh(entry, now)) return undefined;
  return remainingQuotaFraction(entry);
}

export function orderAccountsByQuota(
  providers: string[],
  accounts: QuotaCache['accounts'],
  now = Date.now(),
) {
  const scored = providers.flatMap((provider, index) => {
    const score = quotaScore(accounts[provider], now);
    return score === undefined ? [] : [{ provider, index, score }];
  });
  const ranked = [...scored].sort(
    (left, right) => right.score - left.score || left.index - right.index,
  );
  return providers.map((provider, index) => {
    const scoredIndex = scored.findIndex((candidate) => candidate.index === index);
    return scoredIndex < 0 ? provider : (ranked[scoredIndex]?.provider ?? provider);
  });
}

export interface RotationCandidates {
  config: OpenGrokBuildConfig;
  currentProvider: string;
  authenticatedProviders: Iterable<string>;
  quota?: QuotaCache;
  now?: number;
}

export class ExhaustionRotation {
  private exhausted = new Set<string>();
  private unavailable = new Set<string>();
  private recentlyExhausted = new Map<string, number>();

  markExhausted(provider: string, errorMessage: unknown, now = Date.now()) {
    if (!isGrokBuildAccount(provider) || !isExactExhaustionError(errorMessage)) return false;
    this.exhausted.add(provider);
    this.recentlyExhausted.set(provider, now);
    return true;
  }

  markUnavailable(provider: string) {
    if (isGrokBuildAccount(provider)) this.unavailable.add(provider);
  }

  clearRecentExhaustion(provider: string) {
    this.recentlyExhausted.delete(provider);
  }

  clearChain() {
    this.exhausted.clear();
    this.unavailable.clear();
  }

  candidates(options: RotationCandidates) {
    const now = options.now ?? Date.now();
    const configured = new Set(options.config.accounts.items.map((account) => account.provider));
    if (!configured.has(options.currentProvider)) return [];
    const authenticated = new Set(options.authenticatedProviders);
    const providers = circularProviders(
      options.config.accounts.items.map((account) => account.provider),
      options.currentProvider,
    ).filter(
      (provider) =>
        provider !== options.currentProvider &&
        authenticated.has(provider) &&
        !this.exhausted.has(provider) &&
        !this.unavailable.has(provider) &&
        !this.isRecentlyExhausted(provider, now),
    );
    return orderAccountsByQuota(providers, options.quota?.accounts ?? {}, now);
  }

  allAuthenticatedAccountsExhausted(
    config: OpenGrokBuildConfig,
    authenticatedProviders: Iterable<string>,
    now = Date.now(),
  ) {
    const authenticated = new Set(authenticatedProviders);
    const accounts = config.accounts.items.filter((account) => authenticated.has(account.provider));
    return (
      accounts.length > 0 &&
      accounts.every(
        (account) =>
          this.exhausted.has(account.provider) || this.isRecentlyExhausted(account.provider, now),
      )
    );
  }

  private isRecentlyExhausted(provider: string, now: number) {
    const exhaustedAt = this.recentlyExhausted.get(provider);
    if (exhaustedAt === undefined) return false;
    if (now - exhaustedAt < RECENT_EXHAUSTION_COOLDOWN_MS) return true;
    this.recentlyExhausted.delete(provider);
    return false;
  }
}
