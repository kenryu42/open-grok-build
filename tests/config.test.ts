import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  getConfigPath,
  loadConfig,
  saveConfig,
  updateConfig,
} from '../src/config.js';
import { runBun, useTempOpenCodeHome } from './stateTestHelpers.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-config-');

function writeConfig(value: unknown) {
  mkdirSync(dirname(getConfigPath()), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(value));
}

describe('Open Grok Build configuration', () => {
  it('uses isolated defaults without creating a file', () => {
    useTempHome();

    loadConfig().config.imagine.enabled = false;

    expect(loadConfig()).toEqual({ config: DEFAULT_CONFIG });
    expect(DEFAULT_CONFIG.imagine.enabled).toBe(true);
    expect(existsSync(getConfigPath())).toBe(false);
  });

  it('atomically stores normalized private configuration', () => {
    useTempHome();
    saveConfig({ ...DEFAULT_CONFIG, accounts: { selected: 'credential:cred_1' } });

    expect(loadConfig().config).toEqual({
      version: 2,
      accounts: { selected: 'credential:cred_1' },
      imagine: { enabled: true },
    });
    expect(statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it('ignores invalid selected keys and imagine values with a warning', () => {
    useTempHome();
    writeConfig({ version: 2, accounts: { selected: 'bad\nkey' }, imagine: { enabled: 'yes' } });

    const loaded = loadConfig();

    expect(loaded.config.accounts).toEqual({});
    expect(loaded.config.imagine).toEqual({ enabled: true });
    expect(loaded.warning).toContain('accounts.selected');
    expect(loaded.warning).toContain('imagine.enabled must be true or false');
  });

  it.each([true, false])('persists the imagine toggle set to %s', (enabled) => {
    useTempHome();
    saveConfig({ ...DEFAULT_CONFIG, imagine: { enabled } });

    expect(loadConfig().config.imagine).toEqual({ enabled });
  });

  it('resets a version 1 config file to defaults with a warning', () => {
    useTempHome();
    writeConfig({
      version: 1,
      accounts: { items: [{ provider: 'grok-build', label: 'Personal' }] },
    });

    const loaded = loadConfig();

    expect(loaded.warning).toContain('v1');
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toEqual(DEFAULT_CONFIG);
    expect(loadConfig().warning).toBeUndefined();
  });

  it('does not overwrite unsupported future configuration', () => {
    useTempHome();
    writeConfig({ version: 3 });

    expect(loadConfig().warning).toContain('Unsupported config version 3');
    expect(() => updateConfig((config) => config)).toThrow('Unsupported config version 3');
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toEqual({ version: 3 });
  });

  it('retries when a released config lock disappears before inspection', async () => {
    const home = useTempHome();
    saveConfig(DEFAULT_CONFIG);
    const lockPath = `${getConfigPath()}.lock`;
    symlinkSync(`${home}/missing-lock-target`, lockPath);
    const release = spawn(
      'bun',
      [
        '-e',
        `setTimeout(() => require('node:fs').rmSync(${JSON.stringify(lockPath)}, { force: true }), 20)`,
      ],
      { stdio: 'ignore' },
    );

    expect(() =>
      updateConfig((config) => ({ ...config, accounts: { selected: 'credential:x' } })),
    ).not.toThrow();
    await new Promise<void>((resolve) => release.once('close', () => resolve()));
  });

  it('serializes configuration updates from separate processes', async () => {
    const home = useTempHome();
    saveConfig(DEFAULT_CONFIG);
    const ready = `${home}/first-ready`;
    const secondReady = `${home}/second-ready`;
    const release = `${home}/release-first`;
    const environment = { HOME: home, XDG_DATA_HOME: '' };
    const first = runBun(
      `
      import { existsSync, writeFileSync } from 'node:fs';
      import { updateConfig } from './src/config.ts';
      updateConfig((config) => {
        writeFileSync(${JSON.stringify(ready)}, '');
        while (!existsSync(${JSON.stringify(release)})) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        config.imagine.enabled = false;
        return config;
      });
    `,
      environment,
    );
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    const second = runBun(
      `
      import { writeFileSync } from 'node:fs';
      import { updateConfig } from './src/config.ts';
      writeFileSync(${JSON.stringify(secondReady)}, '');
      updateConfig((config) => {
        config.accounts.selected = 'credential:second';
        return config;
      });
    `,
      environment,
    );
    await vi.waitFor(() => expect(existsSync(secondReady)).toBe(true));
    writeFileSync(release, '');

    await Promise.all([first, second]);

    expect(loadConfig().config).toEqual({
      version: 2,
      accounts: { selected: 'credential:second' },
      imagine: { enabled: false },
    });
  });
});
