import { existsSync, globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

describe('npm package manifest', () => {
  it('declares server and TUI plugin entries', () => {
    expect(packageJson.name).toBe('open-grok-build');
    expect(packageJson.keywords).toContain('opencode-plugin');
    expect(packageJson.main).toBe('./src/opencode/plugin.ts');
    expect(packageJson.exports).toEqual({
      '.': './src/opencode/plugin.ts',
      './tui': './src/opencode/tui.tsx',
    });
    expect(packageJson.dependencies?.['@opencode-ai/plugin']).toBeDefined();
    expect(packageJson.devDependencies?.['@opencode-ai/sdk']).toBeDefined();
    expect(packageJson.peerDependencies?.['@opentui/solid']).toBeDefined();
    expect(packageJson.files).toEqual(['README.md', 'src', 'tsconfig.json']);
  });

  it('runs publish checks before packing', () => {
    expect(packageJson.scripts?.test).toBe('vitest run --reporter=agent');
    expect(packageJson.scripts?.coverage).toBe('vitest run --reporter=agent --coverage');
    expect(packageJson.scripts?.typecheck).toBe('tsc --noEmit');
    expect(packageJson.scripts?.prepack).toBe(
      'bun run test && bun run coverage && bun run typecheck',
    );
    expect(packageJson.scripts?.knip).toBe('knip --production');
    expect(packageJson.devDependencies?.vitest).toBeDefined();
    expect(packageJson.devDependencies?.['@vitest/coverage-v8']).toBeDefined();
    expect(existsSync(new URL('../../vitest.config.ts', import.meta.url))).toBe(true);
  });

  it('declares direct runtime dependencies', () => {
    expect(packageJson.dependencies?.jiti).toBeUndefined();
    expect(packageJson.dependencies?.typebox).toBeUndefined();
  });
});

describe('repository layout', () => {
  it('keeps OpenCode plugin entry at src/opencode/plugin.ts', () => {
    expect(existsSync(new URL('../../src/opencode/plugin.ts', import.meta.url))).toBe(true);
  });

  it('does not ship legacy provider entry or WebSearch shims', () => {
    expect(existsSync(new URL('../../src/provider/register.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../src/tools/webSearch.ts', import.meta.url))).toBe(false);
  });

  it('contains core domain source files', () => {
    const files = globSync('src/**/*.{ts,tsx}').sort();
    for (const required of [
      'src/auth/oauth.ts',
      'src/opencode/billing.ts',
      'src/opencode/plugin.ts',
      'src/opencode/tui.tsx',
      'src/opencode/usage.ts',
      'src/tools/register.ts',
    ]) {
      expect(files).toContain(required);
    }
  });
});
