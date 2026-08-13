/** @jsxImportSource @opentui/solid */

import { spawn } from 'node:child_process';
import type { TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui';
import { loadConfig, selectAccount, updateConfig } from '../config.js';
import { type AccountRuntime, OpenCodeAccountDashboardManager } from './accountDashboardManager.js';
import { type AccountDashboardHandle, startAccountDashboard } from './dashboard/server.js';
import {
  authenticatedGrokBuildAccounts,
  buildGrokBuildUsageReport,
  environmentGrokBuildAccounts,
  invalidateFreshGrokBuildAccessToken,
  resolveFreshGrokBuildAccessToken,
  resolveGrokBuildAccessToken,
} from './usage.js';
import {
  formatUsageToastMessage,
  GROK_BUILD_USAGE_SLASH,
  GROK_BUILD_USAGE_TUI_COMMAND,
} from './usageToast.js';

function toast(
  api: TuiPluginApi,
  message: string,
  variant: 'info' | 'success' | 'warning' | 'error' = 'info',
) {
  api.ui.toast({ variant, title: 'Grok Build', message, duration: 8_000 });
}

function openBrowser(url: string, onError: () => void, onOpened: () => void) {
  const command =
    process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : { file: 'xdg-open', args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' });
  let settled = false;
  const fail = () => {
    if (settled) return;
    settled = true;
    onError();
  };
  child.once('error', fail);
  child.once('exit', (code) => {
    if (code !== 0) {
      fail();
      return;
    }
    if (settled) return;
    settled = true;
    onOpened();
  });
  child.unref();
}

async function requireSdkSuccess(result: unknown, action: string) {
  const response = await result;
  if (response && typeof response === 'object' && 'error' in response && response.error) {
    throw new Error(`OpenCode ${action} failed.`);
  }
  return response;
}

async function showUsage(api: TuiPluginApi) {
  const provider = loadConfig().config.accounts.selectedProvider;
  const token = await resolveFreshGrokBuildAccessToken(provider, authWriter(api)).catch(() =>
    resolveGrokBuildAccessToken(provider),
  );
  toast(api, formatUsageToastMessage(await buildGrokBuildUsageReport({ provider, token })));
}

function authWriter(api: TuiPluginApi) {
  return async (
    provider: string,
    auth: { type: 'oauth'; access: string; refresh: string; expires: number },
  ) => requireSdkSuccess(api.client.auth.set({ providerID: provider, auth }), 'auth update');
}

function tuiAccountRuntime(api: TuiPluginApi): AccountRuntime {
  return {
    authenticatedProviders: authenticatedGrokBuildAccounts,
    environmentProviders: environmentGrokBuildAccounts,
    token: (provider) => resolveFreshGrokBuildAccessToken(provider, authWriter(api)),
    setAuth: authWriter(api),
    async removeAuth(provider) {
      invalidateFreshGrokBuildAccessToken(provider);
      return requireSdkSuccess(api.client.auth.remove({ providerID: provider }), 'auth removal');
    },
    activate(provider) {
      updateConfig((config) => selectAccount(config, provider));
    },
    rotation: { clearRecentExhaustion() {} },
  };
}

const plugin: TuiPluginModule & { id: string } = {
  id: 'open-grok-build.tui',
  async tui(api) {
    let dashboard: AccountDashboardHandle | undefined;
    const dashboardManager = new OpenCodeAccountDashboardManager(tuiAccountRuntime(api));
    const commands = [
      {
        name: GROK_BUILD_USAGE_TUI_COMMAND,
        title: 'Grok Build usage',
        description: 'Show Grok Build billing quota and token health',
        category: 'Grok Build',
        namespace: 'palette',
        slashName: GROK_BUILD_USAGE_SLASH,
        run: () => showUsage(api),
      },
      {
        name: 'grok-build.accounts',
        title: 'Grok Build accounts',
        description: 'Open the private account and quota dashboard',
        category: 'Grok Build',
        namespace: 'palette',
        slashName: 'grok-build-accounts',
        async run() {
          const wasOpen = dashboard?.isOpen() === true;
          if (!wasOpen) dashboard = await startAccountDashboard(dashboardManager);
          if (!dashboard) return;
          const currentDashboard = dashboard;
          openBrowser(
            wasOpen ? dashboard.origin : dashboard.bootstrapUrl,
            () => {
              if (dashboard === currentDashboard) dashboard = undefined;
              void currentDashboard.close().catch(() => undefined);
              toast(api, 'Could not open the account dashboard in your browser.', 'error');
            },
            () => toast(api, `Account dashboard opened at ${currentDashboard.origin}`),
          );
        },
      },
    ];

    const unregister = api.keymap.registerLayer({ commands });
    api.lifecycle.onDispose(async () => {
      unregister();
      await dashboard?.close();
    });

    api.command?.register?.(() =>
      commands.map((command) => ({
        title: command.title,
        value: command.name,
        description: command.description,
        category: command.category,
        slash: { name: command.slashName },
        async onSelect() {
          api.ui.dialog.clear();
          await command.run();
        },
      })),
    );
  },
};

export default plugin;
