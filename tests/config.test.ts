import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  findAvailableAccountNumber,
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

    const first = loadConfig();
    const account = first.config.accounts.items[0];
    if (!account) throw new Error('missing default account');
    account.label = 'changed';

    expect(loadConfig()).toEqual({ config: DEFAULT_CONFIG });
    expect(existsSync(getConfigPath())).toBe(false);
  });

  it('atomically stores normalized private configuration', () => {
    useTempHome();
    saveConfig({
      ...DEFAULT_CONFIG,
      accounts: {
        ...DEFAULT_CONFIG.accounts,
        items: [{ provider: 'grok-build', label: 'Personal' }],
      },
    });

    expect(loadConfig().config).toMatchObject({
      version: 1,
      accounts: { items: [{ provider: 'grok-build', label: 'Personal' }] },
    });
    expect(statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it('normalizes account aliases, labels, selection, and the next reusable number', () => {
    useTempHome();
    writeConfig({
      ...DEFAULT_CONFIG,
      accounts: {
        selectedProvider: 'missing',
        items: [
          { provider: 'grok-build', label: ' Personal ' },
          { provider: 'grok-build-2', label: 'Work' },
          { provider: 'grok-build-2', label: 'Duplicate provider' },
          { provider: 'grok-build-3', label: 'work' },
          { provider: 'grok-build-10', label: 'Account 10' },
          { provider: 'xai', label: 'Other' },
          { provider: 'grok-build-4', label: 'bad\nlabel' },
        ],
      },
    });

    const loaded = loadConfig();

    expect(loaded.config.accounts).toEqual({
      nextAccountNumber: 3,
      selectedProvider: 'grok-build',
      items: [
        { provider: 'grok-build', label: 'Personal' },
        { provider: 'grok-build-2', label: 'Work' },
        { provider: 'grok-build-10', label: 'Account 10' },
      ],
    });
    expect(loaded.warning).toContain('accounts');
  });

  it('reserves the base account label when base metadata is absent', () => {
    useTempHome();
    writeConfig({
      ...DEFAULT_CONFIG,
      accounts: {
        selectedProvider: 'grok-build-2',
        items: [
          { provider: 'grok-build-2', label: 'Account 1' },
          { provider: 'grok-build-3', label: 'Work' },
        ],
      },
    });

    expect(loadConfig().config.accounts).toEqual({
      nextAccountNumber: 2,
      selectedProvider: 'grok-build',
      items: [
        { provider: 'grok-build', label: 'Account 1' },
        { provider: 'grok-build-3', label: 'Work' },
      ],
    });
  });

  it('does not overwrite malformed or unsupported configuration', () => {
    useTempHome();
    writeConfig({ version: 2 });

    expect(loadConfig().warning).toContain('Unsupported config version 2');
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toEqual({ version: 2 });
  });

  it('rejects updates to unsupported configuration without overwriting it', () => {
    useTempHome();
    writeConfig({ version: 2, accounts: { items: [{ provider: 'future', label: 'Future' }] } });

    expect(() => updateConfig((config) => config)).toThrow('Unsupported config version 2');
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toEqual({
      version: 2,
      accounts: { items: [{ provider: 'future', label: 'Future' }] },
    });
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
      updateConfig((config) => ({
        ...config,
        accounts: { ...config.accounts, selectedProvider: 'grok-build' },
      })),
    ).not.toThrow();
    await new Promise<void>((resolve) => release.once('close', () => resolve()));
  });

  it('reuses the lowest free numbered alias', () => {
    expect(findAvailableAccountNumber(['grok-build', 'grok-build-3'])).toBe(2);
    expect(
      findAvailableAccountNumber(['grok-build', 'grok-build-2'], ['grok-build-3', 'grok-build-4']),
    ).toBe(5);
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
        config.accounts.items[0].label = 'Updated primary';
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
        config.accounts.items.push({ provider: 'grok-build-2', label: 'Work' });
        return config;
      });
    `,
      environment,
    );
    await vi.waitFor(() => expect(existsSync(secondReady)).toBe(true));
    writeFileSync(release, '');

    await Promise.all([first, second]);

    expect(loadConfig().config.accounts.items).toEqual([
      { provider: 'grok-build', label: 'Updated primary' },
      { provider: 'grok-build-2', label: 'Work' },
    ]);
  });
});
