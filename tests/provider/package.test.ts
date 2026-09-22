import { existsSync, globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson: {
  exports: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('repository layout', () => {
  it('keeps OpenCode plugin entry at src/opencode/plugin.ts', () => {
    expect(existsSync(new URL('../../src/opencode/plugin.ts', import.meta.url))).toBe(true);
  });

  it('does not ship legacy provider entry, tool shims or v1 runtime modules', () => {
    for (const removed of [
      'src/provider/register.ts',
      'src/tools',
      'src/opencode/runtime.ts',
      'src/opencode/grokModels.ts',
      'src/opencode/version.ts',
      'src/opencode/tui.tsx',
    ]) {
      expect(existsSync(new URL(`../../${removed}`, import.meta.url))).toBe(false);
    }
  });

  it('contains core domain source files', () => {
    const files = globSync('src/**/*.ts').sort();
    for (const required of [
      'src/auth/oauth.ts',
      'src/opencode/billing.ts',
      'src/opencode/plugin.ts',
      'src/opencode/rpc.ts',
      'src/opencode/tui.ts',
      'src/opencode/usage.ts',
    ]) {
      expect(files).toContain(required);
    }
  });

  it('publishes the server, TUI and RPC entries against the v2 plugin API', () => {
    expect(packageJson.exports).toEqual({
      '.': './src/opencode/plugin.ts',
      './tui': './src/opencode/tui.ts',
      './rpc': './src/opencode/rpc.ts',
    });
    expect(packageJson.dependencies['@opencode/plugin']).toMatch(/^\^2\./);
    expect(
      Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }).filter((name) =>
        name.startsWith('@opencode-ai/'),
      ),
    ).toEqual([]);
  });
});
