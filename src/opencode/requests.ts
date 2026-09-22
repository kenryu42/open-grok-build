import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode/plugin';
import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionRetry,
} from '@opencode/plugin/promise/session';
import { sanitizePayload } from '../payload/sanitize.js';
import type { GrokBuildAccounts } from './accounts.js';
import { grokBuildIdentityHeaders } from './identity.js';
import { GROK_BUILD_PROVIDER_ID } from './providerModels.js';
import { loadQuotaCache } from './quotaCache.js';
import { type ExhaustionRotation, isExactExhaustionResponse } from './rotation.js';

export const MAX_CONVERSATION_ROTATIONS = 2;
export const PROXY_RETRY_STATUSES: ReadonlySet<number> = new Set([401, 502, 520]);

export const conversationStorageKey = (sessionID: string) => `conv/${sessionID}`;

export function conversationId(sessionID: string, generation: number) {
  return generation > 0 ? `${sessionID}:${generation}` : sessionID;
}

export interface RequestHooksOptions {
  ctx: Pick<Plugin.Context, 'session' | 'storage' | 'location'>;
  accounts: GrokBuildAccounts;
  rotation: ExhaustionRotation;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function storedGeneration(value: unknown) {
  if (!value || typeof value !== 'object') return 0;
  const generation = (value as { generation?: unknown }).generation;
  return typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0
    ? generation
    : 0;
}

export class GrokBuildRequests {
  private readonly generations = new Map<string, number>();
  private readonly served = new Map<string, string>();
  private readonly pendingExhaustion = new Set<string>();
  private readonly pendingAuthFailure = new Set<string>();
  private readonly lastFailureStatus = new Map<string, number>();
  private readonly rotationsSinceSuccess = new Map<string, number>();

  constructor(private readonly options: RequestHooksOptions) {}

  async register() {
    const scope = { providerID: GROK_BUILD_PROVIDER_ID };
    await this.options.ctx.session.hook('http.request', (event) => this.request(event), scope);
    await this.options.ctx.session.hook('http.response', (event) => this.response(event), scope);
    await this.options.ctx.session.hook('retry', (event) => this.retry(event), scope);
  }

  async forgetSession(sessionID: string) {
    this.generations.delete(sessionID);
    this.served.delete(sessionID);
    this.pendingExhaustion.delete(sessionID);
    this.pendingAuthFailure.delete(sessionID);
    this.lastFailureStatus.delete(sessionID);
    this.rotationsSinceSuccess.delete(sessionID);
    this.options.accounts.forgetSession(sessionID);
    await this.options.ctx.storage.remove(conversationStorageKey(sessionID));
  }

  private async generation(sessionID: string) {
    const known = this.generations.get(sessionID);
    if (known !== undefined) return known;
    const generation = storedGeneration(
      await this.options.ctx.storage.get(conversationStorageKey(sessionID)),
    );
    this.generations.set(sessionID, generation);
    return generation;
  }

  private async request(event: SessionHttpRequest) {
    const account = await this.options.accounts.selected(event.sessionID);
    if (!account) return;
    const token = await this.options.accounts.token(account);
    if (!token) return;
    this.served.set(event.sessionID, account.key);
    const headers = new Headers(event.request.headers);
    headers.set('authorization', `Bearer ${token}`);
    for (const [name, value] of Object.entries(grokBuildIdentityHeaders())) {
      headers.set(name, value);
    }
    headers.set('x-grok-model-override', event.model.id);
    headers.set('x-grok-session-id', event.sessionID);
    headers.set('x-grok-agent-id', event.agent);
    headers.set('x-grok-req-id', randomUUID());
    headers.set(
      'x-grok-conv-id',
      conversationId(event.sessionID, await this.generation(event.sessionID)),
    );
    const payload =
      event.request.method !== 'GET' &&
      headers.get('content-type')?.includes('application/json') === true
        ? parseJsonObject(await event.request.clone().text())
        : undefined;
    const body = payload
      ? JSON.stringify(
          sanitizePayload(
            payload,
            event.model.id,
            event.sessionID,
            this.options.ctx.location.directory,
          ),
        )
      : undefined;
    event.request = new Request(event.request, {
      headers,
      ...(body === undefined ? {} : { body }),
    });
  }

  private async response(event: SessionHttpResponse) {
    if (event.response.status === 402) {
      const body = await event.response.clone().text();
      const key = this.served.get(event.sessionID);
      if (key && isExactExhaustionResponse(event.response.status, body)) {
        this.options.rotation.markExhausted(key);
        this.pendingExhaustion.add(event.sessionID);
      }
    }
    if (event.response.status === 401) this.pendingAuthFailure.add(event.sessionID);
    if (event.response.ok) {
      this.rotationsSinceSuccess.delete(event.sessionID);
      this.lastFailureStatus.delete(event.sessionID);
      this.options.rotation.clearChain();
      return;
    }
    this.lastFailureStatus.set(event.sessionID, event.response.status);
  }

  private async candidate(sessionID: string) {
    const key = this.served.get(sessionID);
    if (!key) return undefined;
    return this.options.rotation.candidates({
      accounts: (await this.options.accounts.list()).map((account) => account.key),
      current: key,
      quota: loadQuotaCache(),
    })[0];
  }

  private async rotateAccount(event: SessionRetry) {
    const next = await this.candidate(event.sessionID);
    if (!next) return false;
    await this.options.accounts.select(next, event.sessionID);
    event.decision = { retry: true, delay: 0 };
    return true;
  }

  private async retry(event: SessionRetry) {
    if (this.pendingExhaustion.delete(event.sessionID)) {
      await this.rotateAccount(event);
      return;
    }
    if (this.pendingAuthFailure.delete(event.sessionID)) {
      const key = this.served.get(event.sessionID);
      if (key) this.options.rotation.markUnavailable(key);
      if (await this.rotateAccount(event)) return;
    }
    const status = event.error.status ?? this.lastFailureStatus.get(event.sessionID);
    const rotations = this.rotationsSinceSuccess.get(event.sessionID) ?? 0;
    if (
      status === undefined ||
      !PROXY_RETRY_STATUSES.has(status) ||
      rotations >= MAX_CONVERSATION_ROTATIONS
    ) {
      return;
    }
    const generation = (await this.generation(event.sessionID)) + 1;
    this.generations.set(event.sessionID, generation);
    await this.options.ctx.storage.set(conversationStorageKey(event.sessionID), { generation });
    this.rotationsSinceSuccess.set(event.sessionID, rotations + 1);
    event.decision = { retry: true, delay: 0 };
  }
}
