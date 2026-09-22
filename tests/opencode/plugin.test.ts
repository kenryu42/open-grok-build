import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import plugin from '../../src/opencode/plugin.js';
import { conversationStorageKey } from '../../src/opencode/requests.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';
import {
  applyTransforms,
  CRED_A,
  CRED_B,
  exhaustSession,
  type FakeConnection,
  type FakeContext,
  failRequest,
  rpcErrorContext,
  serveRequest,
  tokenContext,
} from './fakeContext.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-plugin-');
const SESSION = 'ses_1';

async function setup(connections: FakeConnection[] = [CRED_A]) {
  useTempHome();
  const fake = tokenContext(connections);
  const cleanup = await plugin.setup(fake.ctx);
  return { fake, cleanup };
}

function handlers(fake: FakeContext) {
  const registered = fake.rpc.handlers;
  if (!registered) throw new Error('RPC handlers were not registered');
  return registered;
}

describe('Open Grok Build v2 plugin', () => {
  it('identifies itself and registers the provider catalog', async () => {
    const { fake } = await setup();

    expect(plugin.id).toBe('open-grok-build');
    const transforms = applyTransforms(fake);
    const added = transforms.provider.added[0];
    if (!added) throw new Error('no provider registered');
    expect(added.info).toMatchObject({
      id: 'grok-build',
      name: 'Grok Build',
      package: '@opencode/ai/providers/xai',
      settings: { transport: 'http' },
    });
    expect(added.models).toHaveLength(10);
    expect(
      added.models.find((model) => model.id === 'grok-4.7')?.variants.map((v) => v.id),
    ).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('registers the Grok Build integration and its methods', async () => {
    const { fake } = await setup();

    const integration = applyTransforms(fake).integration;

    expect(integration.names.get('grok-build')).toBe('Grok Build');
    expect(integration.methods).toHaveLength(4);
  });

  it('wires the provider-scoped session hooks into account rotation', async () => {
    const { fake } = await setup([CRED_A, CRED_B]);

    expect([...fake.hooks.keys()]).toEqual(['http.request', 'http.response', 'retry']);
    expect(fake.hooks.get('retry')?.options).toEqual({ providerID: 'grok-build' });
    expect((await exhaustSession(fake, SESSION)).decision).toEqual({ retry: true, delay: 0 });
    expect(loadConfig().config.accounts.selected).toBe('credential:cred_b');
  });

  it('answers account RPC calls and reports unknown keys', async () => {
    const { fake } = await setup([CRED_A, CRED_B]);
    const rpc = handlers(fake);

    expect(fake.rpc.definition?.id).toBe('open-grok-build');
    expect(await rpc['accounts.list']({} as never, rpcErrorContext() as never)).toEqual({
      accounts: [
        {
          key: 'credential:cred_a',
          label: 'A',
          selected: true,
          environment: false,
          exhausted: false,
        },
        {
          key: 'credential:cred_b',
          label: 'B',
          selected: false,
          environment: false,
          exhausted: false,
        },
      ],
    });
    expect(
      await rpc['accounts.select'](
        { key: 'credential:cred_b' } as never,
        rpcErrorContext() as never,
      ),
    ).toEqual({ ok: true });
    expect(loadConfig().config.accounts.selected).toBe('credential:cred_b');
    expect(
      await rpc['accounts.select']({ key: 'credential:gone' } as never, rpcErrorContext() as never),
    ).toMatchObject({ type: 'not_found' });
    expect(
      await rpc['usage.report']({ key: 'credential:gone' } as never, rpcErrorContext() as never),
    ).toMatchObject({ type: 'not_found' });
  });

  it('invalidates the account listing and forgets deleted sessions', async () => {
    const { fake } = await setup();
    const rpc = handlers(fake);
    await rpc['accounts.list']({} as never, rpcErrorContext() as never);
    await serveRequest(fake, SESSION);
    await failRequest(fake, SESSION, 502);
    expect(fake.storage.has(conversationStorageKey(SESSION))).toBe(true);

    fake.events.push({
      type: 'credential.switched',
      data: { integrationID: 'grok-build', credentialID: null },
    });
    fake.events.push({ type: 'session.deleted', data: { sessionID: SESSION } });
    await vi.waitFor(() => expect(fake.storage.has(conversationStorageKey(SESSION))).toBe(false));

    await rpc['accounts.list']({} as never, rpcErrorContext() as never);
    expect(fake.calls.integrationGet).toBeGreaterThan(1);
  });

  it('stops listening for events when the plugin is disposed', async () => {
    const { fake, cleanup } = await setup();

    await cleanup?.();

    await vi.waitFor(() => expect(fake.events.state.done).toBe(true));
  });
});
