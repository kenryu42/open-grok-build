import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AccountDashboardHandle,
  type AccountDashboardManager,
  type DashboardAccount,
  startAccountDashboard,
} from '../../src/opencode/dashboard/server.js';

const dashboards: AccountDashboardHandle[] = [];

afterEach(async () => {
  await Promise.all(dashboards.splice(0).map((dashboard) => dashboard.close()));
});

function account(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    provider: 'grok-build',
    label: 'Account 1',
    status: 'Logged in',
    authenticated: true,
    active: true,
    ...overrides,
  };
}

function manager(login = false) {
  const accounts = [account()];
  const calls: string[] = [];
  const value: AccountDashboardManager = {
    snapshot: () => ({ accounts }),
    add(label) {
      const added = account({
        provider: `grok-build-${accounts.length + 1}`,
        label: label.trim() || `Account ${accounts.length + 1}`,
        status: 'Logged out',
        authenticated: false,
        active: false,
      });
      accounts.push(added);
      calls.push(`add:${added.label}`);
      return added;
    },
    rename(provider, label) {
      const target = accounts.find((candidate) => candidate.provider === provider);
      if (target) target.label = label;
      calls.push(`rename:${provider}:${label}`);
    },
    activate(provider) {
      for (const candidate of accounts) candidate.active = candidate.provider === provider;
      calls.push(`activate:${provider}`);
    },
    logout(provider) {
      const target = accounts.find((candidate) => candidate.provider === provider);
      if (target) target.authenticated = false;
      calls.push(`logout:${provider}`);
    },
    remove(provider) {
      const index = accounts.findIndex((candidate) => candidate.provider === provider);
      if (index >= 0) accounts.splice(index, 1);
      calls.push(`remove:${provider}`);
    },
    refresh() {
      calls.push('refresh');
      return {
        updated: accounts.filter((candidate) => candidate.authenticated).length,
        failed: [],
      };
    },
    refreshOne(provider) {
      calls.push(`refreshOne:${provider}`);
    },
  };
  if (login) {
    value.login = async (provider, interaction) => {
      calls.push(`login:${provider}`);
      interaction.onProgress('secret progress with access-token');
      interaction.onAuthorizationUrl('https://accounts.x.ai/authorize?state=oauth-secret');
      const code = await interaction.waitForManualCode();
      if (interaction.signal.aborted) throw new Error('cancelled');
      if (code !== 'manual-secret') throw new Error('wrong code');
      const target = accounts.find((candidate) => candidate.provider === provider);
      if (target) {
        target.authenticated = true;
        target.status = 'Logged in';
      }
    };
  }
  return { accounts, calls, manager: value };
}

async function openDashboard(
  value: AccountDashboardManager,
  options: Parameters<typeof startAccountDashboard>[1] = {},
) {
  const dashboard = await startAccountDashboard(value, options);
  dashboards.push(dashboard);
  const bootstrap = await fetch(dashboard.bootstrapUrl, { redirect: 'manual' });
  const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0] ?? '';
  return {
    bootstrap,
    dashboard,
    cookie,
    headers: {
      Cookie: cookie,
      Origin: dashboard.origin,
      'Content-Type': 'application/json',
      'X-Grok-CSRF': dashboard.csrfToken,
    },
  };
}

async function startLogin(
  session: Awaited<ReturnType<typeof openDashboard>>,
  provider = 'grok-build',
) {
  const ticket = await fetch(`${session.dashboard.origin}/api/accounts/${provider}/login-ticket`, {
    method: 'POST',
    headers: session.headers,
  });
  const path = ((await ticket.json()) as { path: string }).path;
  const redirect = await fetch(`${session.dashboard.origin}${path}`, {
    headers: { Cookie: session.cookie },
    redirect: 'manual',
  });
  return { path, redirect, ticket };
}

