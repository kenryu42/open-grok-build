import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchBillingUsage,
  formatQuota,
  remainingQuotaFraction,
} from '../../src/opencode/billing.js';
import {
  billingJsonResponse,
  creditsJsonResponse,
  settingsJsonResponse,
} from './billingTestHelpers.js';

describe('billing', () => {
  const originalFetch = globalThis.fetch;
  const weeklyCreditsFetch = (monthly: () => Response | Promise<Response>) =>
    vi.fn<typeof fetch>(async (input) => {
      const url = input.toString();
      if (url.endsWith('/settings')) return settingsJsonResponse('X Premium');
      if (url.includes('format=credits')) {
        return creditsJsonResponse(100, 25, '2026-07-14T00:19:56+00:00');
      }
      return monthly();
    });

  beforeEach(() => {
    vi.stubEnv('GROK_BUILD_BASE_URL', 'https://cli-chat-proxy.grok.com/v1');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('fetches billing usage, weekly credits, and subscription tier', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString();
      if (url.endsWith('/settings')) return settingsJsonResponse('X Premium');
      return url.includes('format=credits')
        ? creditsJsonResponse(100, 35, '2026-07-14T00:19:56+00:00', {
            prepaidBalance: { val: 500 },
            isUnifiedBillingUser: true,
          })
        : billingJsonResponse(4000, 172, '2026-08-01T00:00:00+00:00');
    });
    globalThis.fetch = fetchMock;

    const usage = await fetchBillingUsage('secret-token');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cli-chat-proxy.grok.com/v1/billing');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://cli-chat-proxy.grok.com/v1/settings');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer secret-token',
      'x-xai-token-auth': 'xai-grok-cli',
      'x-grok-client-version': '0.2.111',
      accept: 'application/json',
    });
    expect(usage).toEqual({
      monthly: {
        monthlyLimit: 4000,
        used: 172,
        billingPeriodEnd: '2026-08-01T00:00:00+00:00',
      },
      credits: {
        creditUsagePercent: 35,
        billingPeriodStart: '2026-07-07T00:19:56+00:00',
        billingPeriodEnd: '2026-07-14T00:19:56+00:00',
        periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
        prepaidBalance: 500,
        onDemandCap: 100,
        onDemandUsed: 35,
        isUnifiedBillingUser: true,
      },
      weekly: {
        creditUsagePercent: 35,
        billingPeriodEnd: '2026-07-14T00:19:56+00:00',
      },
      subscriptionTier: 'X Premium',
    });
    expect(formatQuota(usage).join('\n')).toContain('Weekly Limit (X Premium)');
    expect(formatQuota(usage).join('\n')).toContain('Used       35%');
  });

  it('treats an omitted fresh-period percentage as zero', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString();
      if (url.endsWith('/settings')) return settingsJsonResponse('X Premium');
      return url.includes('format=credits')
        ? creditsJsonResponse(undefined, undefined, '2026-07-14T00:19:56+00:00')
        : billingJsonResponse(4000, 172, '2026-08-01T00:00:00+00:00');
    });

    expect((await fetchBillingUsage('token')).credits?.creditUsagePercent).toBe(0);
  });

  it('keeps monthly billing when supplemental credits are unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString();
      return url.includes('format=credits')
        ? new Response('', { status: 404 })
        : billingJsonResponse(4000, 172, '2026-08-01T00:00:00+00:00');
    });
    globalThis.fetch = fetchMock;

    const usage = await fetchBillingUsage('secret-token');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(usage).toEqual({
      monthly: {
        monthlyLimit: 4000,
        used: 172,
        billingPeriodEnd: '2026-08-01T00:00:00+00:00',
      },
    });
    expect(formatQuota(usage).join('\n')).toContain('weekly usage unavailable');
  });

  it('keeps weekly credits when legacy monthly billing is unavailable', async () => {
    const fetchMock = weeklyCreditsFetch(() => new Response('', { status: 500 }));
    globalThis.fetch = fetchMock;

    const usage = await fetchBillingUsage('secret-token');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(usage.monthly).toBeUndefined();
    expect(usage.weekly?.creditUsagePercent).toBe(25);
  });

  it('keeps weekly credits when legacy monthly billing has a network failure', async () => {
    globalThis.fetch = weeklyCreditsFetch(() => {
      throw new Error('monthly network failure');
    });

    const usage = await fetchBillingUsage('secret-token');

    expect(usage.monthly).toBeUndefined();
    expect(usage.weekly?.creditUsagePercent).toBe(25);
  });

  it('falls back when a successful credits response is malformed', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) =>
      input.toString().includes('format=credits')
        ? creditsJsonResponse(undefined, undefined, '2026-08-01T00:00:00.000Z', {
            creditUsagePercent: '10',
          })
        : billingJsonResponse(100, 10, '2026-08-01T00:00:00+00:00'),
    );

    expect((await fetchBillingUsage('token')).monthly?.used).toBe(10);
  });

  it('rejects malformed legacy billing instead of returning NaN values', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      billingJsonResponse('4000', 1421, '2026-07-01T00:00:00+00:00'),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchBillingUsage('token')).rejects.toThrow('invalid billing payload');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects a billing value object without a finite value', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(undefined, 1421, '2026-07-01T00:00:00+00:00'),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchBillingUsage('token')).rejects.toThrow('invalid billing payload');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ranks remaining credits by weekly usage', () => {
    expect(
      remainingQuotaFraction({
        credits: { creditUsagePercent: 25, billingPeriodEnd: '2026-08-01T00:00:00.000Z' },
      }),
    ).toBe(0.75);
    expect(
      remainingQuotaFraction({
        monthly: {
          monthlyLimit: 100,
          used: 20,
          billingPeriodEnd: '2026-08-01T00:00:00.000Z',
        },
      }),
    ).toBeUndefined();
    expect(
      remainingQuotaFraction({
        credits: { creditUsagePercent: 0, billingPeriodEnd: '2026-08-01T00:00:00.000Z' },
        monthly: {
          monthlyLimit: 0,
          used: 0,
          billingPeriodEnd: '2026-08-01T00:00:00.000Z',
        },
      }),
    ).toBe(1);
    expect(
      remainingQuotaFraction({
        subscriptionTier: 'Free',
        credits: { creditUsagePercent: 25, billingPeriodEnd: '2026-08-01T00:00:00.000Z' },
      }),
    ).toBeUndefined();
  });
});
