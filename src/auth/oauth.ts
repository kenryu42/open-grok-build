/**
 * xAI Grok OAuth 2.0 + PKCE implementation.
 *
 * Uses Web Crypto API (crypto.subtle) for PKCE so the extension is
 * portable across Node versions and potential non-Node runtimes.
 *
 * xAI issuer (auth.x.ai) with Grok Build client_id; API traffic uses
 * cli-chat-proxy.grok.com instead of api.x.ai.
 */

import { createServer } from 'node:http';
import { GROK_BUILD_VERSION } from '../opencode/identity.js';
import {
  redactSensitiveData,
  userFacingApiErrorMessage,
  XaiErrorCode,
  XaiOAuthError,
} from '../shared/errors.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const ISSUER = 'https://auth.x.ai';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = process.env.GROK_BUILD_OAUTH_CLIENT_ID || 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE =
  process.env.GROK_BUILD_OAUTH_SCOPE ||
  'openid profile email offline_access grok-cli:access api:access';
const CALLBACK_HOST = process.env.GROK_BUILD_CALLBACK_HOST || '127.0.0.1';
const CALLBACK_PORT = Number.parseInt(process.env.GROK_BUILD_CALLBACK_PORT || '56122', 10);
const CALLBACK_PATH = '/callback';
const MANUAL_AUTHORIZATION_CODE = /^[\x20-\x7E]{1,2048}$/;
/** Refresh 120s before actual expiry — same strategy as pi-grok-cli. */
const REFRESH_SKEW_MS = 120_000;
const TOKEN_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.GROK_BUILD_TOKEN_TIMEOUT_MS || '30000',
  10,
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface XaiDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
}

