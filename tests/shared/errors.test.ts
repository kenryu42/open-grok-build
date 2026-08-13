import { describe, expect, it } from 'vitest';
import {
  isAuthenticationStatus,
  redactSensitiveData,
  statusUserMessage,
  userFacingApiErrorMessage,
  XaiErrorCode,
  XaiOAuthError,
} from '../../src/shared/errors.js';

describe('OAuth errors', () => {
  it('keeps machine-readable code and relogin state', () => {
    const error = new XaiOAuthError('Refresh token was revoked', XaiErrorCode.REFRESH_FAILED, true);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('XaiOAuthError');
    expect(error.message).toBe('Refresh token was revoked');
    expect(error.code).toBe('refresh_failed');
    expect(error.reloginRequired).toBe(true);
  });

  it('distinguishes authentication failures from forbidden requests', () => {
    expect(isAuthenticationStatus(401)).toBe(true);
    expect(isAuthenticationStatus(403)).toBe(false);
    expect(statusUserMessage(401)).toContain('sign in again');
    expect(statusUserMessage(403)).toContain('account access or policy restrictions');
  });

  it('surfaces only recognized structured upstream errors', () => {
    expect(
      userFacingApiErrorMessage(
        400,
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'Bad tool input' } }),
      ),
    ).toBe('invalid_request_error: Bad tool input');
    expect(
      userFacingApiErrorMessage(
        400,
        JSON.stringify({ error: 'invalid_grant', error_description: 'Authorization expired' }),
      ),
    ).toBe('invalid_grant: Authorization expired');
    expect(userFacingApiErrorMessage(503, '<html>secret edge trace</html>')).toBe(
      'Grok is temporarily unavailable. Please try again in a moment. (HTTP 503).',
    );
    expect(userFacingApiErrorMessage(400, JSON.stringify({ message: 'unrecognized secret' }))).toBe(
      'Request failed (HTTP 400).',
    );
    expect(userFacingApiErrorMessage(400, 'null')).toBe('Request failed (HTTP 400).');
  });

  it('redacts credentials from recognized error messages', () => {
    expect(
      redactSensitiveData(
        'Bearer secret access_token=access-secret refresh_token:"refresh-secret" eyJabc.def.ghi',
      ),
    ).toBe('Bearer [redacted] access_token=[redacted] refresh_token:"[redacted]" [redacted JWT]');
    expect(
      userFacingApiErrorMessage(
        400,
        JSON.stringify({
          error: {
            message: 'refresh_token=secret-value was rejected',
          },
        }),
      ),
    ).not.toContain('secret-value');
  });
});
