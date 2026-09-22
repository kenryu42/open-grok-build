import type { Plugin } from '@opencode/plugin';
import { loadConfig, updateConfig } from '../config.js';
import { type BillingUsage, fetchBillingUsage } from './billing.js';
import { GROK_BUILD_INTEGRATION_ID } from './integration.js';
import { saveQuotaUsage } from './quotaCache.js';

type Connection = Parameters<Plugin.Context['integration']['connection']['resolve']>[0];

export const ENVIRONMENT_ACCOUNT_LABEL = 'Environment token';

export interface HostAccount {
  key: string;
  label: string;
  environment: boolean;
  connection: Connection;
}

export function connectionKey(connection: Connection) {
  return connection.type === 'credential'
    ? `credential:${connection.id}`
    : `env:${connection.name}`;
}

export function credentialID(key: string) {
  return key.startsWith('credential:') ? key.slice('credential:'.length) : undefined;
}

export type AccountsHost = Pick<Plugin.Context['integration'], 'get' | 'connection'>;

export class GrokBuildAccounts {
  private listing: Promise<HostAccount[]> | undefined;
  private readonly pins = new Map<string, string>();

  constructor(private readonly host: AccountsHost) {}

  list() {
    this.listing ??= this.host
      .get({ integrationID: GROK_BUILD_INTEGRATION_ID })
      .then((result) =>
        result.data.connections.map((connection) => ({
          key: connectionKey(connection),
          label: connection.type === 'credential' ? connection.label : ENVIRONMENT_ACCOUNT_LABEL,
          environment: connection.type === 'env',
          connection,
        })),
      )
      .catch((error: unknown) => {
        this.listing = undefined;
        throw error;
      });
    return this.listing;
  }

  invalidate() {
    this.listing = undefined;
  }

  token(account: HostAccount) {
    return this.host.connection
      .resolve(account.connection)
      .then((value) => (value?.type === 'key' ? value.key : value?.access));
  }

  async selected(sessionID?: string) {
    const accounts = await this.list();
    const wanted =
      (sessionID ? this.pins.get(sessionID) : undefined) ?? loadConfig().config.accounts.selected;
    const active =
      wanted === undefined
        ? await this.host.connection.active(GROK_BUILD_INTEGRATION_ID)
        : undefined;
    return (
      accounts.find((account) => account.key === wanted) ??
      (active ? accounts.find((account) => account.key === connectionKey(active)) : undefined) ??
      accounts[0]
    );
  }

  async select(key: string, sessionID?: string) {
    const account = (await this.list()).find((candidate) => candidate.key === key);
    if (!account) throw new Error(`Unknown Grok Build account: ${key}`);
    updateConfig((config) => ({ ...config, accounts: { selected: key } }));
    if (!sessionID) this.pins.clear();
    if (sessionID) this.pins.set(sessionID, key);
    return account;
  }

  forgetSession(sessionID: string) {
    this.pins.delete(sessionID);
  }
}

export interface RefreshAccountQuotasOptions {
  accounts: HostAccount[];
  resolveToken: (account: HostAccount) => Promise<string | undefined>;
  signal: AbortSignal;
  fetchUsage?: (token: string, signal: AbortSignal) => Promise<BillingUsage>;
  saveUsage?: (key: string, usage: BillingUsage) => Promise<void>;
}

export async function refreshAccountQuotas(options: RefreshAccountQuotasOptions) {
  const failed: string[] = [];
  const outcome = { updated: 0 };
  const refresh = async (account: HostAccount) => {
    const token = await options.resolveToken(account).catch(() => undefined);
    const usage =
      token && !options.signal.aborted
        ? await (options.fetchUsage ?? fetchBillingUsage)(token, options.signal).catch(
            () => undefined,
          )
        : undefined;
    const stored =
      usage && !options.signal.aborted
        ? await (options.saveUsage ?? saveQuotaUsage)(account.key, usage).then(
            () => true,
            () => false,
          )
        : false;
    if (!stored) {
      failed.push(account.key);
      return;
    }
    outcome.updated += 1;
  };
  const refreshBatches = async (accounts: HostAccount[]): Promise<void> => {
    if (options.signal.aborted || !accounts.length) return;
    await Promise.all(accounts.slice(0, 3).map(refresh));
    await refreshBatches(accounts.slice(3));
  };
  await refreshBatches(options.accounts);
  return { updated: outcome.updated, failed };
}