export interface XaiOAuthCredentials {
  [key: string]: unknown;
  refresh: string;
  access: string;
  expires: number;
  tokenEndpoint?: string;
  discovery?: XaiDiscovery;
  idToken?: string;
  tokenType?: string;
  baseUrl?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getBaseUrl(): string {
  return (process.env.GROK_BUILD_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function base64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

async function generatePKCE(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(hash) };
}

// ─── Endpoint validation ──────────────────────────────────────────────────────

function validateEndpoint(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new XaiOAuthError(
      `xAI OAuth discovery returned invalid ${field}: ${value}`,
      XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
    );
  }
  if (url.protocol !== 'https:') {
    throw new XaiOAuthError(
      `xAI OAuth ${field} must use HTTPS: ${value}`,
      XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
    );
  }
  const host = url.hostname.toLowerCase();
  if (
    host !== 'x.ai' &&
    host !== 'auth.x.ai' &&
    host !== 'accounts.x.ai' &&
    !host.endsWith('.x.ai')
  ) {
    throw new XaiOAuthError(
      `Refusing non-xAI OAuth ${field}: ${value}`,
      XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
    );
  }
  return url.toString();
}

// ─── OIDC Discovery ──────────────────────────────────────────────────────────

async function discover(): Promise<XaiDiscovery> {
  let response: Response;
  try {
    response = await fetch(DISCOVERY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI OIDC discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      XaiErrorCode.DISCOVERY_FAILED,
    );
  }
  if (!response.ok) {
    throw new XaiOAuthError(
      `xAI OIDC discovery returned ${response.status}`,
      XaiErrorCode.DISCOVERY_FAILED,
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI OIDC discovery returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      XaiErrorCode.DISCOVERY_FAILED,
    );
  }
  const authorizationEndpoint = validateEndpoint(
    String(payload.authorization_endpoint ?? ''),
    'authorization_endpoint',
  );
  const tokenEndpoint = validateEndpoint(String(payload.token_endpoint ?? ''), 'token_endpoint');
  const deviceAuthorizationEndpoint = payload.device_authorization_endpoint
    ? validateEndpoint(
        String(payload.device_authorization_endpoint),
        'device_authorization_endpoint',
      )
    : undefined;
  return {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    ...(deviceAuthorizationEndpoint
      ? { device_authorization_endpoint: deviceAuthorizationEndpoint }
      : {}),
  };
}

// ─── Loopback callback server ────────────────────────────────────────────────

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

function parseCallbackParams(params: URLSearchParams, expectedState: string) {
  const state = params.get('state') ?? undefined;
  if (!state) return { error: 'OAuth state is missing.' };
  if (state !== expectedState) return { error: 'OAuth state did not match.' };

  const result: CallbackResult = {
    code: params.get('code') ?? undefined,
    state,
    error: params.get('error') ?? undefined,
    errorDescription: params.get('error_description') ?? undefined,
  };
  if (!result.code && !result.error) {
    return { error: 'Callback did not include an authorization code or OAuth error.' };
  }
  return { result };
}

function parseManualCallback(input: string, expectedState: string) {
  const value = input.trim();
  if (!value) return { error: 'Pasted callback was empty.' };
  try {
    const url = new URL(value);
    if (url.pathname !== CALLBACK_PATH) return { error: 'Callback URL path was not recognized.' };
    return parseCallbackParams(url.searchParams, expectedState);
  } catch {
    const params = new URLSearchParams(value.replace(/^\?/, ''));
    const callbackQuery = ['code', 'state', 'error', 'error_description'].some((key) =>
      params.has(key),
    );
    if (!callbackQuery && MANUAL_AUTHORIZATION_CODE.test(value)) {
      return { result: { code: value } };
    }
    return parseCallbackParams(params, expectedState);
  }
}

function closeCallbackServer(server: import('node:http').Server) {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function startCallbackServer(expectedState: string): Promise<{
  server: import('node:http').Server;
  redirectUri: string;
  acceptManualCallback: (input: string) => string | undefined;
  cancel: () => void;
  waitForCallback: (timeoutMs: number) => Promise<CallbackResult>;
}> {
  let settle: ((value: CallbackResult) => void) | undefined;
  let settled = false;
  const callbackPromise = new Promise<CallbackResult>((resolve) => {
    settle = resolve;
  });
  const accept = (result: CallbackResult) => {
    if (settled) return;
    settled = true;
    settle?.(result);
  };

  const server = createServer((req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin === 'https://accounts.x.ai' || origin === 'https://auth.x.ai') {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://${CALLBACK_HOST}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const parsed = parseCallbackParams(url.searchParams, expectedState);
      if (!parsed.result) {
        res.statusCode = 400;
        res.end('Invalid OAuth callback');
        return;
      }

      res.statusCode = parsed.result.error ? 400 : 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const html = parsed.result.error
        ? '<html><body><h1>xAI authorization failed.</h1>You can close this tab.</body></html>'
        : '<html><body><h1>xAI authorization received.</h1>You can close this tab.</body></html>';
      res.end(html, () => accept(parsed.result));
    } catch {
      res.statusCode = 500;
      res.end('Internal error');
    }
  });

  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, CALLBACK_HOST, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });

  return (async () => {
    let actualPort: number;
    try {
      actualPort = await listen(CALLBACK_PORT);
    } catch (firstError) {
      try {
        actualPort = await listen(0);
      } catch (secondError) {
        const errorDescription = `Could not bind xAI OAuth callback server on ${CALLBACK_HOST}:${CALLBACK_PORT} or an ephemeral port: ${secondError instanceof Error ? secondError.message : String(secondError)} (initial error: ${firstError instanceof Error ? firstError.message : String(firstError)})`;
        return {
          server,
          redirectUri: `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`,
          acceptManualCallback: () => 'The local callback server could not start.',
          cancel: () => {},
          waitForCallback: async () => ({
            error: XaiErrorCode.CALLBACK_BIND_FAILED,
            errorDescription,
          }),
        };
      }
    }
    const redirectUri = `http://${CALLBACK_HOST}:${actualPort}${CALLBACK_PATH}`;
    return {
      server,
      redirectUri,
      cancel: () =>
        accept({
          error: XaiErrorCode.AUTHORIZATION_FAILED,
          errorDescription: 'OAuth login cancelled.',
        }),
      acceptManualCallback: (input: string) => {
        if (settled) return undefined;
        const parsed = parseManualCallback(input, expectedState);
        if (!parsed.result) return parsed.error;
        accept(parsed.result);
        return undefined;
      },
      waitForCallback: (timeoutMs: number) => {
        const timeout = setTimeout(
          () =>
            accept({
              error: XaiErrorCode.CALLBACK_TIMEOUT,
              errorDescription: 'Timed out waiting for xAI OAuth callback.',
            }),
          timeoutMs,
        );
        return callbackPromise.finally(() => clearTimeout(timeout));
      },
    };
  })();
}

