// @ts-nocheck — OpenCode config/auth hook payloads are loosely typed at the host boundary.
import type { Plugin, PluginInput } from '@opencode-ai/plugin';
import * as oauth from '../auth/oauth.js';
import { resolveModels } from '../models/catalog.js';
import { sanitizePayload } from '../payload/sanitize.js';
import { GROK_BUILD_PROVIDER_ID, grokBuildProviderConfig, toPluginModels } from './grokModels.js';

// Grok CLI client version. Keep it in sync with the version the official Grok
// CLI client emits (observed in captured cli-chat-proxy.grok.com traffic).
const GROK_BUILD_VERSION = '0.2.91';
const OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;
const USER_AGENT = `grok-pager/${GROK_BUILD_VERSION} grok-shell/${GROK_BUILD_VERSION} (macos; aarch64)`;

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

function oauthAuthorize(start: () => Promise<oauth.GrokBuildOAuthSession>) {
  return async () => {
    const session = await start();
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
  };
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
            headers.set('x-grok-client-identifier', 'grok-pager');
            headers.set('x-grok-client-version', GROK_BUILD_VERSION);
            headers.set('x-xai-token-auth', 'xai-grok-cli');
            headers.set('User-Agent', USER_AGENT);

            return fetch(requestInput, { ...init, headers });
          },
        };
      },
      methods: [
        {
          label: 'Browser login (default)',
          type: 'oauth',
          authorize: oauthAuthorize(() => oauth.beginGrokBuildOAuth('open-grok-build')),
        },
        {
          // RFC 8628 device-code flow for headless / remote hosts. No loopback
          // callback server — the user opens the verification URL on any
          // device, enters the short code, and the CLI polls the token endpoint.
          label: 'Device login (headless)',
          type: 'oauth',
          authorize: oauthAuthorize(() => oauth.beginGrokBuildDeviceOAuth()),
        },
      ],
    },

    'chat.headers': async (chatInput, output) => {
      if (!isGrokBuildModel(chatInput.model)) return;
      output.headers['x-grok-client-identifier'] = 'grok-pager';
      output.headers['x-grok-client-version'] = GROK_BUILD_VERSION;
      output.headers['x-xai-token-auth'] = 'xai-grok-cli';
      output.headers['x-grok-model-override'] = chatInput.model.id;
      output.headers['x-grok-conv-id'] = chatInput.sessionID;
      output.headers['User-Agent'] = USER_AGENT;
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

    // opencode's task tool throws synchronously when task_id lacks the "ses"
    // prefix, escaping its own catchCause guard and crashing every subagent
    // launch. Non-reasoning models (e.g. grok-composer) fabricate arbitrary
    // IDs. Strip invalid IDs in place so the tool falls through to creating a
    // fresh subagent session; a real ses_ ID is preserved for resume.
    // https://github.com/anomalyco/opencode/issues/16755
    'tool.execute.before': async (toolInput, output) => {
      if (toolInput.tool !== 'task') return;
      const args = output.args;
      if (!args || typeof args !== 'object') return;
      const taskID = (args as Record<string, unknown>).task_id;
      if (typeof taskID === 'string' && !taskID.startsWith('ses')) {
        (args as Record<string, unknown>).task_id = undefined;
      }
    },
  };
};
