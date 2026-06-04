// @ts-nocheck — OpenCode config/auth hook payloads are loosely typed at the host boundary.
import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import * as oauth from '../auth/oauth.js';
import { resolveModels } from '../models/catalog.js';
import { sanitizePayload } from '../payload/sanitize.js';
import { collectGrokShimTools } from './collectGrokTools.js';
import { GROK_CLI_PROVIDER_ID, grokCliProviderConfig, toPluginModels } from './grokModels.js';
import { grokToolArgSchemas } from './grokToolSchemas.js';
import { captureRateLimit, loadQuotaCache } from './quota.js';
import { OPENCODE_INSTALLATION_VERSION } from './version.js';

const GROK_CLI_VERSION = '0.2.16';
const OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;

const collectedTools = collectGrokShimTools();

function accessTokenIsExpiring(
  token: string | undefined,
  skewMs = ACCESS_TOKEN_REFRESH_SKEW_MS,
): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length < 2) return false;
  try {
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4 !== 0) payload += '=';
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (typeof claims?.exp !== 'number') return false;
    return claims.exp * 1000 <= Date.now() + Math.max(0, skewMs);
  } catch {
    return false;
  }
}

function isGrokCliModel(model: { providerID: string }) {
  return model.providerID === GROK_CLI_PROVIDER_ID;
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
  loadQuotaCache();

  return {
    config: async (cfg) => {
      const existing = cfg.provider?.[GROK_CLI_PROVIDER_ID];
      if (existing) return;
      if (!cfg.provider) cfg.provider = {};
      cfg.provider[GROK_CLI_PROVIDER_ID] = grokCliProviderConfig();
    },

    provider: {
      id: GROK_CLI_PROVIDER_ID,
      async models(provider, _ctx) {
        return toPluginModels(provider.models, resolveModels());
      },
    },

    auth: {
      provider: GROK_CLI_PROVIDER_ID,
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth.type !== 'oauth') return {};

        let refreshPromise:
          | Promise<{ access: string; refresh: string; expires: number }>
          | undefined;

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            let currentAuth = await getAuth();
            if (currentAuth.type !== 'oauth') return fetch(requestInput, init);

            const expiresSoon =
              !currentAuth.expires ||
              currentAuth.expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS ||
              accessTokenIsExpiring(currentAuth.access);

            if (expiresSoon) {
              if (!refreshPromise) {
                const refreshToken = currentAuth.refresh;
                refreshPromise = oauth
                  .refresh({
                    access: currentAuth.access,
                    refresh: refreshToken,
                    expires: currentAuth.expires ?? 0,
                  })
                  .then(async (tokens) => {
                    const expires = tokens.expires;
                    await input.client.auth
                      .set({
                        path: { id: GROK_CLI_PROVIDER_ID },
                        body: {
                          type: 'oauth',
                          access: tokens.access,
                          refresh: tokens.refresh,
                          expires,
                        },
                      })
                      .catch(() => undefined);
                    return {
                      access: tokens.access,
                      refresh: tokens.refresh,
                      expires,
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
            headers.set('x-grok-client-identifier', 'open-grok-build');
            headers.set('x-grok-client-version', GROK_CLI_VERSION);
            headers.set('x-xai-token-auth', 'xai-grok-cli');
            headers.set('User-Agent', `opencode/${OPENCODE_INSTALLATION_VERSION}`);

            const response = await fetch(requestInput, { ...init, headers });
            const modelOverride = headers.get('x-grok-model-override');
            if (modelOverride) {
              captureRateLimit(modelOverride, Object.fromEntries(response.headers.entries()));
            }
            return response;
          },
        };
      },
      methods: [
        {
          label: 'Grok CLI (cli-chat-proxy)',
          type: 'oauth',
          authorize: async () => {
            const session = await oauth.beginGrokCliOAuth('open-grok-build');
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
                  };
                } catch {
                  return { type: 'failed' as const };
                }
              },
            };
          },
        },
        {
          label: 'Grok CLI token bypass (GROK_CLI_OAUTH_TOKEN)',
          type: 'api',
        },
      ],
    },

    'chat.headers': async (chatInput, output) => {
      if (!isGrokCliModel(chatInput.model)) return;
      output.headers['x-grok-client-identifier'] = 'open-grok-build';
      output.headers['x-grok-client-version'] = GROK_CLI_VERSION;
      output.headers['x-xai-token-auth'] = 'xai-grok-cli';
      output.headers['x-grok-model-override'] = chatInput.model.id;
      output.headers['x-grok-conv-id'] = chatInput.sessionID;
      output.headers['User-Agent'] = `opencode/${OPENCODE_INSTALLATION_VERSION}`;
    },

    'chat.params': async (chatInput, output) => {
      if (!isGrokCliModel(chatInput.model)) return;
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
