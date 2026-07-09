import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBillingUsage, formatQuota } from '../../src/opencode/billing.js';
import { billingJsonResponse, creditsJsonResponse } from './billingTestHelpers.js';

describe('billing', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('GROK_BUILD_BASE_URL', 'https://cli-chat-proxy.grok.com/v1');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('fetches monthly and weekly billing usage with the Grok Build token and no user id header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      return url.includes('format=credits')
        ? creditsJsonResponse(1.0, '2026-07-14T00:19:56+00:00')
        : billingJsonResponse(4000, 1421, '2026-07-01T00:00:00+00:00');
    });
    globalThis.fetch = fetchMock;

    const usage = await fetchBillingUsage('secret-token');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cli-chat-proxy.grok.com/v1/billing');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer secret-token',
      'x-xai-token-auth': 'xai-grok-cli',
      accept: 'application/json',
    });
    expect(usage).toEqual({
      monthly: {
        monthlyLimit: 4000,
        used: 1421,
        billingPeriodEnd: '2026-07-01T00:00:00+00:00',
      },
      weekly: { creditUsagePercent: 1.0, billingPeriodEnd: '2026-07-14T00:19:56+00:00' },
    });
  });

  it('omits weekly usage when the credits endpoint is unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      return url.includes('format=credits')
        ? new Response('nope', { status: 500 })
        : billingJsonResponse(4000, 172, '2026-08-01T00:00:00+00:00');
    });
    globalThis.fetch = fetchMock;

    const usage = await fetchBillingUsage('secret-token');

    expect(usage.weekly).toBeUndefined();
    expect(formatQuota(usage).join('\n')).toBe(
      [
        '  Usage:',
        '    Monthly',
        '      Credits    172 / 4,000 used  4%',
        '      Remaining  3,828 credits',
        '      Reset      Jul 31, 17:00 PT',
      ].join('\n'),
    );
  });

  it('does not fetch billing when no token is available', async () => {
    const lines = formatQuota(undefined);
    expect(lines.join('\n')).toContain(
      'billing data unavailable — try again, or run /connect grok-build if not yet authenticated',
    );
  });

  it('rejects invalid billing payloads instead of returning NaN values', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingJsonResponse('4000', 1421, '2026-07-01T00:00:00+00:00'),
    );

    await expect(fetchBillingUsage('token')).rejects.toThrow('invalid billing payload');
    expect(formatQuota(undefined).join('\n')).toContain('billing data unavailable');
  });

  it('rejects invalid billing reset timestamps', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(4000, 1421, 'not-a-date'),
    );

    await expect(fetchBillingUsage('token')).rejects.toThrow('invalid billing payload');
  });

  it('formats monthly credit usage and weekly usage', () => {
    const lines = formatQuota({
      monthly: { monthlyLimit: 4000, used: 1000, billingPeriodEnd: '2026-07-01T00:00:00+00:00' },
      weekly: { creditUsagePercent: 1.0, billingPeriodEnd: '2026-07-14T00:19:56+00:00' },
    });
    expect(lines.join('\n')).toBe(
      [
        '  Usage:',
        '    Monthly',
        '      Credits    1,000 / 4,000 used  25%',
        '      Remaining  3,000 credits',
        '      Reset      Jun 30, 17:00 PT',
        '',
        '    Weekly',
        '      Limit      1% used',
        '      Reset      Jul 13, 17:19 PT',
      ].join('\n'),
    );
  });
});
