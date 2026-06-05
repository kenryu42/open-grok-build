// @ts-nocheck — OpenCode config/auth hook payloads are loosely typed at the host boundary.
import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import * as oauth from '../auth/oauth.js';
import { resolveModels } from '../models/catalog.js';
import { sanitizePayload } from '../payload/sanitize.js';
import { collectGrokShimTools } from './collectGrokTools.js';
import { GROK_BUILD_PROVIDER_ID, grokBuildProviderConfig, toPluginModels } from './grokModels.js';
import { grokToolArgSchemas } from './grokToolSchemas.js';

import { OPENCODE_INSTALLATION_VERSION } from './version.js';

const GROK_BUILD_VERSION = '0.2.16';
const OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;

const collectedTools = collectGrokShimTools();

/**
 * Checks the stored expiry timestamp against an early-refresh threshold.
 * Replaces the old JWT-decoding check — the stored `expires` from oauth.ts
 * is authoritative and already accounts for the server `expires_in` response.
 */
function tokenIsExpiring(expires: number | undefined, skewMs: number): boolean {
  if (typeof expires !== 'number' || !Number.isFinite(expires)) return true;
  return expires - Date.now() <= skewMs;
}

function isGrokBuildModel(model: { providerID: string }) {
  return model.providerID === GROK_BUILD_PROVIDER_ID;
}

function buildGrokToolDefinitions() {
  const defs: NonNullable<Hooks['tool']> = {};
  for (const entry of collectedTools) {
    const args = grokToolArgSchemas[entry.name as keyof typeof grokToolArgSchemas];
    if (!args) continue;
    defs[entry.name] = tool({
      description: entry.description,
      args,
      async execute(params, ctx) {
        const result = await entry.execute(
          'opencode',
          params as Record<string, unknown>,
          ctx.abort,
          undefined,
          { cwd: ctx.directory },
        );
        const text = result.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
        return {
          title: entry.name,
          output: text,
          metadata: result.details ?? {},
        };
      },
    });
  }
  return defs;
}

export const OpenGrokBuildPlugin: Plugin = async (input: PluginInput) => {
  return {
    config: async (cfg) => {
      const existing = cfg.provider?.[GROK_BUILD_PROVIDER_ID];
      if (!existing) {
        if (!cfg.provider) cfg.provider = {};
        cfg.provider[GROK_BUILD_PROVIDER_ID] = grokBuildProviderConfig();
      }
    },

    provider: {
      id: GROK_BUILD_PROVIDER_ID,
      async models(provider, _ctx) {
        return toPluginModels(provider.models, resolveModels());
      },
    },

    auth: {
      provider: GROK_BUILD_PROVIDER_ID,
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth.type !== 'oauth') return {};

        let refreshPromise:
          | Promise<{ access: string; refresh: string; expires: number; tokenEndpoint?: string }>
          | undefined;

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            let currentAuth = await getAuth();
            if (currentAuth.type !== 'oauth') return fetch(requestInput, init);

            const expiresSoon = tokenIsExpiring(currentAuth.expires, ACCESS_TOKEN_REFRESH_SKEW_MS);

            if (expiresSoon) {
              if (!refreshPromise) {
                const refreshToken = currentAuth.refresh;
                const savedEndpoint = currentAuth.tokenEndpoint as string | undefined;
                refreshPromise = oauth
                  .refresh({
                    access: currentAuth.access,
                    refresh: refreshToken,
                    expires: currentAuth.expires ?? 0,
                    ...(savedEndpoint ? { tokenEndpoint: savedEndpoint } : {}),
                  })
                  .then(async (tokens) => {
                    const expires = tokens.expires;
                    const tokenEndpoint = (tokens as Record<string, unknown>).tokenEndpoint as
                      | string
                      | undefined;
                    await input.client.auth
                      .set({
                        path: { id: GROK_BUILD_PROVIDER_ID },
                        body: {
                          type: 'oauth',
                          access: tokens.access,
                          refresh: tokens.refresh,
                          expires,
                          ...(tokenEndpoint ? { tokenEndpoint } : {}),
                        },
                      })
                      .catch(() => undefined);
                    return {
                      access: tokens.access,
                      refresh: tokens.refresh,
                      expires,
                      tokenEndpoint,
                    };
                  })
                  .finally(() => {
                    refreshPromise = undefined;
                  });
              }
              const refreshed = await refreshPromise;
              currentAuth = { ...currentAuth, ...refreshed };
            }

            const headers = new Headers(
              requestInput instanceof Request ? requestInput.headers : undefined,
            );
            if (init?.headers) {
              const entries =
                init.headers instanceof Headers
                  ? init.headers.entries()
                  : Array.isArray(init.headers)
                    ? init.headers
                    : Object.entries(init.headers as Record<string, string | undefined>);
              for (const [key, value] of entries) {
                if (value !== undefined) headers.set(key, String(value));
              }
            }
            headers.set('authorization', `Bearer ${currentAuth.access}`);
            headers.set('x-grok-client-identifier', 'grok-shell');
            headers.set('x-grok-client-version', GROK_BUILD_VERSION);
            headers.set('x-xai-token-auth', 'xai-grok-cli');
            headers.set('User-Agent', `opencode/${OPENCODE_INSTALLATION_VERSION}`);

            return fetch(requestInput, { ...init, headers });
          },
        };
      },
      methods: [
        {
          label: 'Grok Build (cli-chat-proxy)',
          type: 'oauth',
          authorize: async () => {
            const session = await oauth.beginGrokBuildOAuth('open-grok-build');
            return {
              url: session.url,
              instructions: session.instructions,
              method: 'auto' as const,
              callback: async () => {
                try {
                  const credentials = await session.finish();
                  return {
                    type: 'success' as const,
                    refresh: credentials.refresh,
                    access: credentials.access,
                    expires: credentials.expires,
                    tokenEndpoint: (credentials as Record<string, unknown>).tokenEndpoint as
                      | string
                      | undefined,
                  };
                } catch {
                  return { type: 'failed' as const };
                }
              },
            };
          },
        },
        {
          label: 'Grok Build token bypass (GROK_BUILD_OAUTH_TOKEN)',
          type: 'api',
        },
      ],
    },

    'chat.headers': async (chatInput, output) => {
      if (!isGrokBuildModel(chatInput.model)) return;
      output.headers['x-grok-client-identifier'] = 'open-grok-build';
      output.headers['x-grok-client-version'] = GROK_BUILD_VERSION;
      output.headers['x-xai-token-auth'] = 'xai-grok-cli';
      output.headers['x-grok-model-override'] = chatInput.model.id;
      output.headers['x-grok-conv-id'] = chatInput.sessionID;
      output.headers['User-Agent'] = `opencode/${OPENCODE_INSTALLATION_VERSION}`;
    },

    'chat.params': async (chatInput, output) => {
      if (!isGrokBuildModel(chatInput.model)) return;
      const cwd = input.directory;
      const sanitized = sanitizePayload(
        { ...output.options },
        chatInput.model.id,
        chatInput.sessionID,
        cwd,
      );
      output.options = { ...output.options, ...sanitized };
    },

    tool: buildGrokToolDefinitions(),
  };
};
