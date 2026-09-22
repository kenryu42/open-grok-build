import type { Model, Plugin, Provider } from '@opencode/plugin';
import { vi } from 'vitest';

export type FakeConnection =
  | { type: 'credential'; id: string; label: string }
  | { type: 'env'; name: string };

export type FakeCredential =
  | { type: 'oauth'; access: string; refresh: string; expires: number; methodID: string }
  | { type: 'key'; key: string };

export interface FakeContextOptions {
  connections?: FakeConnection[];
  active?: FakeConnection;
  credentials?: Record<string, FakeCredential>;
  environmentToken?: string;
  directory?: string;
}

export type IntegrationEditor = Parameters<
  Parameters<Plugin.Context['integration']['transform']>[0]
>[0];
export type MethodRegistration = Parameters<IntegrationEditor['method']['update']>[0];

type Callback = (editor: never) => void;
type Hook = { callback: (event: never) => Promise<void> | void; options?: { providerID?: string } };
type RpcHandler = (input: never, context: never) => Promise<unknown>;

export interface RpcRecording {
  definition?: { id: string; methods: Record<string, unknown> };
  handlers?: Record<string, RpcHandler>;
}

export function rpcErrorContext() {
  return {
    signal: AbortSignal.timeout(10_000),
    error: (type: string, message: string, data?: unknown) => ({ type, message, data }),
  };
}

