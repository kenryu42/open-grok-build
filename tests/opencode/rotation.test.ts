import { describe, expect, it } from 'vitest';
import type { CachedQuota } from '../../src/opencode/quotaCache.js';
import {
  ExhaustionRotation,
  isExactExhaustionResponse,
  orderAccountsByQuota,
  RECENT_EXHAUSTION_COOLDOWN_MS,
} from '../../src/opencode/rotation.js';

const A = 'credential:cred_a';
const B = 'credential:cred_b';
const E = 'env:GROK_BUILD_OAUTH_TOKEN';
const ACCOUNTS = [A, B, E];
const NOW = Date.parse('2026-07-25T10:00:00.000Z');

function quota(percent: number, updatedAt = new Date(NOW).toISOString()): CachedQuota {
  return {
    updatedAt,
    credits: { creditUsagePercent: percent, billingPeriodEnd: '2026-08-01T00:00:00.000Z' },
  };
}

describe('Grok Build exhaustion rotation', () => {
  it.each([
    ['402 "Grok Build usage balance exhausted"', true],
    ['"Grok Build usage balance exhausted"', true],
    ['Grok Build usage balance exhausted', true],
    ['{"error":"Grok Build usage balance exhausted"}', true],
    ['{"error":{"message":"Grok Build usage balance exhausted"}}', true],
    ['Grok Build usage balance exhausted.', false],
    ['{"error":"other"}', false],
    ['not json {', false],
  ])('matches the exact 402 exhaustion body %s', (body, expected) => {
    expect(isExactExhaustionResponse(402, body)).toBe(expected);
    expect(isExactExhaustionResponse(401, body)).toBe(false);
  });

  it('rotates circularly and skips exhausted accounts', () => {
    const rotation = new ExhaustionRotation();

    expect(rotation.candidates({ accounts: ACCOUNTS, current: B, now: NOW })).toEqual([E, A]);
    expect(rotation.candidates({ accounts: ACCOUNTS, current: 'credential:gone' })).toEqual([]);

    rotation.markExhausted(E, NOW);

    expect(rotation.isExhausted(E, NOW)).toBe(true);
    expect(rotation.candidates({ accounts: ACCOUNTS, current: B, now: NOW })).toEqual([A]);
  });

  it('prefers the account with the most remaining quota', () => {
    const accounts = { [A]: quota(80), [B]: quota(10) };

    expect(orderAccountsByQuota([A, B], accounts, NOW)).toEqual([B, A]);
    expect(orderAccountsByQuota([A, B, E], accounts, NOW)).toEqual([B, A, E]);
  });

  it('ignores stale quota entries when ordering', () => {
    const stale = quota(5, new Date(NOW - 60 * 60_000).toISOString());

    expect(orderAccountsByQuota([A, B], { [A]: quota(90), [B]: stale }, NOW)).toEqual([A, B]);
  });

  it('keeps recently exhausted accounts out until the cooldown expires', () => {
    const rotation = new ExhaustionRotation();
    rotation.markExhausted(A, NOW);
    rotation.clearChain();

    expect(rotation.candidates({ accounts: ACCOUNTS, current: B, now: NOW })).toEqual([E]);
    expect(
      rotation.candidates({
        accounts: ACCOUNTS,
        current: B,
        now: NOW + RECENT_EXHAUSTION_COOLDOWN_MS,
      }),
    ).toEqual([E, A]);
  });

  it('drops unavailable accounts and clears a recent exhaustion on request', () => {
    const rotation = new ExhaustionRotation();
    rotation.markUnavailable(E);
    rotation.markExhausted(A, NOW);

    expect(rotation.candidates({ accounts: ACCOUNTS, current: B, now: NOW })).toEqual([]);

    rotation.clearRecentExhaustion(A);
    rotation.clearChain();

    expect(rotation.isExhausted(A, NOW)).toBe(false);
    expect(rotation.candidates({ accounts: ACCOUNTS, current: B, now: NOW })).toEqual([E, A]);
  });
});