describe('OpenCode account dashboard', () => {
  it('binds to loopback and exchanges its bootstrap capability for a strict cookie', async () => {
    const session = await openDashboard(manager().manager);
    const reused = await fetch(session.dashboard.bootstrapUrl, { redirect: 'manual' });

    expect(new URL(session.dashboard.origin).hostname).toBe('127.0.0.1');
    expect(session.bootstrap.status).toBe(302);
    expect(session.bootstrap.headers.get('location')).toBe('/');
    expect(session.bootstrap.headers.get('set-cookie')).toMatch(
      /^open_grok_dashboard_[a-f0-9]+=.+; HttpOnly; SameSite=Strict; Path=\/$/,
    );
    expect(reused.status).toBe(401);
    expect(reused.headers.get('set-cookie')).toBeNull();
    expect((await fetch(`${session.dashboard.origin}/api/state`)).status).toBe(401);
  });

  it('resets modal confirmation state before each opening', async () => {
    const session = await openDashboard(manager().manager);
    const javascript = await (
      await fetch(`${session.dashboard.origin}/app.js`, {
        headers: { Cookie: session.cookie },
      })
    ).text();

    expect(javascript.indexOf("dialog.returnValue = 'cancel';")).toBeGreaterThan(-1);
    expect(javascript.indexOf("dialog.returnValue = 'cancel';")).toBeLessThan(
      javascript.indexOf('dialog.showModal();'),
    );
  });

  it('requires the exact host and serves authenticated state with security headers', async () => {
    const session = await openDashboard(manager().manager);
    const invalidHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${session.dashboard.origin}/api/state`, {
        headers: { Cookie: session.cookie, Host: 'localhost' },
      });
      request.once('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.once('error', reject);
      request.end();
    });
    const response = await fetch(`${session.dashboard.origin}/api/state`, {
      headers: { Cookie: session.cookie },
    });

    expect(invalidHost).toBe(421);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('only serializes public account and quota fields', async () => {
    const setup = manager();
    setup.accounts[0] = {
      ...account({
        quota: {
          updatedAt: 123,
          fresh: true,
          credits: {
            creditUsagePercent: 25,
            billingPeriodEnd: '2026-08-01',
            periodType: 'weekly',
          },
        },
      }),
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      code: 'manual-secret',
      state: 'oauth-secret',
      quota: {
        ...account().quota,
        updatedAt: 123,
        fresh: true,
        credits: {
          creditUsagePercent: 25,
          billingPeriodEnd: '2026-08-01',
          periodType: 'weekly',
          credential: 'nested-secret',
        },
      },
    } as DashboardAccount;
    const session = await openDashboard(setup.manager);
    const response = await fetch(`${session.dashboard.origin}/api/state`, {
      headers: { Cookie: session.cookie },
    });
    const text = await response.text();

    expect(JSON.parse(text)).toMatchObject({
      accounts: [
        {
          provider: 'grok-build',
          quota: { credits: { creditUsagePercent: 25, periodType: 'weekly' } },
          login: { state: 'unavailable' },
        },
      ],
    });
    expect(text).not.toMatch(
      /access-secret|refresh-secret|manual-secret|oauth-secret|nested-secret/,
    );
  });

  it('validates exact Origin and CSRF before applying all account mutations', async () => {
    const setup = manager();
    const session = await openDashboard(setup.manager);
    const rejectedOrigin = await fetch(`${session.dashboard.origin}/api/accounts`, {
      method: 'POST',
      headers: { ...session.headers, Origin: 'https://evil.example' },
      body: JSON.stringify({ label: 'Work' }),
    });
    const rejectedCsrf = await fetch(`${session.dashboard.origin}/api/accounts`, {
      method: 'POST',
      headers: { ...session.headers, 'X-Grok-CSRF': 'wrong' },
      body: JSON.stringify({ label: 'Work' }),
    });
    const added = await fetch(`${session.dashboard.origin}/api/accounts`, {
      method: 'POST',
      headers: session.headers,
      body: JSON.stringify({ label: ' Work ' }),
    });
    const renamed = await fetch(`${session.dashboard.origin}/api/accounts/grok-build-2`, {
      method: 'PATCH',
      headers: session.headers,
      body: JSON.stringify({ label: 'Client' }),
    });
    await fetch(`${session.dashboard.origin}/api/accounts/grok-build-2/activate`, {
      method: 'POST',
      headers: session.headers,
    });
    await fetch(`${session.dashboard.origin}/api/accounts/grok-build-2/logout`, {
      method: 'POST',
      headers: session.headers,
    });
    const refreshed = await fetch(`${session.dashboard.origin}/api/quotas/refresh`, {
      method: 'POST',
      headers: session.headers,
    });
    await fetch(`${session.dashboard.origin}/api/accounts/grok-build-2`, {
      method: 'DELETE',
      headers: session.headers,
    });

    expect(rejectedOrigin.status).toBe(403);
    expect(rejectedCsrf.status).toBe(403);
    expect(added.status).toBe(201);
    expect(await renamed.json()).toEqual({ label: 'Client' });
    expect(await refreshed.json()).toEqual({ updated: 1, failed: [] });
    expect(setup.calls).toEqual([
      'add:Work',
      'rename:grok-build-2:Client',
      'activate:grok-build-2',
      'logout:grok-build-2',
      'refresh',
      'remove:grok-build-2',
    ]);
  });

  it('supports encoded and multi-digit provider IDs without accepting missing accounts', async () => {
    const setup = manager();
    setup.accounts.push(
      account({
        provider: 'grok-build-10',
        label: 'Ten',
        authenticated: false,
        active: false,
      }),
      account({
        provider: 'grok build',
        label: 'Encoded',
        authenticated: false,
        active: false,
      }),
    );
    const session = await openDashboard(setup.manager);
    const multiDigit = await fetch(`${session.dashboard.origin}/api/accounts/grok-build-10`, {
      method: 'PATCH',
      headers: session.headers,
      body: JSON.stringify({ label: 'Account ten' }),
    });
    const encoded = await fetch(
      `${session.dashboard.origin}/api/accounts/${encodeURIComponent('grok build')}`,
      {
        method: 'PATCH',
        headers: session.headers,
        body: JSON.stringify({ label: 'Account encoded' }),
      },
    );
    const missing = await fetch(`${session.dashboard.origin}/api/accounts/missing/activate`, {
      method: 'POST',
      headers: session.headers,
    });

    expect(multiDigit.status).toBe(200);
    expect(encoded.status).toBe(200);
    expect(missing.status).toBe(404);
  });

  it('uses one-shot login tickets and accepts manual codes without exposing login secrets', async () => {
    const setup = manager(true);
    setup.accounts.push(
      account({
        provider: 'grok-build-2',
        label: 'Work',
        status: 'Logged out',
        authenticated: false,
        active: false,
      }),
    );
    const session = await openDashboard(setup.manager, { refreshAfterLogin: false });
    const login = await startLogin(session, 'grok-build-2');
    const reused = await fetch(`${session.dashboard.origin}${login.path}`, {
      headers: { Cookie: session.cookie },
      redirect: 'manual',
    });
    const submitted = await fetch(
      `${session.dashboard.origin}/api/accounts/grok-build-2/login-code`,
      {
        method: 'POST',
        headers: session.headers,
        body: JSON.stringify({ code: 'manual-secret' }),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = await (
      await fetch(`${session.dashboard.origin}/api/state`, {
        headers: { Cookie: session.cookie },
      })
    ).text();

    expect(login.ticket.status).toBe(201);
    expect(login.redirect.status).toBe(302);
    expect(login.redirect.headers.get('location')).toContain('https://accounts.x.ai/authorize');
    expect(reused.status).toBe(404);
    expect(submitted.status).toBe(202);
    expect(state).toContain('"state":"success"');
    expect(state).not.toMatch(/manual-secret|oauth-secret|access-token/);
  });

  it('accepts another manual code after an invalid submission', async () => {
    const setup = manager();
    setup.manager.login = async (_provider, interaction) => {
      interaction.onAuthorizationUrl('https://accounts.x.ai/authorize');
      if ((await interaction.waitForManualCode()) !== 'invalid')
        throw new Error('wrong first code');
      if ((await interaction.waitForManualCode()) !== 'valid') throw new Error('wrong second code');
    };
    const session = await openDashboard(setup.manager, { refreshAfterLogin: false });
    await startLogin(session);

    const first = await fetch(`${session.dashboard.origin}/api/accounts/grok-build/login-code`, {
      method: 'POST',
      headers: session.headers,
      body: JSON.stringify({ code: 'invalid' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await fetch(`${session.dashboard.origin}/api/accounts/grok-build/login-code`, {
      method: 'POST',
      headers: session.headers,
      body: JSON.stringify({ code: 'valid' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = await (
      await fetch(`${session.dashboard.origin}/api/state`, { headers: { Cookie: session.cookie } })
    ).text();

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(state).toContain('"state":"success"');
  });

  it('supports login cancellation and hides login routes when unsupported', async () => {
    const supported = manager(true);
    const supportedSession = await openDashboard(supported.manager);
    await startLogin(supportedSession);
    const cancelled = await fetch(
      `${supportedSession.dashboard.origin}/api/accounts/grok-build/login-cancel`,
      { method: 'POST', headers: supportedSession.headers },
    );

    const unsupportedSession = await openDashboard(manager().manager);
    const unsupported = await fetch(
      `${unsupportedSession.dashboard.origin}/api/accounts/grok-build/login-ticket`,
      { method: 'POST', headers: unsupportedSession.headers },
    );

    expect(cancelled.status).toBe(202);
    expect(unsupported.status).toBe(404);
  });

  it('cancels pending logins on logout and ignores late login completion', async () => {
    const setup = manager();
    let finishLogin = () => {};
    setup.manager.login = async (_provider, interaction) => {
      interaction.onAuthorizationUrl('https://accounts.x.ai/authorize');
      await new Promise<void>((resolve) => {
        finishLogin = resolve;
      });
    };
    const session = await openDashboard(setup.manager);
    await startLogin(session);
    await fetch(`${session.dashboard.origin}/api/accounts/grok-build/logout`, {
      method: 'POST',
      headers: session.headers,
    });
    finishLogin();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stateResponse = await fetch(`${session.dashboard.origin}/api/state`, {
      headers: { Cookie: session.cookie },
    });
    const state = await stateResponse.json();

    expect(state).toMatchObject({
      accounts: [{ login: { state: 'cancelled', progress: 'Login cancelled' } }],
    });
    expect(setup.calls).not.toContain('refreshOne:grok-build');
  });

  it('rejects malformed and oversized bodies and closes incomplete bodies on timeout', async () => {
    const session = await openDashboard(manager().manager, { bodyTimeoutMs: 20 });
    const malformed = await fetch(`${session.dashboard.origin}/api/accounts`, {
      method: 'POST',
      headers: session.headers,
      body: '{',
    });
    const oversized = await fetch(`${session.dashboard.origin}/api/accounts`, {
      method: 'POST',
      headers: session.headers,
      body: JSON.stringify({ label: 'x'.repeat(9_000) }),
    });

    const url = new URL(session.dashboard.origin);
    const socket = createConnection(Number(url.port), url.hostname);
    await once(socket, 'connect');
    socket.write(
      [
        'POST /api/accounts HTTP/1.1',
        `Host: ${url.host}`,
        `Cookie: ${session.cookie}`,
        `Origin: ${session.dashboard.origin}`,
        'Content-Type: application/json',
        `X-Grok-CSRF: ${session.dashboard.csrfToken}`,
        'Content-Length: 10',
        '',
        '{',
      ].join('\r\n'),
    );
    const response = await Promise.race([
      once(socket, 'data').then(([data]) => data.toString()),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 200)),
    ]);
    const closed = await Promise.race([
      once(socket, 'close').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    socket.destroy();

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(response).toContain('408 Request Timeout');
    expect(closed).toBe(true);
  });

  it('shuts down idle dashboards and closes promptly with incomplete requests', async () => {
    const idle = await startAccountDashboard(manager().manager, { idleMs: 20 });
    dashboards.push(idle);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(fetch(idle.origin)).rejects.toThrow();

    const session = await openDashboard(manager().manager);
    const url = new URL(session.dashboard.origin);
    const socket = createConnection(Number(url.port), url.hostname);
    await once(socket, 'connect');
    socket.write(`POST /api/accounts HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: 10\r\n\r\n{`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closedPromptly = await Promise.race([
      session.dashboard.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    socket.destroy();

    expect(closedPromptly).toBe(true);
  });

  it('does not let unauthenticated requests extend the idle lifetime', async () => {
    const dashboard = await startAccountDashboard(manager().manager, { idleMs: 80 });
    dashboards.push(dashboard);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await fetch(`${dashboard.origin}/api/state`)).status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(fetch(dashboard.origin)).rejects.toThrow();
  });
});