function eventStream() {
  const queue: object[] = [];
  const state: { notify?: () => void; done: boolean; returned: boolean } = {
    done: false,
    returned: false,
  };
  const wake = () => {
    const notify = state.notify;
    state.notify = undefined;
    notify?.();
  };
  const take = (): Promise<IteratorResult<object, undefined>> => {
    const value = queue.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (state.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise<void>((resolve) => {
      state.notify = resolve;
    }).then(take);
  };
  const close = () => {
    state.done = true;
    wake();
  };
  return {
    state,
    close,
    push(event: object) {
      queue.push(event);
      wake();
    },
    iterable: {
      [Symbol.asyncIterator]: (): AsyncIterator<object, undefined> => ({
        next: take,
        return: () => {
          state.returned = true;
          close();
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    },
  };
}

export function fakeContext(options: FakeContextOptions = {}) {
  const connections = options.connections ?? [];
  const credentials = options.credentials ?? {};
  const directory = options.directory ?? process.cwd();
  const transforms = {
    provider: [] as Callback[],
    integration: [] as Callback[],
    tool: [] as Callback[],
    command: [] as Callback[],
  };
  const reloads = { tool: 0, command: 0 };
  const hooks = new Map<string, Hook>();
  const storage = new Map<string, unknown>();
  const calls = { integrationGet: 0, resolve: [] as FakeConnection[] };
  const rpc: RpcRecording = {};
  const events = eventStream();
  const synthetic = vi.fn((_input: { sessionID: string; text: string }) =>
    Promise.resolve(undefined),
  );
  const registration = { dispose: () => Promise.resolve(undefined) };
  const record = (list: Callback[]) => (callback: Callback) => {
    list.push(callback);
    return Promise.resolve(registration);
  };
  const ctx = {
    app: { name: 'opencode', version: '2.0.12', channel: 'stable' },
    location: { directory },
    options: {},
    provider: { transform: record(transforms.provider) },
    integration: {
      transform: record(transforms.integration),
      get: () => {
        calls.integrationGet += 1;
        return Promise.resolve({
          location: { directory },
          data: { id: 'grok-build', name: 'Grok Build', methods: [], connections },
        });
      },
      connection: {
        active: () => Promise.resolve(options.active ?? connections[0]),
        resolve: (connection: FakeConnection) => {
          calls.resolve.push(connection);
          if (connection.type === 'env') {
            return Promise.resolve(
              options.environmentToken ? { type: 'key', key: options.environmentToken } : undefined,
            );
          }
          return Promise.resolve(credentials[connection.id]);
        },
      },
    },
    tool: {
      transform: record(transforms.tool),
      reload: () => {
        reloads.tool += 1;
        return Promise.resolve(undefined);
      },
      list: () => Promise.resolve([]),
    },
    command: {
      transform: record(transforms.command),
      reload: () => {
        reloads.command += 1;
        return Promise.resolve(undefined);
      },
    },
    session: {
      hook: (name: string, callback: Hook['callback'], hookOptions?: { providerID?: string }) => {
        hooks.set(name, { callback, options: hookOptions });
        return Promise.resolve(registration);
      },
      synthetic,
    },
    event: {
      subscribe: (subscribeOptions?: { signal?: AbortSignal }) => {
        subscribeOptions?.signal?.addEventListener('abort', events.close);
        return events.iterable;
      },
    },
    storage: {
      get: (key: string) => Promise.resolve(storage.get(key)),
      set: (key: string, value: unknown) => {
        storage.set(key, value);
        return Promise.resolve(undefined);
      },
      remove: (key: string) => {
        storage.delete(key);
        return Promise.resolve(undefined);
      },
    },
    rpc: {
      register: (
        definition: NonNullable<RpcRecording['definition']>,
        handlers: Record<string, RpcHandler>,
      ) => {
        rpc.definition = definition;
        rpc.handlers = handlers;
        return Promise.resolve({ ...registration, events: { emit: () => Promise.resolve() } });
      },
    },
  };
  return {
    ctx: ctx as unknown as Plugin.Context,
    transforms,
    hooks,
    storage,
    events,
    calls,
    rpc,
    reloads,
    synthetic,
  };
}

export type FakeContext = ReturnType<typeof fakeContext>;

export function invokeHook<Event extends object>(fake: FakeContext, name: string, event: Event) {
  const hook = fake.hooks.get(name);
  if (!hook) throw new Error(`Hook not registered: ${name}`);
  return Promise.resolve(hook.callback(event as never)).then(() => event);
}

export function fakeProviderEditor() {
  const added: { info: Provider.Info; models: readonly Model.Info[] }[] = [];
  return {
    added,
    editor: {
      add: (input: { info: Provider.Info; models: readonly Model.Info[] }) => {
        added.push(input);
      },
    },
  };
}

export function fakeIntegrationEditor() {
  const names = new Map<string, string>();
  const methods: MethodRegistration[] = [];
  return {
    names,
    methods,
    editor: {
      update: (id: string, update: (integration: { id: string; name: string }) => void) => {
        const integration = { id, name: names.get(id) ?? '' };
        update(integration);
        names.set(id, integration.name);
      },
      method: {
        update: (input: MethodRegistration) => {
          methods.push(input);
        },
      },
    },
  };
}

export interface FakeTool {
  name: string;
  description: string;
  execute: (
    input: Record<string, unknown>,
    context: { sessionID: string; signal?: AbortSignal },
  ) => Promise<{ content?: unknown }>;
}

export interface FakeCommand {
  name: string;
  description?: string;
  execute: (invocation: { sessionID: string; prompt: { text: string } }) => Promise<void>;
}

export function fakeToolEditor() {
  const tools = new Map<string, FakeTool>();
  return {
    tools,
    editor: {
      add: (tool: FakeTool) => {
        tools.set(tool.name, tool);
      },
    },
  };
}

export function fakeCommandEditor() {
  const commands = new Map<string, FakeCommand>();
  return {
    commands,
    editor: {
      add: (command: FakeCommand) => {
        commands.set(command.name, command);
      },
    },
  };
}

export function applyTransforms(fake: FakeContext) {
  const editors = {
    provider: fakeProviderEditor(),
    integration: fakeIntegrationEditor(),
    tool: fakeToolEditor(),
    command: fakeCommandEditor(),
  };
  for (const callback of fake.transforms.provider) callback(editors.provider.editor as never);
  for (const callback of fake.transforms.integration) callback(editors.integration.editor as never);
  for (const callback of fake.transforms.tool) callback(editors.tool.editor as never);
  for (const callback of fake.transforms.command) callback(editors.command.editor as never);
  return editors;
}

export function grokModelEvent(modelID = 'grok-4.7') {
  return { id: modelID, providerID: 'grok-build' };
}

export interface FakeRetryDecision {
  retry: boolean;
  delay?: number;
}

export const EXHAUSTION_BODY = '402 "Grok Build usage balance exhausted"';

export const CRED_A: FakeConnection = { type: 'credential', id: 'cred_a', label: 'A' };
export const CRED_B: FakeConnection = { type: 'credential', id: 'cred_b', label: 'B' };

/** A context whose every credential connection resolves to `tok-<id>`. */
export function tokenContext(connections: FakeConnection[]) {
  return fakeContext({
    connections,
    credentials: Object.fromEntries(
      connections.flatMap((connection) =>
        connection.type === 'credential'
          ? [[connection.id, { type: 'key' as const, key: `tok-${connection.id}` }]]
          : [],
      ),
    ),
  });
}

export function jsonRequest(body: unknown) {
  return new Request('https://cli-chat-proxy.grok.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function httpRequestEvent(sessionID: string, request: Request, modelID?: string) {
  return {
    sessionID,
    agent: 'build',
    kind: 'primary',
    model: grokModelEvent(modelID),
    request,
  };
}

export function retryEvent(sessionID: string, status?: number) {
  return {
    sessionID,
    agent: 'build',
    model: grokModelEvent(),
    attempt: 2,
    error: { type: 'provider.error', message: 'failed', ...(status ? { status } : {}) },
    decision: { retry: false } as FakeRetryDecision,
  };
}

export async function serveRequest(fake: FakeContext, sessionID: string, modelID?: string) {
  const event = httpRequestEvent(sessionID, jsonRequest({ input: [] }), modelID);
  await invokeHook(fake, 'http.request', event);
  return event.request;
}

export async function answerRequest(
  fake: FakeContext,
  sessionID: string,
  status: number,
  body = '',
) {
  await invokeHook(fake, 'http.response', {
    sessionID,
    agent: 'build',
    kind: 'primary',
    model: grokModelEvent(),
    request: jsonRequest({}),
    response: new Response(body, { status }),
  });
}

export async function exhaustSession(fake: FakeContext, sessionID: string) {
  await serveRequest(fake, sessionID);
  return failRequest(fake, sessionID, 402, EXHAUSTION_BODY);
}

export async function failRequest(fake: FakeContext, sessionID: string, status: number, body = '') {
  await answerRequest(fake, sessionID, status, body);
  return invokeHook(fake, 'retry', retryEvent(sessionID, status));
}
