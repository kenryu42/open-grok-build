import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const HOST = '127.0.0.1';
const COOKIE_PREFIX = 'open_grok_dashboard_';
const MAX_BODY_BYTES = 8 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_MS = 15 * 60_000;
const LOGIN_TICKET_MS = 60_000;
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

type MaybePromise<T> = T | Promise<T>;

export interface DashboardQuotaPeriod {
  creditUsagePercent?: number;
  billingPeriodEnd?: string;
  periodType?: string;
  used?: number;
  limit?: number;
  monthlyLimit?: number;
}

export interface DashboardQuota {
  updatedAt?: number | string;
  fresh?: boolean;
  credits?: DashboardQuotaPeriod;
  monthly?: DashboardQuotaPeriod;
  weekly?: DashboardQuotaPeriod;
}

export interface DashboardAccount {
  provider: string;
  label: string;
  status: string;
  authenticated: boolean;
  active: boolean;
  environment?: boolean;
  plan?: string;
  quota?: DashboardQuota;
}

export interface AccountDashboardSnapshot {
  accounts: DashboardAccount[];
}

export interface DashboardLoginInteraction {
  signal: AbortSignal;
  onAuthorizationUrl(url: string): void;
  onProgress(message: string): void;
  waitForManualCode(): Promise<string>;
}

export interface AccountDashboardManager {
  snapshot(): MaybePromise<AccountDashboardSnapshot>;
  add(label: string): MaybePromise<DashboardAccount>;
  rename(provider: string, label: string): MaybePromise<unknown>;
  activate(provider: string): MaybePromise<unknown>;
  logout(provider: string): MaybePromise<unknown>;
  remove(provider: string): MaybePromise<unknown>;
  refresh(signal: AbortSignal): MaybePromise<{ updated: number; failed: string[] }>;
  refreshOne?(provider: string, signal: AbortSignal): MaybePromise<unknown>;
  login?(provider: string, interaction: DashboardLoginInteraction): Promise<unknown>;
}

export interface AccountDashboardHandle {
  origin: string;
  bootstrapUrl: string;
  csrfToken: string;
  isOpen(): boolean;
  close(): Promise<void>;
}

export interface AccountDashboardOptions {
  bodyTimeoutMs?: number;
  idleMs?: number;
  refreshAfterLogin?: boolean;
}

type LoginState = 'pending' | 'success' | 'failed' | 'cancelled';

interface LoginJob {
  controller: AbortController;
  state: LoginState;
  progress: string;
  resolveManualCode(code: string): void;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(req: IncomingMessage, cookieName: string) {
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim().split('=', 2))
    .find(([name]) => name === cookieName)?.[1];
}

function send(res: ServerResponse, status: number, body = '', contentType = 'text/plain') {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': `${contentType}; charset=utf-8`,
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown) {
  send(res, status, JSON.stringify(value), 'application/json');
}

function readJson(req: IncomingMessage, timeoutMs: number) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json.');
  }
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (keepErrorListener = false) => {
      if (timer) clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      if (!keepErrorListener) req.removeListener('error', onError);
    };
    const fail = (error: unknown) => {
      cleanup(true);
      req.once('close', () => req.removeListener('error', onError));
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        fail(new HttpError(413, 'Request body is too large.'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON.'));
      }
    };
    const onAborted = () => fail(new HttpError(400, 'Request body was interrupted.'));
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
    timer = setTimeout(() => fail(new HttpError(408, 'Request body timed out.')), timeoutMs);
    timer.unref();
  });
}

function objectBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function publicError(error: unknown) {
  if (error instanceof HttpError) return error.message;
  return 'The dashboard action failed.';
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function routeProvider(pathname: string, suffix = '') {
  const match = new RegExp(`^/api/accounts/([^/]+)${suffix}$`).exec(pathname);
  if (!match?.[1]) return;
  try {
    const provider = decodeURIComponent(match[1]);
    const hasControlCharacter = Array.from(provider).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    );
    if (!provider || provider.length > 128 || provider.includes('/') || hasControlCharacter) {
      return;
    }
    return provider;
  } catch {
    return;
  }
}

function trustedAuthorizationUrl(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    (hostname !== 'x.ai' &&
      hostname !== 'accounts.x.ai' &&
      hostname !== 'auth.x.ai' &&
      !hostname.endsWith('.x.ai'))
  ) {
    throw new Error('Untrusted authorization URL.');
  }
  return url.toString();
}

