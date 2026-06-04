import { GROK_BUILD_USAGE_COMMAND } from './usage.js';

export function formatUsageToastMessage(report: string[]): string {
  return report.join('\n');
}

export const GROK_BUILD_USAGE_TUI_COMMAND = 'open-grok-build.grok-build-usage';

export const GROK_BUILD_USAGE_SLASH = GROK_BUILD_USAGE_COMMAND;
