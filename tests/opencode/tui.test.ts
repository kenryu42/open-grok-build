import { describe, expect, it, vi } from 'vitest';
import plugin from '../../src/opencode/tui.js';
import { fakeTuiContext, tuiCommand, tuiCommands } from './fakeTuiContext.js';

function usageHandlers(lines: string[]) {
  return { 'usage.report': () => Promise.resolve({ lines }) };
}

describe('Open Grok Build TUI plugin', () => {
  it('registers the usage and accounts slash commands', async () => {
    const fake = fakeTuiContext();

    const cleanup = await plugin.setup(fake.context);

    expect(plugin.id).toBe('open-grok-build.tui');
    expect(tuiCommands(fake.layers).map((command) => command.slash?.name)).toEqual([
      'grok-build-usage',
      'grok-build-accounts',
    ]);
    expect(tuiCommand(fake.layers, 'grok-build-usage')).toMatchObject({
      id: 'open-grok-build.grok-build-usage',
      title: 'Grok Build usage',
      group: 'Grok Build',
      palette: true,
    });
    await cleanup?.();
  });

  it('shows the usage report in a toast', async () => {
    const fake = fakeTuiContext(usageHandlers(['  Account: Work', '    10%']));

    const cleanup = await plugin.setup(fake.context);
    await tuiCommand(fake.layers, 'grok-build-usage').run();

    expect(fake.toasts).toEqual([
      {
        title: 'Grok Build',
        message: '  Account: Work\n    10%',
        variant: 'info',
        duration: 8_000,
      },
    ]);
    await cleanup?.();
  });

  it('reports a failed usage lookup as an error toast', async () => {
    const fake = fakeTuiContext({
      'usage.report': () => Promise.reject(new Error('no account')),
    });

    const cleanup = await plugin.setup(fake.context);
    await tuiCommand(fake.layers, 'grok-build-usage').run();

    expect(fake.toasts[0]).toMatchObject({ variant: 'error', message: 'no account' });
    await cleanup?.();
  });

  it('closes the dashboard when the browser cannot be opened', async () => {
    vi.stubEnv('PATH', '');
    const fake = fakeTuiContext({
      'accounts.list': () => Promise.resolve({ accounts: [] }),
    });

    const cleanup = await plugin.setup(fake.context);
    await tuiCommand(fake.layers, 'grok-build-accounts').run();
    await vi.waitFor(() => expect(fake.toasts).toHaveLength(1));

    expect(fake.toasts[0]).toMatchObject({
      variant: 'error',
      message: 'Could not open the account dashboard in your browser.',
    });

    await cleanup?.();
    vi.unstubAllEnvs();
  });
});
