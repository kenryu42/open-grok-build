import { registerGrokTools } from '../tools/register.js';
import type { ShimRegisteredTool } from '../tools/types.js';

export type CollectedGrokTool = Pick<ShimRegisteredTool, 'name' | 'description' | 'execute'>;

export function collectPiGrokTools(): CollectedGrokTool[] {
  const tools: CollectedGrokTool[] = [];
  registerGrokTools({
    registerTool(tool) {
      tools.push({
        name: tool.name,
        description: tool.description,
        execute: tool.execute,
      });
    },
  });
  return tools;
}
