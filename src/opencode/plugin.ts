import { Plugin } from '@opencode/plugin';
import { registerImagine } from '../imagine/register.js';
import { GrokBuildAccounts } from './accounts.js';
import { GROK_BUILD_INTEGRATION_ID, registerGrokBuildIntegration } from './integration.js';
import { grokBuildModels, grokBuildProvider } from './providerModels.js';
import { GrokBuildRequests } from './requests.js';
import { ExhaustionRotation } from './rotation.js';
import { OpenGrokBuildRpc } from './rpc.js';
import {
  accountsList,
  accountsSelect,
  findAccount,
  quotasRefresh,
  usageReport,
} from './rpcHandlers.js';

async function setup(ctx: Plugin.Context) {
  const accounts = new GrokBuildAccounts(ctx.integration);
  const deps = { accounts, rotation: new ExhaustionRotation() };
  const requests = new GrokBuildRequests({ ctx, ...deps });

  await ctx.integration.transform(registerGrokBuildIntegration);
  await ctx.provider.transform((editor) => {
    editor.add({ info: grokBuildProvider(), models: grokBuildModels() });
  });
  await requests.register();
  await ctx.rpc.register(OpenGrokBuildRpc, {
    'accounts.list': () => accountsList(deps),
    'accounts.select': async (input, context) => {
      const account = await findAccount(deps, input.key);
      if (!account) {
        return context.error('not_found', `Unknown Grok Build account: ${input.key}`, {
          key: input.key,
        });
      }
      return accountsSelect(deps, input.key);
    },
    'usage.report': async (input, context) => {
      const account = await findAccount(deps, input.key);
      if (!account) {
        return context.error('not_found', 'No Grok Build account is connected. Run /connect.', {
          key: input.key ?? '',
        });
      }
      return usageReport(deps, account, context.signal);
    },
    'quotas.refresh': (input, context) => quotasRefresh(deps, input.keys, context.signal),
  });
  await registerImagine({
    ctx,
    token: async (sessionID) => {
      const account = await accounts.selected(sessionID);
      return account ? accounts.token(account) : undefined;
    },
  });

  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (
        event.type === 'credential.updated' ||
        event.type === 'credential.switched' ||
        event.type === 'integration.updated'
      ) {
        accounts.invalidate();
      }
      if (
        event.type === 'credential.switched' &&
        event.data.integrationID === GROK_BUILD_INTEGRATION_ID &&
        typeof event.data.credentialID === 'string'
      ) {
        await accounts.select(`credential:${event.data.credentialID}`).catch(() => undefined);
      }
      if (event.type === 'session.deleted') await requests.forgetSession(event.data.sessionID);
    }
  })().catch(() => undefined);

  return () => {
    controller.abort();
  };
}

export default Plugin.define({ id: 'open-grok-build', setup });
