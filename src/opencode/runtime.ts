import { readFileSync } from 'node:fs';
import type { PluginInput } from '@opencode-ai/plugin';
import * as oauth from '../auth/oauth.js';
import { GROK_BUILD_ACCOUNT_ID, loadConfig, selectAccount, updateConfig } from '../config.js';
import { getOpenCodeDataDirectory } from '../storage.js';
import { grokBuildIdentityHeaders } from './identity.js';
import { loadQuotaCache } from './quotaCache.js';
import { EXHAUSTED_BALANCE_ERROR, ExhaustionRotation, isExactExhaustionError } from './rotation.js';

type StoredAuth =
  | {
      type: 'oauth';
      access: string;
      refresh: string;
      expires: number;
    }
  | {
      type: 'api';
      key: string;
    };

type LiveOAuth = Extract<StoredAuth, { type: 'oauth' }>;

function parseAuth(raw: string | undefined) {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).flatMap(([provider, entry]) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('type' in entry)) {
          return [];
        }
        if (
          entry.type === 'oauth' &&
          'access' in entry &&
          typeof entry.access === 'string' &&
          entry.access &&
          'refresh' in entry &&
          typeof entry.refresh === 'string' &&
          entry.refresh &&
          'expires' in entry &&
          typeof entry.expires === 'number' &&
          Number.isFinite(entry.expires)
        ) {
          return [[provider, entry as StoredAuth]];
        }
        if (entry.type === 'api' && 'key' in entry && typeof entry.key === 'string' && entry.key) {
          return [[provider, entry as StoredAuth]];
        }
        return [];
      }),
    );
  } catch {
    return {};
  }
}

function storedAuth() {
  let file: Record<string, StoredAuth> = {};
  try {
    file = parseAuth(readFileSync(`${getOpenCodeDataDirectory()}/auth.json`, 'utf8'));
  } catch {
    file = {};
  }
  const environment = parseAuth(process.env.OPENCODE_AUTH_CONTENT);
  return {
    ...file,
    ...Object.fromEntries(
      Object.entries(environment).filter(([provider, auth]) => {
        const persisted = file[provider];
        return (
          auth.type !== 'oauth' || persisted?.type !== 'oauth' || persisted.expires <= auth.expires
        );
      }),
    ),
  };
}

function authFingerprint(auth: StoredAuth | undefined) {
  if (!auth) return;
  if (auth.type === 'api') return `api:${auth.key}`;
  return `oauth:${auth.access}:${auth.refresh}:${auth.expires}`;
}

function tokenIsExpiring(expires: number | undefined) {
  return typeof expires !== 'number' || !Number.isFinite(expires) || expires <= Date.now();
}

function exactExhaustionResponse(status: number, body: string) {
  if (status !== 402) return false;
  const trimmed = body.trim();
  if (
    trimmed === '402 "Grok Build usage balance exhausted"' ||
    trimmed === '"Grok Build usage balance exhausted"' ||
    trimmed === 'Grok Build usage balance exhausted'
  ) {
    return true;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== 'object') return false;
    const error = 'error' in value ? value.error : undefined;
    if (typeof error === 'string') return error === 'Grok Build usage balance exhausted';
    return (
      Boolean(error) &&
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      error.message === 'Grok Build usage balance exhausted'
    );
  } catch {
    return false;
  }
}

export class GrokBuildRuntime {
  private live = new Map<string, LiveOAuth>();
  private observedStored = new Map<string, string | undefined>();
  private refreshes = new Map<string, Promise<LiveOAuth>>();
  private sessionProviders = new Map<string, string>();
  private pendingContinuations = new Map<string, { model: string; agent?: string }>();
  private observedSelectedProvider: string | undefined;
  readonly rotation = new ExhaustionRotation();

  constructor(private readonly input: PluginInput) {}

