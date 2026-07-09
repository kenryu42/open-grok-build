import { afterEach, describe, expect, it, vi } from 'vitest';
import * as oauth from '../../src/auth/oauth.js';
import { grokBuildProviderConfig } from '../../src/opencode/grokModels.js';
import { OpenGrokBuildPlugin } from '../../src/opencode/plugin.js';

type TaskExecuteBeforeInput = { tool: string; sessionID: string; callID: string };
type TaskExecuteBeforeOutput = { args: Record<string, unknown> };

async function triggerTaskExecuteBefore(
  hooks: Awaited<ReturnType<typeof OpenGrokBuildPlugin>>,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const output: TaskExecuteBeforeOutput = { args };
  const fn = (hooks as Record<string, unknown>)['tool.execute.before'] as
    | ((input: TaskExecuteBeforeInput, output: TaskExecuteBeforeOutput) => Promise<void>)
    | undefined;
  if (fn) await fn({ tool, sessionID: 'ses_test', callID: 'call_1' }, output);
  return output.args;
}

function testPluginInput(overrides: { authSet?: ReturnType<typeof vi.fn> } = {}) {
  return {
    client: {
      auth: {
        set: overrides.authSet ?? vi.fn(async () => ({ data: true })),
      },
    } as never,
    project: {} as never,
    directory: process.cwd(),
    worktree: process.cwd(),
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:4096'),
    $: undefined as never,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('OpenGrokBuildPlugin', () => {
  it('registers grok-build provider config without custom tools', async () => {
    const hooks = await OpenGrokBuildPlugin(testPluginInput());

    const cfg: { provider?: Record<string, unknown> } = {};
    await hooks.config?.(cfg);
    expect(cfg.provider?.['grok-build']).toBeDefined();

    const providerCfg = grokBuildProviderConfig();
    expect(providerCfg.api).toBe('https://cli-chat-proxy.grok.com/v1');
    expect(Object.keys(providerCfg.models)).toContain('grok-build');

    expect(hooks.tool).toBeUndefined();
  });

  it('exposes grok-build OAuth auth hook', async () => {
    const hooks = await OpenGrokBuildPlugin(testPluginInput());
    expect(hooks.auth?.provider).toBe('grok-build');
    expect(hooks.auth?.methods).toEqual([
      expect.objectContaining({ label: 'Browser login (default)', type: 'oauth' }),
      expect.objectContaining({ label: 'Device login (headless)', type: 'oauth' }),
    ]);
  });

  it('does not register grok-build-usage as a server slash command', async () => {
    const hooks = await OpenGrokBuildPlugin(testPluginInput());
    const cfg: { command?: Record<string, unknown> } = {};
    await hooks.config?.(cfg);
    expect(cfg.command?.['grok-build-usage']).toBeUndefined();
    expect(hooks['command.execute.before']).toBeUndefined();
  });

  describe('auth.loader refresh', () => {
    async function withAuthLoader(opts: {
      authSet?: ReturnType<typeof vi.fn>;
      refresh: {
        access: string;
        refresh: string;
        expires: number;
        tokenEndpoint?: string;
      };
      fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
      authExtra?: Record<string, unknown>;
      run: (ctx: {
        loaded: { fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
        authState: {
          type: 'oauth';
          access: string;
          refresh: string;
          expires: number;
          [key: string]: unknown;
        };
        refreshSpy: ReturnType<typeof vi.spyOn>;
        authSet: ReturnType<typeof vi.fn>;
      }) => Promise<void>;
    }) {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);

      const authState = {
        type: 'oauth' as const,
        access: 'old-access',
        refresh: 'old-refresh',
        expires: 1_700_000_000_000 - 1,
        ...opts.authExtra,
      };
      const authSet =
        opts.authSet ??
        vi.fn(async (args: { body: Record<string, unknown> }) => {
          Object.assign(authState, args.body);
          return { data: true };
        });
      const refreshSpy = vi.spyOn(oauth, 'refresh').mockResolvedValue(opts.refresh);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = opts.fetchMock;

      try {
        const hooks = await OpenGrokBuildPlugin(testPluginInput({ authSet }));
        const loaded = await hooks.auth?.loader?.(async () => authState as never, {} as never);
        await opts.run({ loaded: loaded ?? {}, authState, refreshSpy, authSet });
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    it('refreshes expired tokens, persists schema-legal fields, and retries 401 once', async () => {
      let apiCalls = 0;
      const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
        apiCalls += 1;
        const authHeader = new Headers(init?.headers).get('authorization');
        if (apiCalls === 1) {
          expect(authHeader).toBe('Bearer new-access');
          return new Response('expired', { status: 401 });
        }
        expect(authHeader).toBe('Bearer new-access');
        return new Response('ok', { status: 200 });
      });

      await withAuthLoader({
        authExtra: { tokenEndpoint: 'https://auth.x.ai/oauth/token' },
        refresh: {
          access: 'new-access',
          refresh: 'new-refresh',
          expires: 1_700_000_480_000,
          tokenEndpoint: 'https://auth.x.ai/oauth/token',
        },
        fetchMock,
        run: async ({ loaded, authState, refreshSpy, authSet }) => {
          const response = await loaded.fetch?.('https://cli-chat-proxy.grok.com/v1/responses', {
            method: 'POST',
          });

          expect(response?.status).toBe(200);
          expect(refreshSpy).toHaveBeenCalledTimes(2);
          expect(authSet).toHaveBeenCalled();
          expect(authSet.mock.calls[0]?.[0]?.body).toEqual({
            type: 'oauth',
            access: 'new-access',
            refresh: 'new-refresh',
            expires: 1_700_000_480_000,
          });
          expect(authState.refresh).toBe('new-refresh');
          expect(apiCalls).toBe(2);
        },
      });
    });

    it('reuses process-local rotated refresh tokens even when auth.set fails', async () => {
      const authSet = vi.fn(async () => {
        throw new Error('auth store write failed');
      });
      const fetchMock = vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));

      await withAuthLoader({
        authSet,
        refresh: {
          access: 'new-access',
          refresh: 'rotated-refresh',
          expires: 1_700_000_480_000,
          tokenEndpoint: 'https://auth.x.ai/oauth/token',
        },
        fetchMock,
        run: async ({ loaded, refreshSpy }) => {
          await loaded.fetch?.('https://cli-chat-proxy.grok.com/v1/responses');
          // Still unexpired in process-local cache — must not re-hit oauth.refresh
          // with the stale disk refresh token.
          await loaded.fetch?.('https://cli-chat-proxy.grok.com/v1/responses');

          expect(refreshSpy).toHaveBeenCalledOnce();
          expect(authSet).toHaveBeenCalledOnce();
          expect(fetchMock).toHaveBeenCalledTimes(2);
          expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
            'Bearer new-access',
          );
        },
      });
    });
  });

  describe('tool.execute.before', () => {
    // opencode's task tool throws synchronously when task_id lacks the "ses"
    // prefix, escaping its own catchCause guard and crashing every subagent
    // launch (https://github.com/anomalyco/opencode/issues/16755).
    // The hook strips invalid IDs so the tool falls through to a fresh child.
    it('strips task_id values that lack the ses prefix (fabricated by non-reasoning models)', async () => {
      const hooks = await OpenGrokBuildPlugin(testPluginInput());
      const args = await triggerTaskExecuteBefore(
        hooks,
        'task',
        // Mimics grok-composer fabricating a UUID as task_id
        {
          description: 'investigate bug',
          prompt: 'find the leak',
          subagent_type: 'general',
          task_id: '4178c106-bf3c-4a14-89e4-07d68188bdd8',
        },
      );
      expect(args.task_id).toBeUndefined();
      expect(args.subagent_type).toBe('general');
    });

    it('preserves real ses_ task_id values for subagent resume', async () => {
      const hooks = await OpenGrokBuildPlugin(testPluginInput());
      const args = await triggerTaskExecuteBefore(hooks, 'task', {
        description: 'continue work',
        prompt: 'resume',
        subagent_type: 'general',
        task_id: 'ses_14209ee2affeovRO3QEIAheNCH',
      });
      expect(args.task_id).toBe('ses_14209ee2affeovRO3QEIAheNCH');
    });

    it('ignores non-task tools', async () => {
      const hooks = await OpenGrokBuildPlugin(testPluginInput());
      const args = await triggerTaskExecuteBefore(hooks, 'read', {
        path: '/tmp/file.txt',
        task_id: 'not-a-real-id',
      });
      // read tool is untouched; only the task tool is sanitized
      expect(args.task_id).toBe('not-a-real-id');
    });

    it('no-ops when task_id is absent', async () => {
      const hooks = await OpenGrokBuildPlugin(testPluginInput());
      const args = await triggerTaskExecuteBefore(hooks, 'task', {
        description: 'do work',
        prompt: 'go',
        subagent_type: 'general',
      });
      expect(args.task_id).toBeUndefined();
      expect(args.subagent_type).toBe('general');
    });
  });
});