function quotaPeriod(value: DashboardQuotaPeriod | undefined) {
  if (!value) return;
  return {
    ...(Number.isFinite(value.creditUsagePercent)
      ? { creditUsagePercent: value.creditUsagePercent }
      : {}),
    ...(typeof value.billingPeriodEnd === 'string'
      ? { billingPeriodEnd: value.billingPeriodEnd }
      : {}),
    ...(typeof value.periodType === 'string' ? { periodType: value.periodType } : {}),
    ...(Number.isFinite(value.used) ? { used: value.used } : {}),
    ...(Number.isFinite(value.limit) ? { limit: value.limit } : {}),
    ...(Number.isFinite(value.monthlyLimit) ? { monthlyLimit: value.monthlyLimit } : {}),
  };
}

function publicAccount(account: DashboardAccount) {
  return {
    provider: account.provider,
    label: account.label,
    status: account.status,
    authenticated: account.authenticated,
    active: account.active,
    environment: Boolean(account.environment),
    ...(typeof account.plan === 'string' ? { plan: account.plan } : {}),
    ...(account.quota
      ? {
          quota: {
            ...(typeof account.quota.updatedAt === 'string' ||
            Number.isFinite(account.quota.updatedAt)
              ? { updatedAt: account.quota.updatedAt }
              : {}),
            ...(typeof account.quota.fresh === 'boolean' ? { fresh: account.quota.fresh } : {}),
            ...(account.quota.credits ? { credits: quotaPeriod(account.quota.credits) } : {}),
            ...(account.quota.monthly ? { monthly: quotaPeriod(account.quota.monthly) } : {}),
            ...(account.quota.weekly ? { weekly: quotaPeriod(account.quota.weekly) } : {}),
          },
        }
      : {}),
  };
}

async function hasAccount(manager: AccountDashboardManager, provider: string) {
  return (await manager.snapshot()).accounts.some((account) => account.provider === provider);
}

