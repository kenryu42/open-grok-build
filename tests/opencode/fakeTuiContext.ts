import type { Plugin } from '@opencode/plugin/tui';
import { vi } from 'vitest';

type KeymapLayer = Parameters<Parameters<Plugin.Context['keymap']['layer']>[0]>[0] extends never
  ? never
  : ReturnType<Parameters<Plugin.Context['keymap']['layer']>[0]>;
type ToastOptions = Parameters<Plugin.Context['ui']['toast']['show']>[0];

export type RpcMethod = 'accounts.list' | 'accounts.select' | 'usage.report' | 'quotas.refresh';

export function fakeTuiContext(
  handlers: Partial<Record<RpcMethod, (input: unknown) => Promise<unknown>>> = {},
) {
  const layers: KeymapLayer[] = [];
  const toasts: ToastOptions[] = [];
  const credential = { activate: vi.fn(), update: vi.fn(), remove: vi.fn() };
  const oauth = { connect: vi.fn(), status: vi.fn(), cancel: vi.fn() };
  const context = {
    options: {},
    location: { directory: process.cwd() },
    app: { version: '2.0.12', channel: 'stable' },
    client: {
      rpc: () => handlers,
      credential,
      integration: { oauth },
    },
    data: { on: () => () => undefined },
    keymap: {
      layer: (build: () => KeymapLayer) => {
        layers.push(build());
      },
    },
    ui: { toast: { show: (options: ToastOptions) => toasts.push(options) } },
  };
  return { context: context as unknown as Plugin.Context, layers, toasts, credential, oauth };
}

export function tuiCommands(layers: KeymapLayer[]) {
  return layers.flatMap((layer) => [...(layer.commands ?? [])]);
}

export function tuiCommand(layers: KeymapLayer[], slashName: string) {
  const command = tuiCommands(layers).find((entry) => entry.slash?.name === slashName);
  if (!command) throw new Error(`Command not registered: ${slashName}`);
  return command;
}
