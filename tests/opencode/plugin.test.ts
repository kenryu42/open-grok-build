import { describe, expect, it } from 'vitest';
import { collectGrokShimTools } from '../../src/opencode/collectGrokTools.js';
import { grokBuildProviderConfig } from '../../src/opencode/grokModels.js';
import { OpenGrokBuildPlugin } from '../../src/opencode/plugin.js';
import { GROK_SHIM_TOOL_NAMES } from '../../src/tools/register.js';

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
  it('registers grok-build provider config and Cursor shim tools', async () => {
    const hooks = await OpenGrokBuildPlugin(testPluginInput());

    const cfg: { provider?: Record<string, unknown> } = {};
    await hooks.config?.(cfg);
    expect(cfg.provider?.['grok-build']).toBeDefined();

    const providerCfg = grokBuildProviderConfig();
    expect(providerCfg.api).toBe('https://cli-chat-proxy.grok.com/v1');
    expect(Object.keys(providerCfg.models)).toContain('grok-build');

    const toolNames = Object.keys(hooks.tool ?? {}).sort();
    expect(toolNames).toEqual([...GROK_SHIM_TOOL_NAMES].sort());
    expect(toolNames).not.toContain('WebSearch');
  });

  it('collects the same shim tools as registerGrokTools', () => {
    expect(
      collectGrokShimTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual([...GROK_SHIM_TOOL_NAMES].sort());
  });

  it('exposes grok-build OAuth auth hook', async () => {
    const hooks = await OpenGrokBuildPlugin(testPluginInput());
    expect(hooks.auth?.provider).toBe('grok-build');
    expect(hooks.auth?.methods?.length).toBeGreaterThan(0);
  });
});
