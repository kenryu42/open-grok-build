// @ts-nocheck — OpenCode hook payloads and runtime tool attachments are wider than v1 types.
import type { Plugin, PluginInput } from '@opencode-ai/plugin';
import * as oauth from '../auth/oauth.js';
import { resolveModels } from '../models/catalog.js';
import { sanitizePayload } from '../payload/sanitize.js';
import { GROK_BUILD_PROVIDER_ID, grokBuildProviderConfig, toPluginModels } from './grokModels.js';
import { grokBuildIdentityHeaders } from './identity.js';
import { ROTATION_CONTINUATION } from './rotation.js';
import { GrokBuildRuntime } from './runtime.js';

const OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';

function isGrokBuildModel(model: { providerID: string }) {
  return model.providerID === GROK_BUILD_PROVIDER_ID;
}

async function finishOAuth(session: oauth.GrokBuildOAuthSession, code?: string) {
  try {
    const credentials = await session.finish(code);
    return {
      type: 'success' as const,
      refresh: credentials.refresh,
      access: credentials.access,
      expires: credentials.expires,
    };
  } catch {
    return { type: 'failed' as const };
  }
}

function oauthAuthorize(start: () => Promise<oauth.GrokBuildOAuthSession>) {
  return async () => {
    const session = await start();
    return {
      url: session.url,
      instructions: session.instructions,
      method: 'auto' as const,
      callback: () => finishOAuth(session),
    };
  };
}

function oauthAuthorizeManual() {
  return async () => {
    const session = await oauth.beginGrokBuildOAuth('open-grok-build-manual');
    return {
      url: session.url,
      instructions: session.instructions,
      method: 'code' as const,
      callback: (code: string) => finishOAuth(session, code),
    };
  };
}

export const OpenGrokBuildPlugin: Plugin = async (input: PluginInput) => {
  const runtime = new GrokBuildRuntime(input);
  const pendingRotation = new Map<string, { provider: string }>();

  return {
    config: async (cfg) => {
      if (!cfg.provider) cfg.provider = {};
      const provider = {
        ...grokBuildProviderConfig(),
        ...cfg.provider[GROK_BUILD_PROVIDER_ID],
      };
      provider.options = {
        ...provider.options,
        apiKey: OAUTH_DUMMY_KEY,
        fetch: runtime.fetch.bind(runtime),
      };
      cfg.provider[GROK_BUILD_PROVIDER_ID] = provider;
    },

    provider: {
      id: GROK_BUILD_PROVIDER_ID,
      async models(provider) {
        return toPluginModels(provider.models, resolveModels());
      },
    },

    auth: {
      provider: GROK_BUILD_PROVIDER_ID,
      async loader(getAuth) {
        runtime.seed(GROK_BUILD_PROVIDER_ID, await getAuth());
        return {
          apiKey: OAUTH_DUMMY_KEY,
          fetch: runtime.fetch.bind(runtime),
        };
      },
      methods: [
        {
          label: 'Browser login (default)',
          type: 'oauth',
          authorize: oauthAuthorize(() => oauth.beginGrokBuildOAuth('open-grok-build')),
        },
        {
          label: 'Device login (headless)',
          type: 'oauth',
          authorize: oauthAuthorize(() => oauth.beginGrokBuildDeviceOAuth()),
        },
        {
          label: 'Paste callback/code (remote)',
          type: 'oauth',
          authorize: oauthAuthorizeManual(),
        },
      ],
    },

    'chat.message': async (chatInput, _output) => {
      if (!chatInput.model || chatInput.model.providerID !== GROK_BUILD_PROVIDER_ID) return;
      runtime.rotation.clearChain();
      runtime.trackSession(chatInput.sessionID, chatInput.model.modelID, chatInput.agent);
    },

    'chat.headers': async (chatInput, output) => {
      if (!isGrokBuildModel(chatInput.model)) return;
      Object.assign(output.headers, grokBuildIdentityHeaders(), {
        'x-grok-model-override': chatInput.model.id,
        'x-grok-conv-id': chatInput.sessionID,
        'x-grok-req-id': chatInput.message.id,
        'x-grok-session-id': chatInput.sessionID,
        'x-grok-agent-id': chatInput.agent,
      });
    },

    'chat.params': async (chatInput, output) => {
      if (!isGrokBuildModel(chatInput.model)) return;
      runtime.trackSession(chatInput.sessionID, chatInput.model.id, chatInput.agent);
      output.options = {
        ...output.options,
        ...sanitizePayload(
          { ...output.options },
          chatInput.model.id,
          chatInput.sessionID,
          input.directory,
        ),
      };
    },

    'tool.execute.before': async (toolInput, output) => {
      if (toolInput.tool !== 'task') return;
      const args = output.args;
      if (!args || typeof args !== 'object') return;
      const taskID = args.task_id;
      if (typeof taskID === 'string' && !taskID.startsWith('ses')) args.task_id = undefined;
    },

    event: async ({ event }) => {
      if (event.type === 'session.error' && event.properties.sessionID) {
        const provider = runtime.handleStreamExhaustion(
          event.properties.sessionID,
          event.properties.error,
        );
        if (provider) pendingRotation.set(event.properties.sessionID, { provider });
        return;
      }
      if (event.type === 'session.idle') {
        const pending = pendingRotation.get(event.properties.sessionID);
        if (!pending) return;
        pendingRotation.delete(event.properties.sessionID);
        const continuation = runtime.continuation(event.properties.sessionID);
        await input.client.session.promptAsync({
          path: { id: event.properties.sessionID },
          body: {
            ...(continuation?.agent ? { agent: continuation.agent } : {}),
            model: {
              providerID: GROK_BUILD_PROVIDER_ID,
              modelID: continuation?.model ?? 'grok-build',
            },
            parts: [{ type: 'text', text: ROTATION_CONTINUATION }],
          },
        });
        return;
      }
      if (event.type === 'session.deleted') {
        runtime.clearSession(event.properties.info.id);
      }
    },
  };
};
