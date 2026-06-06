import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBillingUsage, formatQuota } from '../../src/opencode/billing.js';
import { billingJsonResponse } from './billingTestHelpers.js';

describe('billing', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('GROK_BUILD_BASE_URL', 'https://cli-chat-proxy.grok.com/v1');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('fetches billing usage with the Grok Build token and no user id header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(4000, 1421, '2026-07-01T00:00:00+00:00'),
    );
    globalThis.fetch = fetchMock;

    const usage = await fetchBillingUsage('secret-token');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cli-chat-proxy.grok.com/v1/billing');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer secret-token',
      'x-xai-token-auth': 'xai-grok-cli',
      accept: 'application/json',
    });
    expect(usage).toEqual({
      monthlyLimit: 4000,
      used: 1421,
      billingPeriodEnd: '2026-07-01T00:00:00+00:00',
    });
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

  it('formats credit usage and reset time', async () => {
    const lines = formatQuota({
      monthlyLimit: 4000,
      used: 1000,
      billingPeriodEnd: '2026-07-01T00:00:00+00:00',
    });
    expect(lines.join('\n')).toContain('1,000 / 4,000 credits used (25%)');
    expect(lines.join('\n')).toMatch(/Resets at/);
  });
});