// ─── Token exchange ───────────────────────────────────────────────────────────

async function fetchTokenResponse(
  tokenEndpoint: string,
  body: URLSearchParams,
  errorCode: string,
  label: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'x-grok-client-version': GROK_BUILD_VERSION,
        ...headers,
      },
      body,
      signal: controller.signal,
    });
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI ${label} failed: ${redactSensitiveData(
        cause instanceof Error ? cause.message : String(cause),
      )}`,
      errorCode,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function tokenResponseText(response: Response) {
  try {
    return await response.text();
  } catch (cause) {
    return `unable to read response body: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

async function tokenResponseJson(
  response: Response,
  errorCode: string,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI ${label} returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      errorCode,
    );
  }
}

async function tokenResponsePayload(response: Response): Promise<Record<string, unknown>> {
  const text = await tokenResponseText(response);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: `HTTP ${response.status}` };
  }
}

function oauthErrorCode(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const payload = value as Record<string, unknown>;
    return typeof payload.error === 'string' ? payload.error : undefined;
  } catch {
    return undefined;
  }
}

async function tokenErrorDetails(response: Response) {
  const body = await tokenResponseText(response);
  return {
    code: oauthErrorCode(body),
    message: userFacingApiErrorMessage(response.status, body),
  };
}

function credentialsFromLoginPayload(
  payload: Record<string, unknown>,
  tokenEndpoint: string,
  invalidCode: string,
  label: string,
): XaiOAuthCredentials {
  const access = String(payload.access_token ?? '');
  const refresh = String(payload.refresh_token ?? '');
  if (!access) {
    throw new XaiOAuthError(`xAI ${label} did not return access_token.`, invalidCode);
  }
  if (!refresh) {
    throw new XaiOAuthError(`xAI ${label} did not return refresh_token.`, invalidCode);
  }
  const expiresIn =
    typeof payload.expires_in === 'number'
      ? payload.expires_in
      : Number(payload.expires_in ?? 3600);
  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
    tokenEndpoint,
    discovery: { authorization_endpoint: '', token_endpoint: tokenEndpoint },
    idToken: String(payload.id_token ?? ''),
    tokenType: String(payload.token_type ?? 'Bearer'),
    baseUrl: getBaseUrl(),
  };
}

async function exchangeCode(
  tokenEndpoint: string,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<XaiOAuthCredentials> {
  const response = await fetchTokenResponse(
    tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    XaiErrorCode.TOKEN_EXCHANGE_FAILED,
    'token exchange',
  );
  if (!response.ok) {
    const error = await tokenErrorDetails(response);
    throw new XaiOAuthError(
      `xAI token exchange failed: ${error.message}`,
      XaiErrorCode.TOKEN_EXCHANGE_FAILED,
    );
  }
  return credentialsFromLoginPayload(
    await tokenResponseJson(response, XaiErrorCode.TOKEN_EXCHANGE_FAILED, 'token exchange'),
    tokenEndpoint,
    XaiErrorCode.TOKEN_EXCHANGE_INVALID,
    'token exchange',
  );
}

// ─── Device authorization ───────────────────────────────────────────────────

async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function readPositiveNumber(value: unknown, fallback: number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new XaiOAuthError(
      `xAI device authorization returned invalid ${field}.`,
      XaiErrorCode.DEVICE_AUTHORIZATION_INVALID,
    );
  }
  return parsed;
}

