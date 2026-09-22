import { Integration, type Plugin } from '@opencode/plugin';
import * as oauth from '../auth/oauth.js';

export const GROK_BUILD_INTEGRATION_ID = 'grok-build';
export const GROK_BUILD_ENV_TOKEN = 'GROK_BUILD_OAUTH_TOKEN';

type IntegrationEditor = Parameters<Parameters<Plugin.Context['integration']['transform']>[0]>[0];
type MethodRegistration = Parameters<IntegrationEditor['method']['update']>[0];
type OAuthRegistration = Extract<MethodRegistration, { authorize: unknown }>;
type OAuthCredential = Awaited<ReturnType<NonNullable<OAuthRegistration['refresh']>>>;

function oauthMethod(
  id: string,
  label: string,
  start: () => Promise<oauth.GrokBuildOAuthSession>,
  mode: 'auto' | 'code',
): OAuthRegistration {
  const methodID = Integration.MethodID.make(id);
  const credential = (credentials: oauth.OAuthCredentials): OAuthCredential => ({
    type: 'oauth',
    methodID,
    access: credentials.access,
    refresh: credentials.refresh,
    expires: Math.floor(credentials.expires),
  });
  return {
    integrationID: GROK_BUILD_INTEGRATION_ID,
    method: { id, type: 'oauth', label },
    authorize: async () => {
      const session = await start();
      const authorization = { url: session.url, instructions: session.instructions };
      if (mode === 'code') {
        return {
          ...authorization,
          mode,
          callback: (code: string) => session.finish(code).then(credential),
        };
      }
      return { ...authorization, mode, callback: session.finish().then(credential) };
    },
    refresh: (current) =>
      oauth
        .refresh({ access: current.access, refresh: current.refresh, expires: current.expires })
        .then((next) => ({
          ...current,
          access: next.access,
          refresh: next.refresh,
          expires: Math.floor(next.expires),
        })),
  };
}

export function registerGrokBuildIntegration(editor: IntegrationEditor) {
  editor.update(GROK_BUILD_INTEGRATION_ID, (integration) => {
    integration.name = 'Grok Build';
  });
  editor.method.update(
    oauthMethod(
      'browser',
      'Browser login (default)',
      () => oauth.beginGrokBuildOAuth('open-grok-build'),
      'auto',
    ),
  );
  editor.method.update(
    oauthMethod('device', 'Device login (headless)', oauth.beginGrokBuildDeviceOAuth, 'auto'),
  );
  editor.method.update(
    oauthMethod(
      'code',
      'Paste callback code (remote)',
      () => oauth.beginGrokBuildOAuth('open-grok-build-manual'),
      'code',
    ),
  );
  editor.method.update({
    integrationID: GROK_BUILD_INTEGRATION_ID,
    method: { type: 'env', names: [GROK_BUILD_ENV_TOKEN] },
  });
}
