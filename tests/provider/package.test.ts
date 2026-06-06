import { existsSync, globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('repository layout', () => {
  it('keeps OpenCode plugin entry at src/opencode/plugin.ts', () => {
    expect(existsSync(new URL('../../src/opencode/plugin.ts', import.meta.url))).toBe(true);
  });

  it('does not ship legacy provider entry or custom tool shims', () => {
    expect(existsSync(new URL('../../src/provider/register.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../src/tools', import.meta.url))).toBe(false);
  });

  it('contains core domain source files', () => {
    const files = globSync('src/**/*.{ts,tsx}').sort();
    for (const required of [
      'src/auth/oauth.ts',
      'src/opencode/billing.ts',
      'src/opencode/plugin.ts',
      'src/opencode/tui.tsx',
      'src/opencode/usage.ts',
    ]) {
      expect(files).toContain(required);
    }
  });
});
