import { registerFileTools } from './files.js';
import { registerSearchTools } from './search.js';
import { registerShellTool } from './shell.js';
import type { ToolRegistrar } from './types.js';

/** Grok/Cursor shims registered for Grok Build models. */
export const GROK_SHIM_TOOL_NAMES = [
  'Grep',
  'Glob',
  'LS',
  'Read',
  'Write',
  'StrReplace',
  'Edit',
  'Delete',
  'Shell',
] as const;

export const GROK_TOOL_NAMES_FOR_SCOPE = [...GROK_SHIM_TOOL_NAMES] as const;

export const GROK_SUPPRESSED_TOOL_NAMES = ['web_search', 'websearch'] as const;

export function grokToolsToActivate() {
  return [...GROK_SHIM_TOOL_NAMES];
}

export function registerGrokTools(registrar: ToolRegistrar) {
  registerSearchTools(registrar);
  registerFileTools(registrar);
  registerShellTool(registrar);
}
