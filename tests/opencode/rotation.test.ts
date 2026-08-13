import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type OpenGrokBuildConfig } from '../../src/config.js';
import type { BillingUsage } from '../../src/opencode/billing.js';
import {
  EXHAUSTED_BALANCE_ERROR,
  ExhaustionRotation,
  isExactExhaustionError,
  orderAccountsByQuota,
  RECENT_EXHAUSTION_COOLDOWN_MS,
} from '../../src/opencode/rotation.js';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');

function config(): OpenGrokBuildConfig {
  return {
    ...DEFAULT_CONFIG,
    accounts: {
      nextAccountNumber: 4,
      selectedProvider: 'grok-build',
      items: [
        { provider: 'grok-build', label: 'Personal' },
        { provider: 'grok-build-2', label: 'Work' },
        { provider: 'grok-build-3', label: 'Client' },
      ],
    },
  };
}

function quota(percent: number): BillingUsage & { updatedAt: string } {
  return {
    updatedAt: new Date(NOW).toISOString(),
    credits: {
      creditUsagePercent: percent,
      billingPeriodEnd: '2026-08-01T00:00:00.000Z',
    },
  };
}

describe('Grok Build exhaustion rotation', () => {
  it('matches only the exact final 402 exhaustion error', () => {
    expect(isExactExhaustionError(EXHAUSTED_BALANCE_ERROR)).toBe(true);
    expect(
      isExactExhaustionError('OpenAI API error (402): 402 "Grok Build usage balance exhausted".'),
    ).toBe(false);
    expect(isExactExhaustionError('OpenAI API error (402): payment required')).toBe(false);
  });

  it('uses circular account order and skips unauthenticated aliases', () => {
    const rotation = new ExhaustionRotation();
    rotation.markExhausted('grok-build-3', EXHAUSTED_BALANCE_ERROR, NOW);

    expect(
      rotation.candidates({
        config: config(),
        currentProvider: 'grok-build-3',
        authenticatedProviders: ['grok-build-2', 'grok-build-3'],
        now: NOW,
      }),
    ).toEqual(['grok-build-2']);
  });

  it('orders fresh cached quota by greatest remaining allowance', () => {
    expect(
      orderAccountsByQuota(
        ['grok-build-2', 'grok-build-3'],
        {
          'grok-build-2': quota(90),
          'grok-build-3': quota(40),
        },
        NOW,
      ),
    ).toEqual(['grok-build-3', 'grok-build-2']);
  });

  it('leaves stale and unknown quota positions in circular order', () => {
    expect(
      orderAccountsByQuota(
        ['grok-build-2', 'grok-build-3', 'grok-build'],
        {
          'grok-build-3': {
            ...quota(90),
            updatedAt: new Date(NOW - 30 * 60_000).toISOString(),
          },
          'grok-build': quota(20),
        },
        NOW,
      ),
    ).toEqual(['grok-build-2', 'grok-build-3', 'grok-build']);
  });

  it('keeps exhausted accounts ineligible for exactly five minutes across chains', () => {
    const rotation = new ExhaustionRotation();
    rotation.markExhausted('grok-build', EXHAUSTED_BALANCE_ERROR, NOW);
    rotation.clearChain();

    expect(
      rotation.candidates({
        config: config(),
        currentProvider: 'grok-build-2',
        authenticatedProviders: ['grok-build', 'grok-build-2'],
        now: NOW + RECENT_EXHAUSTION_COOLDOWN_MS - 1,
      }),
    ).toEqual([]);
    expect(
      rotation.candidates({
        config: config(),
        currentProvider: 'grok-build-2',
        authenticatedProviders: ['grok-build', 'grok-build-2'],
        now: NOW + RECENT_EXHAUSTION_COOLDOWN_MS,
      }),
    ).toEqual(['grok-build']);
  });

  it('tracks unavailable candidates and clears recent exhaustion on login', () => {
    const rotation = new ExhaustionRotation();
    rotation.markUnavailable('grok-build-2');
    rotation.markExhausted('grok-build-3', EXHAUSTED_BALANCE_ERROR, NOW);

    expect(
      rotation.candidates({
        config: config(),
        currentProvider: 'grok-build',
        authenticatedProviders: ['grok-build', 'grok-build-2', 'grok-build-3'],
        now: NOW,
      }),
    ).toEqual([]);
    expect(
      rotation.allAuthenticatedAccountsExhausted(config(), ['grok-build', 'grok-build-3'], NOW),
    ).toBe(false);

    rotation.clearRecentExhaustion('grok-build-3');
    rotation.clearChain();
    expect(
      rotation.candidates({
        config: config(),
        currentProvider: 'grok-build',
        authenticatedProviders: ['grok-build', 'grok-build-3'],
        now: NOW,
      }),
    ).toEqual(['grok-build-3']);
  });
});
