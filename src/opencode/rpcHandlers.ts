import type { GrokBuildAccounts, HostAccount } from './accounts.js';
import { refreshAccountQuotas } from './accounts.js';
import { isCachedQuotaFresh, loadQuotaCache } from './quotaCache.js';
import type { ExhaustionRotation } from './rotation.js';
import type { AccountsListOutput } from './rpc.js';
import { buildGrokBuildUsageReport } from './usage.js';

export interface RpcHandlerDeps {
  accounts: GrokBuildAccounts;
  rotation: ExhaustionRotation;
}

const boundedSignal = (signal: AbortSignal) =>
  AbortSignal.any([signal, AbortSignal.timeout(30_000)]);

export async function accountsList(
  deps: RpcHandlerDeps,
  now = Date.now(),
): Promise<AccountsListOutput> {
  const accounts = await deps.accounts.list();
  const selected = await deps.accounts.selected();
  const cache = loadQuotaCache();
  return {
    accounts: accounts.map((account) => {
      const entry = cache.accounts[account.key];
      return {
        key: account.key,
        label: account.label,
        selected: account.key === selected?.key,
        environment: account.environment,
        exhausted: deps.rotation.isExhausted(account.key, now),
        ...(entry ? { quota: { ...entry, fresh: isCachedQuotaFresh(entry, now) } } : {}),
      };
    }),
  };
}

export async function findAccount(deps: RpcHandlerDeps, key: string | undefined) {
  if (!key) return deps.accounts.selected();
  return (await deps.accounts.list()).find((account) => account.key === key);
}

export async function accountsSelect(deps: RpcHandlerDeps, key: string) {
  await deps.accounts.select(key);
  return { ok: true as const };
}

export async function usageReport(deps: RpcHandlerDeps, account: HostAccount, signal: AbortSignal) {
  return {
    lines: await buildGrokBuildUsageReport({
      account,
      token: await deps.accounts.token(account).catch(() => undefined),
      signal: boundedSignal(signal),
    }),
  };
}

export async function quotasRefresh(
  deps: RpcHandlerDeps,
  keys: string[] | undefined,
  signal: AbortSignal,
) {
  const accounts = await deps.accounts.list();
  return refreshAccountQuotas({
    accounts: keys ? accounts.filter((account) => keys.includes(account.key)) : accounts,
    resolveToken: (account) => deps.accounts.token(account).catch(() => undefined),
    signal: boundedSignal(signal),
  });
}
