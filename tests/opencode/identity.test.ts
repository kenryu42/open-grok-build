import { describe, expect, it } from 'vitest';
import {
  GROK_BUILD_VERSION,
  grokBuildIdentityHeaders,
  grokBuildUserAgent,
} from '../../src/opencode/identity.js';

describe('Grok Build client identity', () => {
  it('tracks the current Grok Build protocol version', () => {
    expect(GROK_BUILD_VERSION).toBe('0.2.111');
  });

  it('normalizes Node platform and architecture names', () => {
    expect(grokBuildUserAgent('darwin', 'arm64')).toBe(
      'grok-pager/0.2.111 grok-shell/0.2.111 (macos; aarch64)',
    );
    expect(grokBuildUserAgent('win32', 'x64')).toBe(
      'grok-pager/0.2.111 grok-shell/0.2.111 (windows; x86_64)',
    );
    expect(grokBuildUserAgent('linux', 'riscv64')).toBe(
      'grok-pager/0.2.111 grok-shell/0.2.111 (linux; riscv64)',
    );
  });

  it('returns the required static request headers', () => {
    expect(grokBuildIdentityHeaders()).toEqual({
      'User-Agent': grokBuildUserAgent(),
      'x-grok-client-identifier': 'grok-pager',
      'x-grok-client-version': '0.2.111',
      'x-xai-token-auth': 'xai-grok-cli',
    });
  });
});
