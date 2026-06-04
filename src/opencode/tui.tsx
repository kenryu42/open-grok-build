/** @jsxImportSource @opentui/solid */
import type { TuiPluginModule } from '@opencode-ai/plugin/tui';
import { buildGrokBuildUsageReport } from './usage.js';
import {
  formatUsageToastMessage,
  GROK_BUILD_USAGE_SLASH,
  GROK_BUILD_USAGE_TUI_COMMAND,
} from './usageToast.js';

async function showUsageToast(api: {
  ui: {
    toast: (input: {
      variant?: 'info' | 'success' | 'warning' | 'error';
      title?: string;
      message: string;
      duration?: number;
    }) => void;
  };
}) {
  const report = await buildGrokBuildUsageReport();
  api.ui.toast({
    variant: 'info',
    title: 'Grok Build',
    message: formatUsageToastMessage(report),
    duration: 8_000,
  });
}

const plugin: TuiPluginModule & { id: string } = {
  id: 'open-grok-build.tui',
  async tui(api) {
    api.keymap.registerLayer({
      commands: [
        {
          name: GROK_BUILD_USAGE_TUI_COMMAND,
          title: 'Grok Build usage',
          description: 'Show Grok Build billing quota and token health',
          category: 'Grok Build',
          namespace: 'palette',
          slashName: GROK_BUILD_USAGE_SLASH,
          async run() {
            await showUsageToast(api);
          },
        },
      ],
    });

    api.command?.register?.(() => [
      {
        title: 'Grok Build usage',
        value: GROK_BUILD_USAGE_TUI_COMMAND,
        description: 'Show Grok Build billing quota and token health',
        category: 'Grok Build',
        slash: { name: GROK_BUILD_USAGE_SLASH },
        async onSelect() {
          api.ui.dialog.clear();
          await showUsageToast(api);
        },
      },
    ]);
  },
};

export default plugin;