  seed(provider: string, auth: unknown) {
    if (!auth || typeof auth !== 'object' || !('type' in auth) || auth.type !== 'oauth') return;
    if (
      !('access' in auth) ||
      typeof auth.access !== 'string' ||
      !('refresh' in auth) ||
      typeof auth.refresh !== 'string'
    ) {
      return;
    }
    const record: LiveOAuth = {
      type: 'oauth',
      access: auth.access,
      refresh: auth.refresh,
      expires: 'expires' in auth && typeof auth.expires === 'number' ? auth.expires : 0,
    };
    const persisted = storedAuth()[provider];
    this.live.set(
      provider,
      persisted?.type === 'oauth' && persisted.expires > record.expires ? persisted : record,
    );
    this.observedStored.set(provider, authFingerprint(persisted));
  }

  config() {
    return loadConfig().config;
  }

  selectedProvider(sessionID?: string) {
    const selected = this.config().accounts.selectedProvider;
    if (this.observedSelectedProvider === undefined) this.observedSelectedProvider = selected;
    if (this.observedSelectedProvider !== selected) {
      this.sessionProviders.clear();
      this.observedSelectedProvider = selected;
    }
    return (sessionID && this.sessionProviders.get(sessionID)) || selected;
  }

  trackSession(sessionID: string, model: string, agent?: string) {
    this.pendingContinuations.set(sessionID, { model, ...(agent ? { agent } : {}) });
  }

  clearSession(sessionID: string) {
    this.sessionProviders.delete(sessionID);
    this.pendingContinuations.delete(sessionID);
    this.rotation.clearChain();
  }

  continuation(sessionID: string) {
    return this.pendingContinuations.get(sessionID);
  }

  authenticatedProviders() {
    const auth = storedAuth();
    return this.config().accounts.items.flatMap((account) => {
      if (account.provider === GROK_BUILD_ACCOUNT_ID && process.env.GROK_BUILD_OAUTH_TOKEN) {
        return [account.provider];
      }
      const entry = this.record(account.provider, auth);
      return entry?.type === 'oauth' || entry?.type === 'api' ? [account.provider] : [];
    });
  }

  environmentProviders() {
    const environment = parseAuth(process.env.OPENCODE_AUTH_CONTENT);
    return this.config().accounts.items.flatMap((account) => {
      if (
        (account.provider === GROK_BUILD_ACCOUNT_ID && process.env.GROK_BUILD_OAUTH_TOKEN) ||
        environment[account.provider]
      ) {
        return [account.provider];
      }
      return [];
    });
  }

  async token(provider = this.selectedProvider(), forceRefresh = false) {
    if (provider === GROK_BUILD_ACCOUNT_ID && process.env.GROK_BUILD_OAUTH_TOKEN) {
      return process.env.GROK_BUILD_OAUTH_TOKEN;
    }
    const record = this.record(provider);
    if (!record) return;
    if (record.type === 'api') return record.key;
    if (!forceRefresh && !tokenIsExpiring(record.expires)) return record.access;
    if (!record.refresh) return record.access;

    const existing = this.refreshes.get(provider);
    if (existing) return (await existing).access;
    const refresh = oauth
      .refresh({
        access: record.access,
        refresh: record.refresh,
        expires: record.expires ?? 0,
      })
      .then(async (tokens) => {
        const next: LiveOAuth = {
          type: 'oauth',
          access: tokens.access,
          refresh: tokens.refresh,
          expires: tokens.expires,
        };
        this.live.set(provider, next);
        await this.setAuth(provider, next).catch(() => undefined);
        this.rotation.clearRecentExhaustion(provider);
        return next;
      })
      .finally(() => this.refreshes.delete(provider));
    this.refreshes.set(provider, refresh);
    return (await refresh).access;
  }

  async setAuth(provider: string, auth: StoredAuth) {
    const result = await this.input.client.auth.set({
      path: { id: provider },
      body: auth,
    });
    if (result && typeof result === 'object' && 'error' in result && result.error) {
      throw new Error(`OpenCode auth update failed for ${provider}`);
    }
    if (auth.type === 'oauth') this.live.set(provider, auth);
    this.observedStored.set(provider, authFingerprint(storedAuth()[provider]));
  }

