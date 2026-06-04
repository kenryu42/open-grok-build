import { describe, expect, it } from 'vitest';
import {
  GROK_SHIM_TOOL_NAMES,
  grokToolsToActivate,
  registerGrokTools,
} from '../../src/tools/register.js';
import type { ToolRegistrar } from '../../src/tools/types.js';

describe('Grok tool registration', () => {
  it('registers shim tools with renderers', () => {
    const toolNames: string[] = [];

    registerGrokTools({
      registerTool(tool) {
        toolNames.push(tool.name);
        expect(tool.renderCall).toBeTypeOf('function');
        expect(tool.renderResult).toBeTypeOf('function');
      },
    } satisfies ToolRegistrar);

    expect(toolNames.sort()).toEqual([...GROK_SHIM_TOOL_NAMES].sort());
    expect(toolNames).not.toContain('WebSearch');
  });

  it('does not include WebSearch in the active Grok tool set', () => {
    expect(grokToolsToActivate()).toEqual([...GROK_SHIM_TOOL_NAMES]);
    expect(grokToolsToActivate()).not.toContain('WebSearch');
  });
});
