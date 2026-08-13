import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  getConfigPath,
  getOpenCodeDataDirectory,
  getOpenGrokBuildDirectory,
  getQuotaCachePath,
  writeFileAtomic,
} from '../src/storage.js';
import { useTempOpenCodeHome } from './stateTestHelpers.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-storage-');

describe('Open Grok Build storage', () => {
  it('groups plugin-owned state under OpenCode without creating it on read', () => {
    const home = useTempHome();
    const directory = join(home, '.local', 'share', 'opencode', 'open-grok-build');

    expect(getOpenCodeDataDirectory()).toBe(join(home, '.local', 'share', 'opencode'));
    expect(getOpenGrokBuildDirectory()).toBe(directory);
    expect(getConfigPath()).toBe(join(directory, 'config.json'));
    expect(getQuotaCachePath()).toBe(join(directory, 'quota-cache.json'));
    expect(existsSync(directory)).toBe(false);
  });

  it('respects XDG_DATA_HOME', () => {
    const home = useTempHome();
    vi.stubEnv('XDG_DATA_HOME', join(home, 'data'));

    expect(getOpenCodeDataDirectory()).toBe(join(home, 'data', 'opencode'));
  });

  it('writes private files atomically without leaving temporary files', () => {
    useTempHome();

    writeFileAtomic(getConfigPath(), '{"version":1}\n');

    expect(readFileSync(getConfigPath(), 'utf8')).toBe('{"version":1}\n');
    expect(statSync(getConfigPath()).mode & 0o777).toBe(0o600);
    expect(existsSync(getOpenGrokBuildDirectory())).toBe(true);
  });
});