async function requestDeviceCode(deviceAuthorizationEndpoint: string) {
  const response = await fetchTokenResponse(
    deviceAuthorizationEndpoint,
    new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
      referrer: 'open-grok-build',
    }),
    XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
    'device authorization',
    { 'x-grok-client-surface': 'ui' },
  );
  if (!response.ok) {
    const error = await tokenErrorDetails(response);
    throw new XaiOAuthError(
      `xAI device authorization failed: ${error.message}`,
      XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
    );
  }
  const payload = await tokenResponseJson(
    response,
    XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
    'device authorization',
  );
  const deviceCode = String(payload.device_code ?? '');
  const userCode = String(payload.user_code ?? '');
  const verificationUri = String(
    payload.verification_uri_complete ?? payload.verification_uri ?? '',
  );
  const verificationUriDisplay = String(payload.verification_uri ?? verificationUri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new XaiOAuthError(
      'xAI device authorization did not return device_code, user_code, and verification_uri.',
      XaiErrorCode.DEVICE_AUTHORIZATION_INVALID,
    );
  }
  return {
    deviceCode,
    userCode,
    verificationUri: validateEndpoint(verificationUri, 'verification_uri'),
    verificationUriDisplay: validateEndpoint(verificationUriDisplay, 'verification_uri'),
    intervalSeconds: readPositiveNumber(payload.interval, 5, 'interval'),
    expiresInSeconds: readPositiveNumber(payload.expires_in, 1800, 'expires_in'),
  };
}

async function pollDeviceCodeToken(
  discovery: XaiDiscovery,
  device: {
    deviceCode: string;
    intervalSeconds: number;
    expiresInSeconds: number;
  },
): Promise<XaiOAuthCredentials> {
  const deadline = Date.now() + device.expiresInSeconds * 1000;
  const poll = async (intervalSeconds: number): Promise<XaiOAuthCredentials> => {
    if (Date.now() >= deadline) {
      throw new XaiOAuthError(
        'Timed out waiting for xAI device authorization.',
        XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      );
    }
    await sleep(intervalSeconds * 1000);
    const response = await fetchTokenResponse(
      discovery.token_endpoint,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CLIENT_ID,
        device_code: device.deviceCode,
      }),
      XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      'device token exchange',
      { 'x-grok-client-surface': 'ui' },
    );
    if (response.ok) {
      const credentials = credentialsFromLoginPayload(
        await tokenResponseJson(
          response,
          XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
          'device token exchange',
        ),
        discovery.token_endpoint,
        XaiErrorCode.DEVICE_AUTHORIZATION_INVALID,
        'device token exchange',
      );
      credentials.discovery = discovery;
      return credentials;
    }

    const payload = await tokenResponsePayload(response);
    if (payload.error === 'authorization_pending') return poll(intervalSeconds);
    if (payload.error === 'slow_down') return poll(intervalSeconds + 5);
    throw new XaiOAuthError(
      `xAI device authorization failed: ${userFacingApiErrorMessage(
        response.status,
        JSON.stringify(payload),
      )}`,
      XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      payload.error === 'access_denied' || payload.error === 'expired_token',
    );
  };

  return poll(Math.max(1, device.intervalSeconds));
}

export type OAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
};

export type OAuthLoginCallbacks = {
  onAuth: (payload: { url: string; instructions: string }) => void;
  onError?: (error: unknown) => void;
  onSuccess?: () => void;
};

export type GrokBuildOAuthSession = {
  url: string;
  instructions: string;
  submitManual?: (input: string) => string | undefined;
  cancel?: () => void;
  finish: (manualCallback?: string) => Promise<OAuthCredentials>;
};

