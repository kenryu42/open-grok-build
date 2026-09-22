import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { GrokBuildAccounts } from '../../src/opencode/accounts.js';
import { grokBuildUserAgent } from '../../src/opencode/identity.js';
import { conversationStorageKey, GrokBuildRequests } from '../../src/opencode/requests.js';
import { ExhaustionRotation } from '../../src/opencode/rotation.js';
import { useTempOpenCodeHome } from '../stateTestHelpers.js';
import {
  answerRequest,
  CRED_A,
  CRED_B,
  EXHAUSTION_BODY,
  exhaustSession,
  type FakeConnection,
  type FakeContext,
  failRequest,
  fakeContext,
  httpRequestEvent,
  invokeHook,
  jsonRequest,
  retryEvent,
  serveRequest,
  tokenContext,
} from './fakeContext.js';

const useTempHome = useTempOpenCodeHome('open-grok-build-requests-');
const SESSION = 'ses_1';

async function setup(connections: FakeConnection[] = [CRED_A]) {
  useTempHome();
  const fake = tokenContext(connections);
  const requests = new GrokBuildRequests({
    ctx: fake.ctx,
    accounts: new GrokBuildAccounts(fake.ctx.integration),
    rotation: new ExhaustionRotation(),
  });
  await requests.register();
  return { fake, requests };
}

const header = (request: Request, name: string) => request.headers.get(name);

async function conversationIds(fake: FakeContext, rounds: number, status: number) {
  const ids: (string | null)[] = [];
  const decisions: boolean[] = [];
  for (const _round of Array.from({ length: rounds })) {
    ids.push(header(await serveRequest(fake, SESSION), 'x-grok-conv-id'));
    decisions.push((await failRequest(fake, SESSION, status)).decision.retry);
  }
  return { ids, decisions };
}

