import { describe, expect, it } from 'vitest';
import { GROK_BUILD_USAGE_COMMAND } from '../../src/opencode/usage.js';
import {
  formatUsageToastMessage,
  GROK_BUILD_USAGE_SLASH,
  GROK_BUILD_USAGE_TUI_COMMAND,
} from '../../src/opencode/usageToast.js';

describe('usage toast helpers', () => {
  it('joins report lines without duplicating the toast title', () => {
    expect(
      formatUsageToastMessage([
        '  Usage:',
        '    10 / 100 credits used (10%)',
        '    90 credits remaining',
      ]),
    ).toBe('  Usage:\n    10 / 100 credits used (10%)\n    90 credits remaining');
  });

  it('uses grok-build-usage slash name consistent with command id', () => {
    expect(GROK_BUILD_USAGE_SLASH).toBe(GROK_BUILD_USAGE_COMMAND);
    expect(GROK_BUILD_USAGE_TUI_COMMAND).toBe('open-grok-build.grok-build-usage');
    expect(GROK_BUILD_USAGE_TUI_COMMAND).toContain('grok-build-usage');
  });
});
