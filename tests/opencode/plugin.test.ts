import { describe, expect, it } from 'vitest';
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

function testPluginInput() {
  return {
    client: {} as never,
    project: {} as never,
    directory: process.cwd(),
    worktree: process.cwd(),
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:4096'),
    $: undefined as never,
  };
}

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
    expect(hooks.auth?.methods?.length).toBeGreaterThan(0);
  });

  it('does not register grok-build-usage as a server slash command', async () => {
    const hooks = await OpenGrokBuildPlugin(testPluginInput());
    const cfg: { command?: Record<string, unknown> } = {};
    await hooks.config?.(cfg);
    expect(cfg.command?.['grok-build-usage']).toBeUndefined();
    expect(hooks['command.execute.before']).toBeUndefined();
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