describe('Grok Build session request hooks', () => {
  it('registers the provider-scoped hooks', async () => {
    const { fake } = await setup();

    expect([...fake.hooks.keys()]).toEqual(['http.request', 'http.response', 'retry']);
    for (const hook of fake.hooks.values()) {
      expect(hook.options).toEqual({ providerID: 'grok-build' });
    }
  });

  it('authorizes, identifies and sanitizes the outgoing request', async () => {
    const { fake } = await setup();
    const event = httpRequestEvent(
      SESSION,
      jsonRequest({
        input: [{ role: 'system', content: 'sys' }],
        reasoningEffort: 'high',
        reasoning: { effort: 'high' },
      }),
    );

    await invokeHook(fake, 'http.request', event);

    expect(header(event.request, 'authorization')).toBe('Bearer tok-cred_a');
    expect(header(event.request, 'User-Agent')).toBe(grokBuildUserAgent());
    expect(header(event.request, 'x-grok-client-identifier')).toBe('grok-pager');
    expect(header(event.request, 'x-xai-token-auth')).toBe('xai-grok-cli');
    expect(header(event.request, 'x-grok-model-override')).toBe('grok-4.7');
    expect(header(event.request, 'x-grok-session-id')).toBe(SESSION);
    expect(header(event.request, 'x-grok-agent-id')).toBe('build');
    expect(header(event.request, 'x-grok-conv-id')).toBe(SESSION);
    expect(header(event.request, 'content-type')).toBe('application/json');
    expect(header(event.request, 'x-grok-req-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await event.request.json()).toEqual({
      input: [],
      instructions: 'sys',
      reasoning: { effort: 'high' },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: SESSION,
    });
  });

  it('gives every request a distinct request id', async () => {
    const { fake } = await setup();

    const first = header(await serveRequest(fake, SESSION), 'x-grok-req-id');
    const second = header(await serveRequest(fake, SESSION), 'x-grok-req-id');

    expect(first).not.toBe(second);
  });

  it('leaves non-JSON bodies untouched while still authorizing', async () => {
    const { fake } = await setup();
    const event = httpRequestEvent(
      SESSION,
      new Request('https://cli-chat-proxy.grok.com/v1/responses', {
        method: 'POST',
        body: 'raw bytes',
      }),
    );

    await invokeHook(fake, 'http.request', event);

    expect(header(event.request, 'authorization')).toBe('Bearer tok-cred_a');
    expect(await event.request.text()).toBe('raw bytes');
  });

  it('leaves the request untouched when no account is connected', async () => {
    useTempHome();
    const fake = fakeContext();
    const requests = new GrokBuildRequests({
      ctx: fake.ctx,
      accounts: new GrokBuildAccounts(fake.ctx.integration),
      rotation: new ExhaustionRotation(),
    });
    await requests.register();
    const event = httpRequestEvent(SESSION, jsonRequest({ input: [] }));

    await invokeHook(fake, 'http.request', event);

    expect(header(event.request, 'authorization')).toBeNull();
  });

  it.each([
    [{ generation: 2 }, `${SESSION}:2`],
    [{ generation: -1 }, SESSION],
  ])('restores the stored conversation generation %j', async (stored, expected) => {
    const { fake } = await setup();
    fake.storage.set(conversationStorageKey(SESSION), stored);

    expect(header(await serveRequest(fake, SESSION), 'x-grok-conv-id')).toBe(expected);
  });

  it('rotates to another account when the balance is exhausted', async () => {
    const { fake } = await setup([CRED_A, CRED_B]);

    const retry = await exhaustSession(fake, SESSION);

    expect(retry.decision).toEqual({ retry: true, delay: 0 });
    expect(loadConfig().config.accounts.selected).toBe('credential:cred_b');
    expect(header(await serveRequest(fake, SESSION), 'authorization')).toBe('Bearer tok-cred_b');
  });

  it('surfaces exhaustion when no other account is available', async () => {
    const { fake } = await setup();
    await serveRequest(fake, SESSION);

    expect((await failRequest(fake, SESSION, 402, EXHAUSTION_BODY)).decision).toEqual({
      retry: false,
    });
  });

  it('ignores a 402 body that is not the exhaustion message', async () => {
    const { fake } = await setup([CRED_A, CRED_B]);
    await serveRequest(fake, SESSION);

    expect((await failRequest(fake, SESSION, 402, 'card declined')).decision).toEqual({
      retry: false,
    });
    expect(loadConfig().config.accounts.selected).toBeUndefined();
  });

  it('rotates accounts on an authentication failure when another account exists', async () => {
    const { fake } = await setup([CRED_A, CRED_B]);
    await serveRequest(fake, SESSION);

    expect((await failRequest(fake, SESSION, 401)).decision).toEqual({ retry: true, delay: 0 });
    expect(loadConfig().config.accounts.selected).toBe('credential:cred_b');
  });

  it.each([
    401, 502, 520,
  ])('retries HTTP %i at most twice with a new conversation id', async (status) => {
    const { fake } = await setup();

    const rotated = await conversationIds(fake, 3, status);

    expect(rotated.ids).toEqual([SESSION, `${SESSION}:1`, `${SESSION}:2`]);
    expect(rotated.decisions).toEqual([true, true, false]);
    expect(fake.storage.get(conversationStorageKey(SESSION))).toEqual({ generation: 2 });

    await answerRequest(fake, SESSION, 200, '{}');
    const recovered = await conversationIds(fake, 1, status);

    expect(recovered.decisions).toEqual([true]);
    expect(header(await serveRequest(fake, SESSION), 'x-grok-conv-id')).toBe(`${SESSION}:3`);
  });

  it('leaves unrelated failures to the host retry policy', async () => {
    const { fake } = await setup();
    await serveRequest(fake, SESSION);
    await answerRequest(fake, SESSION, 429);

    expect((await invokeHook(fake, 'retry', retryEvent(SESSION, 429))).decision).toEqual({
      retry: false,
    });
  });

  it('forgets the conversation generation of a deleted session', async () => {
    const { fake, requests } = await setup();
    await serveRequest(fake, SESSION);
    await failRequest(fake, SESSION, 502);

    await requests.forgetSession(SESSION);

    expect(fake.storage.has(conversationStorageKey(SESSION))).toBe(false);
    expect(header(await serveRequest(fake, SESSION), 'x-grok-conv-id')).toBe(SESSION);
  });
});
