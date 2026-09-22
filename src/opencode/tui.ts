import { spawn } from 'node:child_process';
import { Plugin } from '@opencode/plugin/tui';
import { type DashboardHost, OpenCodeAccountDashboardManager } from './accountDashboardManager.js';
import { type AccountDashboardHandle, startAccountDashboard } from './dashboard/server.js';
import { OpenGrokBuildRpc } from './rpc.js';
import { GROK_BUILD_USAGE_DESCRIPTION } from './usage.js';
import {
  formatUsageToastMessage,
  GROK_BUILD_USAGE_SLASH,
  GROK_BUILD_USAGE_TUI_COMMAND,
} from './usageToast.js';

function openBrowser(url: string, onError: () => void, onOpened: () => void) {
  const command =
    process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : { file: 'xdg-open', args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' });
  const settled = { done: false };
  const finish = (callback: () => void) => {
    if (settled.done) return;
    settled.done = true;
    callback();
  };
  child.once('error', () => finish(onError));
  child.once('exit', (code) => finish(code === 0 ? onOpened : onError));
  child.unref();
}

type PluginLocation = Plugin.Context['location'];

function dashboardHost(context: Plugin.Context, location: PluginLocation): DashboardHost {
  const rpc = context.client.rpc(OpenGrokBuildRpc);
  const oauth = context.client.integration.oauth;
  return {
    accountsList: () => rpc['accounts.list']({}, { location }),
    accountsSelect: (key) => rpc['accounts.select']({ key }, { location }),
    quotasRefresh: (keys, signal) => rpc['quotas.refresh']({ keys }, { location, signal }),
    credential: context.client.credential,
    oauth: {
      connect: (input) => oauth.connect({ ...input, location }),
      status: (input) => oauth.status({ ...input, location }),
      cancel: (input) => oauth.cancel({ ...input, location }),
    },
  };
}

// RPC rejections arrive as plain objects, so `String(error)` would render
// "[object Object]" instead of the server's message.
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

async function setup(context: Plugin.Context) {
  // Plugin RPC and integrations are registered per location. Without this the
  // server resolves its default location, where this plugin is not loaded, and
  // every call fails with "RPC is unavailable".
  const location = context.location ?? context.data.location.default();
  const rpc = context.client.rpc(OpenGrokBuildRpc);
  const manager = new OpenCodeAccountDashboardManager(dashboardHost(context, location));
  const state: { dashboard?: AccountDashboardHandle } = {};
  const toast = (message: string, variant: 'info' | 'error' = 'info') =>
    context.ui.toast.show({ title: 'Grok Build', message, variant, duration: 8_000 });

  const showUsage = () =>
    rpc['usage.report']({}, { location }).then(
      (report) => toast(formatUsageToastMessage(report.lines)),
      (error: unknown) => toast(errorMessage(error), 'error'),
    );

  const openDashboard = async () => {
    const wasOpen = state.dashboard?.isOpen() === true;
    if (!wasOpen) state.dashboard = await startAccountDashboard(manager);
    const dashboard = state.dashboard;
    if (!dashboard) return;
    openBrowser(
      wasOpen ? dashboard.origin : dashboard.bootstrapUrl,
      () => {
        if (state.dashboard === dashboard) state.dashboard = undefined;
        void dashboard.close().catch(() => undefined);
        toast('Could not open the account dashboard in your browser.', 'error');
      },
      () => toast(`Account dashboard opened at ${dashboard.origin}`),
    );
  };

  // `keymap.layer` reads a Solid context, so it only works while a component
  // renders. The `app` slot renders for the lifetime of the TUI and contributes
  // nothing visible, which is how a plugin owns global commands.
  const disposeCommands = context.ui.slot({
    append: 'app',
    render: () => {
      context.keymap.layer(() => ({
        mode: 'global',
        commands: [
          {
            id: GROK_BUILD_USAGE_TUI_COMMAND,
            title: 'Grok Build usage',
            description: GROK_BUILD_USAGE_DESCRIPTION,
            group: 'Grok Build',
            palette: true,
            slash: { name: GROK_BUILD_USAGE_SLASH },
            run: showUsage,
          },
          {
            id: 'open-grok-build.accounts',
            title: 'Grok Build accounts',
            description: 'Open the private account and quota dashboard',
            group: 'Grok Build',
            palette: true,
            slash: { name: 'grok-build-accounts' },
            run: openDashboard,
          },
        ],
      }));
      return null;
    },
  });

  return async () => {
    disposeCommands();
    await state.dashboard?.close();
  };
}

export default Plugin.define({ id: 'open-grok-build.tui', setup });
