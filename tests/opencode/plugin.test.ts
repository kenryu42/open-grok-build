import { describe, expect, it } from 'vitest';
import { grokBuildProviderConfig } from '../../src/opencode/grokModels.js';
import { OpenGrokBuildPlugin } from '../../src/opencode/plugin.js';

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
});