  async removeAuth(provider: string) {
    const url = new URL(`/auth/${encodeURIComponent(provider)}`, this.input.serverUrl);
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`OpenCode auth removal failed (${response.status})`);
    }
    this.live.delete(provider);
    this.observedStored.set(provider, undefined);
    this.rotation.markUnavailable(provider);
  }

  activate(provider: string, sessionID?: string) {
    this.select(provider, sessionID);
    this.rotation.clearChain();
  }

  private select(provider: string, sessionID?: string) {
    updateConfig((config) => selectAccount(config, provider));
    this.observedSelectedProvider = provider;
    if (sessionID) this.sessionProviders.set(sessionID, provider);
  }

  private candidate(current: string) {
    return this.rotation.candidates({
      config: this.config(),
      currentProvider: current,
      authenticatedProviders: this.authenticatedProviders(),
      quota: loadQuotaCache(),
    })[0];
  }

  rotate(sessionID: string | undefined, current: string) {
    const next = this.candidate(current);
    if (!next) return;
    this.select(next, sessionID);
    return next;
  }

  markExhausted(provider: string, message: unknown) {
    return this.rotation.markExhausted(provider, message);
  }

  async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
    const original = new Request(requestInput, init);
    const sessionID = original.headers.get('x-grok-conv-id') ?? undefined;
    const authenticated = this.authenticatedProviders();
    const selected = this.selectedProvider(sessionID);
    let provider = authenticated.includes(selected) ? selected : (authenticated[0] ?? selected);
    if (sessionID) this.sessionProviders.set(sessionID, provider);
    let lastResponse: Response | undefined;
    let rotating = false;

    for (let attempt = 0; attempt < Math.max(1, authenticated.length); attempt += 1) {
      const access = await this.token(provider).catch(() => undefined);
      if (!access) {
        this.rotation.markUnavailable(provider);
        const next = this.candidate(provider);
        if (!next) return lastResponse ?? fetch(original);
        provider = next;
        continue;
      }

      const send = (token: string) => {
        const request = original.clone();
        const headers = new Headers(request.headers);
        Object.entries(grokBuildIdentityHeaders()).forEach(([name, value]) => {
          headers.set(name, value);
        });
        headers.set('authorization', `Bearer ${token}`);
        return fetch(request, { headers });
      };

      let response = await send(access);
      if (response.status === 401) {
        const refreshed = await this.token(provider, true).catch(() => undefined);
        if (refreshed) response = await send(refreshed);
        if (response.status === 401 && rotating) {
          this.rotation.markUnavailable(provider);
          const next = this.candidate(provider);
          if (!next) return response;
          provider = next;
          continue;
        }
      }
      lastResponse = response;
      if (response.status !== 402) {
        if (rotating) this.select(provider, sessionID);
        return response;
      }
      if (!exactExhaustionResponse(response.status, await response.clone().text())) {
        if (rotating) this.select(provider, sessionID);
        return response;
      }
      this.markExhausted(provider, EXHAUSTED_BALANCE_ERROR);
      rotating = true;
      const next = this.candidate(provider);
      if (!next) return response;
      provider = next;
    }
    return lastResponse ?? fetch(original);
  }

  handleStreamExhaustion(sessionID: string, error: unknown) {
    if (!error || typeof error !== 'object') return;
    const data = 'data' in error && error.data && typeof error.data === 'object' ? error.data : {};
    const message = 'message' in data ? data.message : undefined;
    const body = 'responseBody' in data ? data.responseBody : undefined;
    const status = 'statusCode' in data ? data.statusCode : undefined;
    if (
      !isExactExhaustionError(message) &&
      !(
        typeof status === 'number' &&
        typeof body === 'string' &&
        exactExhaustionResponse(status, body)
      )
    ) {
      return;
    }
    const current = this.selectedProvider(sessionID);
    this.markExhausted(current, EXHAUSTED_BALANCE_ERROR);
    return this.rotate(sessionID, current);
  }

  private record(provider: string, auth = storedAuth()) {
    const persisted = auth[provider];
    const fingerprint = authFingerprint(persisted);
    if (!this.observedStored.has(provider)) {
      this.observedStored.set(provider, fingerprint);
      return this.live.get(provider) ?? persisted;
    }
    if (this.observedStored.get(provider) === fingerprint) {
      return this.live.get(provider) ?? persisted;
    }
    this.observedStored.set(provider, fingerprint);
    if (persisted?.type === 'oauth') this.live.set(provider, persisted);
    else this.live.delete(provider);
    return persisted;
  }
}
