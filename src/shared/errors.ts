/**
 * Typed error for xAI OAuth failures.
 *
 * Codes allow the login flow and stream handlers to distinguish
 * retryable failures (network) from fatal ones (revoked refresh token).
 */
export class XaiOAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly reloginRequired = false,
  ) {
    super(message);
    this.name = 'XaiOAuthError';
  }
}

const MAX_USER_ERROR_BODY_CHARS = 280;

export function isAuthenticationStatus(status: number): boolean {
  return status === 401;
}

export function redactSensitiveData(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted JWT]')
    .replace(
      /(["']?(?:access_token|refresh_token|id_token|code|state|code_verifier)["']?\s*[:=]\s*["']?)[^&\s"',}]+/gi,
      '$1[redacted]',
    );
}

function truncateUserError(value: string): string {
  const redacted = redactSensitiveData(value.trim());
  if (redacted.length <= MAX_USER_ERROR_BODY_CHARS) return redacted;
  return `${redacted.slice(0, MAX_USER_ERROR_BODY_CHARS)}…`;
}

function structuredErrorMessage(body: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;

  if (payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)) {
    const error = payload.error as Record<string, unknown>;
    if (typeof error.message !== 'string') return undefined;
    const type =
      typeof error.type === 'string'
        ? error.type
        : typeof error.code === 'string'
          ? error.code
          : undefined;
    return truncateUserError(type ? `${type}: ${error.message}` : error.message);
  }

  if (typeof payload.error !== 'string') return undefined;
  const message =
    typeof payload.error_description === 'string' ? payload.error_description : payload.error;
  const type = typeof payload.code === 'string' ? payload.code : payload.error;
  return truncateUserError(type === message ? message : `${type}: ${message}`);
}

export function statusUserMessage(status: number): string {
  if (status === 401) return 'Authentication failed (HTTP 401). Please sign in again.';
  if (status === 403) {
    return 'Grok refused this request (HTTP 403). Check account access or policy restrictions.';
  }
  if (status === 429) return 'Grok is rate limited. Please try again shortly. (HTTP 429).';
  if (status >= 502 && status <= 504) {
    return `Grok is temporarily unavailable. Please try again in a moment. (HTTP ${status}).`;
  }
  if (status >= 520 && status <= 524) {
    return `Connection to Grok timed out or was interrupted. Please try again. (HTTP ${status}).`;
  }
  if (status >= 500) return `Something went wrong on the server (HTTP ${status}).`;
  return `Request failed (HTTP ${status}).`;
}

export function userFacingApiErrorMessage(status: number, body: string): string {
  return structuredErrorMessage(body) ?? statusUserMessage(status);
}

/** Well-known error codes. */
export const XaiErrorCode = {
  /** OIDC discovery failed (network, invalid response). */
  DISCOVERY_FAILED: 'discovery_failed',
  /** Discovery endpoint returned a non-xAI origin. */
  DISCOVERY_INVALID_ORIGIN: 'discovery_invalid_origin',
  /** Authorization was denied or errored in the browser. */
  AUTHORIZATION_FAILED: 'authorization_failed',
  /** CSRF state mismatch between request and callback. */
  STATE_MISMATCH: 'state_mismatch',
  /** Callback did not include an authorization code. */
  CODE_MISSING: 'code_missing',
  /** Token exchange failed (network, invalid response). */
  TOKEN_EXCHANGE_FAILED: 'token_exchange_failed',
  /** Token exchange returned an invalid payload. */
  TOKEN_EXCHANGE_INVALID: 'token_exchange_invalid',
  /** Device authorization is not supported by discovery. */
  DEVICE_AUTHORIZATION_UNAVAILABLE: 'device_authorization_unavailable',
  /** Device authorization failed (network, denied, expired). */
  DEVICE_AUTHORIZATION_FAILED: 'device_authorization_failed',
  /** Device authorization returned an invalid payload. */
  DEVICE_AUTHORIZATION_INVALID: 'device_authorization_invalid',
  /** Refresh token is missing or empty. */
  REFRESH_MISSING: 'refresh_missing',
  /** Token refresh failed (expired, revoked). */
  REFRESH_FAILED: 'refresh_failed',
  /** No credentials stored. */
  AUTH_MISSING: 'auth_missing',
  /** Loopback callback server could not bind. */
  CALLBACK_BIND_FAILED: 'callback_bind_failed',
  /** Loopback callback timed out. */
  CALLBACK_TIMEOUT: 'callback_timeout',
} as const;