export async function startAccountDashboard(
  manager: AccountDashboardManager,
  options: AccountDashboardOptions = {},
): Promise<AccountDashboardHandle> {
  const capability = randomBytes(32).toString('base64url');
  const cookieName = `${COOKIE_PREFIX}${randomBytes(8).toString('hex')}`;
  const csrfToken = randomBytes(32).toString('base64url');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replace(
    '__GROK_CSRF_TOKEN__',
    csrfToken,
  );
  const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
  const javascript = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  let origin = '';
  let expectedHost = '';
  let bootstrapAvailable = true;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let refreshController: AbortController | undefined;
  const loginTickets = new Map<string, { provider: string; expiresAt: number }>();
  const loginJobs = new Map<string, LoginJob>();

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 408 || status === 413) res.shouldKeepAlive = false;
      if (req.headers.accept?.includes('text/html')) {
        send(
          res,
          status,
          `<!doctype html><title>Open Grok Build</title><h1>Open Grok Build</h1><p>${escapeHtml(publicError(error))}</p>`,
          'text/html',
        );
        return;
      }
      json(res, status, { error: publicError(error) });
    });
  });

  const close = () => {
    if (closing) return closing;
    if (idleTimer) clearTimeout(idleTimer);
    refreshController?.abort();
    for (const job of loginJobs.values()) {
      job.controller.abort();
      job.resolveManualCode('');
    }
    closing = new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };

  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close(), options.idleMs ?? DEFAULT_IDLE_MS);
    idleTimer.unref();
  };

  const requireMutation = (req: IncomingMessage) => {
    if (
      req.headers.origin !== origin ||
      typeof req.headers['x-grok-csrf'] !== 'string' ||
      !safeEqual(req.headers['x-grok-csrf'], csrfToken)
    ) {
      throw new HttpError(
        403,
        'The dashboard rejected this request. Reload the page and try again.',
      );
    }
  };

  const cancelLogin = (provider: string, remove = false) => {
    const job = loginJobs.get(provider);
    if (job?.state !== 'pending') return;
    job.state = 'cancelled';
    job.progress = 'Login cancelled';
    job.controller.abort();
    job.resolveManualCode('');
    if (remove) loginJobs.delete(provider);
  };

  const state = async () => ({
    refreshing: Boolean(refreshController),
    accounts: (await manager.snapshot()).accounts.map((account) => {
      const job = loginJobs.get(account.provider);
      return {
        ...publicAccount(account),
        login: job
          ? { state: job.state, progress: job.progress }
          : { state: manager.login ? 'idle' : 'unavailable' },
      };
    }),
  });

  const startLogin = async (provider: string, res: ServerResponse) => {
    if (!manager.login) throw new HttpError(404, 'Browser login is not available.');
    const account = (await manager.snapshot()).accounts.find(
      (candidate) => candidate.provider === provider,
    );
    if (!account) throw new HttpError(404, 'Account not found.');
    if (account.environment) {
      throw new HttpError(409, 'This account is configured through an environment variable.');
    }
    if (loginJobs.get(provider)?.state === 'pending') {
      throw new HttpError(409, 'A login is already in progress for this account.');
    }

    const controller = new AbortController();
    const resolveManualCode = (_code: string) => {};
    let resolveAuthorizationUrl = (_url: string) => {};
    const authorizationUrl = new Promise<string>((resolve) => {
      resolveAuthorizationUrl = resolve;
    });
    const job: LoginJob = {
      controller,
      state: 'pending',
      progress: 'Waiting for xAI authorization',
      resolveManualCode,
    };
    loginJobs.set(provider, job);

    const login = manager.login(provider, {
      signal: controller.signal,
      onAuthorizationUrl(url) {
        resolveAuthorizationUrl(trustedAuthorizationUrl(url));
      },
      onProgress() {
        job.progress = 'Authorization in progress';
      },
      waitForManualCode: () =>
        new Promise<string>((resolve) => {
          job.resolveManualCode = resolve;
        }),
    });
    void login.then(
      async () => {
        if (controller.signal.aborted) return;
        job.state = 'success';
        job.progress = 'Login complete';
        job.resolveManualCode('');
        if (options.refreshAfterLogin === false || !manager.refreshOne) return;
        try {
          await manager.refreshOne(provider, controller.signal);
        } catch {
          job.progress = 'Login complete. Quota refresh failed.';
        }
      },
      () => {
        job.state = controller.signal.aborted ? 'cancelled' : 'failed';
        job.progress = controller.signal.aborted ? 'Login cancelled' : 'Login failed';
        job.resolveManualCode('');
      },
    );

    const redirect = await Promise.race([
      authorizationUrl.then((url) => ({ url })),
      login.then(
        () => ({ status: 204 }),
        () => ({ status: 502 }),
      ),
    ]);
    if ('url' in redirect) {
      res.writeHead(302, { ...SECURITY_HEADERS, Location: redirect.url });
      res.end();
      return;
    }
    send(
      res,
      redirect.status,
      '<!doctype html><title>Grok login</title><p>Return to the dashboard.</p>',
      'text/html',
    );
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.host !== expectedHost) throw new HttpError(421, 'Invalid dashboard host.');
    const url = new URL(req.url ?? '/', origin);
    if (bootstrapAvailable && req.method === 'GET' && url.pathname === `/bootstrap/${capability}`) {
      bootstrapAvailable = false;
      touch();
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        Location: '/',
        'Set-Cookie': `${cookieName}=${capability}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end();
      return;
    }
    if (!safeEqual(cookieValue(req, cookieName) ?? '', capability)) {
      throw new HttpError(401, 'Dashboard session expired. Open the account dashboard again.');
    }
    touch();
    if (req.method === 'GET' && url.pathname === '/') {
      send(res, 200, html, 'text/html');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/app.css') {
      send(res, 200, css, 'text/css');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      send(res, 200, javascript, 'text/javascript');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, await state());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/accounts') {
      requireMutation(req);
      const body = objectBody(
        await readJson(req, options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS),
      );
      if (body.label !== undefined && typeof body.label !== 'string') {
        throw new HttpError(400, 'Account label must be text.');
      }
      json(res, 201, {
        ...publicAccount(await manager.add(body.label ?? '')),
        login: { state: manager.login ? 'idle' : 'unavailable' },
      });
      return;
    }

    const accountProvider = routeProvider(url.pathname);
    if (req.method === 'PATCH' && accountProvider) {
      requireMutation(req);
      if (!(await hasAccount(manager, accountProvider)))
        throw new HttpError(404, 'Account not found.');
      const body = objectBody(
        await readJson(req, options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS),
      );
      if (typeof body.label !== 'string') {
        throw new HttpError(400, 'Account label must be text.');
      }
      await manager.rename(accountProvider, body.label);
      const renamed = (await manager.snapshot()).accounts.find(
        (account) => account.provider === accountProvider,
      );
      if (!renamed) throw new HttpError(404, 'Account not found.');
      json(res, 200, { label: renamed.label });
      return;
    }
    const activateProvider = routeProvider(url.pathname, '/activate');
    if (req.method === 'POST' && activateProvider) {
      requireMutation(req);
      if (!(await hasAccount(manager, activateProvider)))
        throw new HttpError(404, 'Account not found.');
      await manager.activate(activateProvider);
      json(res, 200, { ok: true });
      return;
    }
    const logoutProvider = routeProvider(url.pathname, '/logout');
    if (req.method === 'POST' && logoutProvider) {
      requireMutation(req);
      if (!(await hasAccount(manager, logoutProvider)))
        throw new HttpError(404, 'Account not found.');
      cancelLogin(logoutProvider);
      await manager.logout(logoutProvider);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'DELETE' && accountProvider) {
      requireMutation(req);
      if (!(await hasAccount(manager, accountProvider)))
        throw new HttpError(404, 'Account not found.');
      cancelLogin(accountProvider, true);
      await manager.remove(accountProvider);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/quotas/refresh') {
      requireMutation(req);
      if (refreshController) throw new HttpError(409, 'A quota refresh is already running.');
      refreshController = new AbortController();
      try {
        json(res, 200, await manager.refresh(refreshController.signal));
      } finally {
        refreshController = undefined;
      }
      return;
    }

    const ticketProvider = routeProvider(url.pathname, '/login-ticket');
    if (req.method === 'POST' && ticketProvider) {
      requireMutation(req);
      if (!manager.login) throw new HttpError(404, 'Browser login is not available.');
      const account = (await manager.snapshot()).accounts.find(
        (candidate) => candidate.provider === ticketProvider,
      );
      if (!account) throw new HttpError(404, 'Account not found.');
      if (account.environment) {
        throw new HttpError(409, 'This account is configured through an environment variable.');
      }
      const ticket = randomBytes(24).toString('base64url');
      for (const [candidate, value] of loginTickets) {
        if (value.expiresAt < Date.now()) loginTickets.delete(candidate);
      }
      loginTickets.set(ticket, {
        provider: ticketProvider,
        expiresAt: Date.now() + LOGIN_TICKET_MS,
      });
      json(res, 201, { path: `/oauth/${ticket}` });
      return;
    }
    const ticket = /^\/oauth\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
    if (req.method === 'GET' && ticket) {
      const loginTicket = loginTickets.get(ticket);
      loginTickets.delete(ticket);
      if (!loginTicket || loginTicket.expiresAt < Date.now()) {
        throw new HttpError(404, 'Login link expired. Start again from the dashboard.');
      }
      await startLogin(loginTicket.provider, res);
      return;
    }
    const codeProvider = routeProvider(url.pathname, '/login-code');
    if (req.method === 'POST' && codeProvider) {
      requireMutation(req);
      const body = objectBody(
        await readJson(req, options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS),
      );
      if (typeof body.code !== 'string' || !body.code.trim()) {
        throw new HttpError(400, 'Authorization code is required.');
      }
      const job = loginJobs.get(codeProvider);
      if (job?.state !== 'pending') throw new HttpError(409, 'No login is waiting for a code.');
      job.resolveManualCode(body.code.trim());
      json(res, 202, { accepted: true });
      return;
    }
    const cancelProvider = routeProvider(url.pathname, '/login-cancel');
    if (req.method === 'POST' && cancelProvider) {
      requireMutation(req);
      const job = loginJobs.get(cancelProvider);
      if (job?.state !== 'pending') throw new HttpError(409, 'No login is running.');
      cancelLogin(cancelProvider);
      json(res, 202, { cancelled: true });
      return;
    }
    throw new HttpError(404, 'Dashboard route not found.');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close();
    throw new Error('Could not determine the dashboard address.');
  }
  expectedHost = `${HOST}:${address.port}`;
  origin = `http://${expectedHost}`;
  server.unref();
  touch();

  return {
    origin,
    bootstrapUrl: `${origin}/bootstrap/${capability}`,
    csrfToken,
    isOpen: () => server.listening,
    close,
  };
}
