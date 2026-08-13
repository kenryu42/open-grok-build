import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as oauth from '../../src/auth/oauth.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/config.js';
import { saveQuotaUsage } from '../../src/opencode/quotaCache.js';
import plugin from '../../src/opencode/tui.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  startAccountDashboard: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../src/opencode/dashboard/server.js', () => ({
  startAccountDashboard: mocks.startAccountDashboard,
}));

const useTempHome = useTempOpenCodeHome('open-grok-build-tui-');

function tui(authSet = vi.fn(async () => ({ data: true }))) {
  let commands: { name: string; run(): Promise<void> }[] = [];
  const toast = vi.fn();
  const dispose = vi.fn();
  const api = {
    client: { auth: { set: authSet } },
    command: { register: vi.fn() },
    keymap: {
      registerLayer: vi.fn((layer) => {
        commands = layer.commands;
        return dispose;
      }),
    },
    lifecycle: { onDispose: vi.fn() },
    ui: { dialog: { clear: vi.fn() }, toast },
  };
  return plugin.tui(api as never).then(() => ({ commands, toast }));
}

describe('OpenCode TUI plugin', () => {
  beforeEach(() => {
    useTempHome();
    saveConfig(DEFAULT_CONFIG);
    delete process.env.GROK_BUILD_OAUTH_TOKEN;
    delete process.env.OPENCODE_AUTH_CONTENT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('handles failure to start the system browser', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    mocks.spawn.mockReturnValue(child);
    const close = vi.fn(async () => undefined);
    mocks.startAccountDashboard.mockResolvedValue({
      bootstrapUrl: 'http://127.0.0.1:4000/bootstrap/secret',
      origin: 'http://127.0.0.1:4000',
      close,
      isOpen: () => true,
    });
    const registered = await tui();

    await registered.commands.find((command) => command.name === 'grok-build.accounts')?.run();

    expect(() => child.emit('error', new Error('spawn xdg-open ENOENT'))).not.toThrow();
    await registered.commands.find((command) => command.name === 'grok-build.accounts')?.run();
    expect(() => child.emit('exit', 1)).not.toThrow();
    await registered.commands.find((command) => command.name === 'grok-build.accounts')?.run();
    expect(close).toHaveBeenCalledTimes(2);
    expect(mocks.startAccountDashboard).toHaveBeenCalledTimes(3);
    expect(mocks.spawn.mock.calls[1]?.[1]).toContain('http://127.0.0.1:4000/bootstrap/secret');
    expect(mocks.spawn.mock.calls[2]?.[1]).toContain('http://127.0.0.1:4000/bootstrap/secret');
    expect(registered.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'error',
        message: expect.stringContaining('Could not open'),
      }),
    );
  });

  it('shows cached usage when token refresh fails', async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      'grok-build': {
        type: 'oauth',
        access: 'expired-token',
        refresh: 'refresh-token',
        expires: 1,
      },
    });
    await saveQuotaUsage(
      'grok-build',
      {
        monthly: {
          monthlyLimit: 4000,
          used: 500,
          billingPeriodEnd: '2026-08-01T00:00:00.000Z',
        },
      },
      '2026-07-25T00:00:00.000Z',
    );
    vi.spyOn(oauth, 'refresh').mockRejectedValue(new Error('refresh failed'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    const registered = await tui();

    await registered.commands
      .find((command) => command.name === 'open-grok-build.grok-build-usage')
      ?.run();

    expect(registered.toast).toHaveBeenCalledOnce();
    expect(registered.toast.mock.calls[0]?.[0].message).toContain('billing refresh failed');
    expect(registered.toast.mock.calls[0]?.[0].message).toContain(
      'Cached usage from 2026-07-25T00:00:00.000Z',
    );
  });

  it('keeps rotated credentials when auth persistence fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      'grok-build': {
        type: 'oauth',
        access: 'tui-expired-token',
        refresh: 'tui-environment-refresh',
        expires: 1,
      },
    });
    const refresh = vi
      .spyOn(oauth, 'refresh')
      .mockResolvedValueOnce({
        access: 'tui-fresh-token-1',
        refresh: 'tui-rotated-refresh-1',
        expires: 1_700_000_001_000,
      })
      .mockResolvedValueOnce({
        access: 'tui-fresh-token-2',
        refresh: 'tui-rotated-refresh-2',
        expires: 1_700_000_003_000,
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    const registered = await tui(
      vi.fn(async () => {
        throw new Error('auth persistence failed');
      }),
    );

    await registered.commands
      .find((command) => command.name === 'open-grok-build.grok-build-usage')
      ?.run();
    vi.setSystemTime(1_700_000_002_000);
    await registered.commands
      .find((command) => command.name === 'open-grok-build.grok-build-usage')
      ?.run();

    expect(refresh.mock.calls[1]?.[0].refresh).toBe('tui-rotated-refresh-1');
  });
});
