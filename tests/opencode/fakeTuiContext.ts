import type { Plugin } from '@opencode/plugin/tui';
import { vi } from 'vitest';

type KeymapLayer = Parameters<Parameters<Plugin.Context['keymap']['layer']>[0]>[0] extends never
  ? never
  : ReturnType<Parameters<Plugin.Context['keymap']['layer']>[0]>;
type ToastOptions = Parameters<Plugin.Context['ui']['toast']['show']>[0];
type SlotClaim = Parameters<Plugin.Context['ui']['slot']>[0];

export type RpcMethod = 'accounts.list' | 'accounts.select' | 'usage.report' | 'quotas.refresh';

export function fakeTuiContext(
  handlers: Partial<Record<RpcMethod, (input: unknown) => Promise<unknown>>> = {},
) {
  const layers: KeymapLayer[] = [];
  const slots: SlotClaim[] = [];
  const toasts: ToastOptions[] = [];
  // The real keymap reads a Solid context, so a layer registered outside a
  // render throws "Keymap.Provider is missing".
  const rendering = { active: false };
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
        if (!rendering.active) throw new Error('Keymap.Provider is missing');
        layers.push(build());
      },
    },
    ui: {
      toast: { show: (options: ToastOptions) => toasts.push(options) },
      slot: (claim: SlotClaim) => {
        slots.push(claim);
        return () => {
          const index = slots.indexOf(claim);
          if (index >= 0) slots.splice(index, 1);
        };
      },
    },
  };
  const render = () => {
    rendering.active = true;
    for (const claim of [...slots]) claim.render({});
    rendering.active = false;
  };
  return {
    context: context as unknown as Plugin.Context,
    layers,
    slots,
    toasts,
    render,
    credential,
    oauth,
  };
}

export function tuiCommands(layers: KeymapLayer[]) {
  return layers.flatMap((layer) => [...(layer.commands ?? [])]);
}

export function tuiCommand(layers: KeymapLayer[], slashName: string) {
  const command = tuiCommands(layers).find((entry) => entry.slash?.name === slashName);
  if (!command) throw new Error(`Command not registered: ${slashName}`);
  return command;
}