/** Start loopback OAuth; call `finish` after the user completes the browser step. */
export async function beginGrokBuildOAuth(
  referrer = 'open-grok-build',
): Promise<GrokBuildOAuthSession> {
  const discovery = await discover();
  const { verifier, challenge } = await generatePKCE();
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const callback = await startCallbackServer(state);

  const authUrl = new URL(discovery.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', callback.redirectUri);
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('plan', 'generic');
  authUrl.searchParams.set('referrer', referrer);

  return {
    url: authUrl.toString(),
    instructions: `Authorize xAI for Grok Build, then return to OpenCode. Callback: ${callback.redirectUri}. For manual login, paste the callback URL or one-time code.`,
    submitManual: callback.acceptManualCallback,
    cancel: callback.cancel,
    finish: async (manualCallback) => {
      try {
        if (manualCallback) {
          const error = callback.acceptManualCallback(manualCallback);
          if (error) {
            throw new XaiOAuthError(error, XaiErrorCode.AUTHORIZATION_FAILED);
          }
        }
        const result = await callback.waitForCallback(180_000);

        if (result.error) {
          const code =
            result.error === XaiErrorCode.CALLBACK_BIND_FAILED ||
            result.error === XaiErrorCode.CALLBACK_TIMEOUT
              ? result.error
              : XaiErrorCode.AUTHORIZATION_FAILED;
          throw new XaiOAuthError(
            redactSensitiveData(result.errorDescription ?? result.error),
            code,
          );
        }
        if (result.state !== undefined && result.state !== state) {
          throw new XaiOAuthError(
            'xAI OAuth state mismatch — possible CSRF.',
            XaiErrorCode.STATE_MISMATCH,
          );
        }
        if (!result.code) {
          throw new XaiOAuthError(
            'xAI OAuth callback did not include an authorization code.',
            XaiErrorCode.CODE_MISSING,
          );
        }

        const credentials = await exchangeCode(
          discovery.token_endpoint,
          result.code,
          callback.redirectUri,
          verifier,
        );
        credentials.discovery = discovery;
        return credentials;
      } finally {
        await closeCallbackServer(callback.server);
      }
    },
  };
}

/** Start RFC 8628 device OAuth; call `finish` to poll until the user authorizes. */
export async function beginGrokBuildDeviceOAuth(): Promise<GrokBuildOAuthSession> {
  const discovery = await discover();
  if (!discovery.device_authorization_endpoint) {
    throw new XaiOAuthError(
      'xAI OIDC discovery did not include a device authorization endpoint.',
      XaiErrorCode.DEVICE_AUTHORIZATION_UNAVAILABLE,
    );
  }
  const device = await requestDeviceCode(discovery.device_authorization_endpoint);
  return {
    url: device.verificationUri,
    instructions: `Open ${device.verificationUriDisplay} on any device and enter code: ${device.userCode}`,
    finish: () => pollDeviceCodeToken(discovery, device),
  };
}

// ─── Programmatic login (browser OAuth) ─────────────────────────────────────

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const session = await beginGrokBuildOAuth('open-grok-build');
  callbacks.onAuth({ url: session.url, instructions: session.instructions });
  return session.finish();
}

// ─── Token refresh ────────────────────────────────────────────────────────────

export async function refresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const xai = credentials as XaiOAuthCredentials;
  const tokenEndpoint =
    xai.tokenEndpoint || xai.discovery?.token_endpoint || (await discover()).token_endpoint;
  validateEndpoint(tokenEndpoint, 'token_endpoint');

  if (!credentials.refresh) {
    throw new XaiOAuthError(
      'Missing refresh_token. Re-login required.',
      XaiErrorCode.REFRESH_MISSING,
      true,
    );
  }

  const response = await fetchTokenResponse(
    tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: credentials.refresh,
    }),
    XaiErrorCode.REFRESH_FAILED,
    'token refresh',
  );

  if (!response.ok) {
    const error = await tokenErrorDetails(response);
    throw new XaiOAuthError(
      `xAI token refresh failed: ${error.message}`,
      XaiErrorCode.REFRESH_FAILED,
      error.code === 'invalid_grant',
    );
  }

  const payload = await tokenResponseJson(response, XaiErrorCode.REFRESH_FAILED, 'token refresh');
  const access = String(payload.access_token ?? '');
  if (!access) {
    throw new XaiOAuthError(
      'xAI token refresh did not return access_token.',
      XaiErrorCode.REFRESH_FAILED,
      true,
    );
  }

  const refresh_new = String(payload.refresh_token ?? credentials.refresh);
  const expiresIn =
    typeof payload.expires_in === 'number'
      ? payload.expires_in
      : Number(payload.expires_in ?? 3600);

  return {
    ...xai,
    access,
    refresh: refresh_new,
    expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
    tokenEndpoint,
    idToken: String(payload.id_token ?? xai.idToken ?? ''),
    tokenType: String(payload.token_type ?? xai.tokenType ?? 'Bearer'),
    baseUrl: getBaseUrl(),
  };
}
