import { getBaseUrl } from '../auth/oauth.js';
import { grokBuildIdentityHeaders } from './identity.js';

export interface MonthlyUsage {
  monthlyLimit: number;
  used: number;
  billingPeriodEnd: string;
}

export interface WeeklyUsage {
  creditUsagePercent: number;
  billingPeriodEnd: string;
}

export interface CreditsUsage {
  creditUsagePercent: number;
  billingPeriodEnd: string;
  billingPeriodStart?: string;
  periodType?: string;
  prepaidBalance?: number;
  onDemandCap?: number;
  onDemandUsed?: number;
  isUnifiedBillingUser?: boolean;
}

export interface BillingUsage {
  credits?: CreditsUsage;
  monthly?: MonthlyUsage;
  weekly?: WeeklyUsage;
  onDemandEnabled?: boolean;
  subscriptionTier?: string;
}

const RESET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZoneName: 'short',
});

const LOCAL_TIME_ZONE = RESET_FORMATTER.resolvedOptions().timeZone;

const billingHeaders = (token: string) => ({
  ...grokBuildIdentityHeaders(),
  authorization: `Bearer ${token}`,
  accept: 'application/json',
});

export function isBillingObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isBillingDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function centValue(value: unknown) {
  if (!isBillingObject(value)) return undefined;
  return finiteNumber(value.val);
}

function parseMonthlyUsage(config: Record<string, unknown>): MonthlyUsage | undefined {
  const monthlyLimit = centValue(config.monthlyLimit);
  const used = centValue(config.used);
  if (monthlyLimit === undefined || used === undefined || !isBillingDate(config.billingPeriodEnd)) {
    return undefined;
  }
  return { monthlyLimit, used, billingPeriodEnd: config.billingPeriodEnd };
}

function parseCreditsUsage(config: Record<string, unknown>): CreditsUsage | undefined {
  const period = isBillingObject(config.currentPeriod) ? config.currentPeriod : undefined;
  const billingPeriodEnd = period?.end ?? config.billingPeriodEnd;
  if (!period || !isBillingDate(billingPeriodEnd)) return undefined;
  const rawPercent = finiteNumber(config.creditUsagePercent);
  if (config.creditUsagePercent !== undefined && rawPercent === undefined) return undefined;
  // The credits endpoint reports the on-demand allowance instead of a raw percent;
  // treat a missing or zero cap as 0% usage.
  const onDemandCap = centValue(config.onDemandCap);
  const onDemandUsed = centValue(config.onDemandUsed);
  const creditUsagePercent =
    rawPercent ??
    (typeof onDemandCap === 'number' && onDemandCap > 0 && typeof onDemandUsed === 'number'
      ? Math.min(100, Math.max(0, (onDemandUsed / onDemandCap) * 100))
      : 0);
  return {
    creditUsagePercent,
    billingPeriodEnd,
    ...(isBillingDate(period.start) ? { billingPeriodStart: period.start } : {}),
    ...(typeof period.type === 'string' ? { periodType: period.type } : {}),
    ...(centValue(config.prepaidBalance) !== undefined
      ? { prepaidBalance: centValue(config.prepaidBalance) }
      : {}),
    ...(centValue(config.onDemandCap) !== undefined
      ? { onDemandCap: centValue(config.onDemandCap) }
      : {}),
    ...(centValue(config.onDemandUsed) !== undefined
      ? { onDemandUsed: centValue(config.onDemandUsed) }
      : {}),
    ...(typeof config.isUnifiedBillingUser === 'boolean'
      ? { isUnifiedBillingUser: config.isUnifiedBillingUser }
      : {}),
  };
}

function parseBillingUsage(payload: unknown): BillingUsage | undefined {
  if (!isBillingObject(payload) || !isBillingObject(payload.config)) return undefined;
  const credits = parseCreditsUsage(payload.config);
  const monthly = parseMonthlyUsage(payload.config);
  if (!credits && !monthly) return undefined;
  return {
    ...(credits ? { credits } : {}),
    ...(monthly ? { monthly } : {}),
    ...(credits?.periodType === 'USAGE_PERIOD_TYPE_WEEKLY'
      ? {
          weekly: {
            creditUsagePercent: credits.creditUsagePercent,
            billingPeriodEnd: credits.billingPeriodEnd,
          },
        }
      : {}),
    ...(typeof payload.onDemandEnabled === 'boolean'
      ? { onDemandEnabled: payload.onDemandEnabled }
      : {}),
    ...(typeof payload.subscriptionTier === 'string'
      ? { subscriptionTier: payload.subscriptionTier }
      : {}),
  };
}

async function responseUsage(response: Response) {
  if (!response.ok) return undefined;
  return response.json().then(parseBillingUsage, () => undefined);
}

async function fetchSettingsTier(
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const response = await fetch(`${getBaseUrl()}/settings`, { headers, signal });
  if (!response.ok) return undefined;
  const payload: unknown = await response.json();
  if (!isBillingObject(payload)) return undefined;
  const tier = payload.subscription_tier_display;
  return typeof tier === 'string' && tier.length > 0 ? tier : undefined;
}

export async function fetchBillingUsage(
  token: string,
  signal?: AbortSignal,
): Promise<BillingUsage> {
  const headers = billingHeaders(token);
  const [monthlyResult, credits, subscriptionTier] = await Promise.all([
    fetch(`${getBaseUrl()}/billing`, { headers, signal }).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    ),
    fetch(`${getBaseUrl()}/billing?format=credits`, { headers, signal })
      .then(responseUsage)
      .catch((error: unknown) => {
        if (signal?.aborted) throw error;
        return undefined;
      }),
    fetchSettingsTier(headers, signal).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return undefined;
    }),
  ]);
  const monthly =
    'response' in monthlyResult ? await responseUsage(monthlyResult.response) : undefined;
  if (!monthly?.monthly && !credits?.credits) {
    if ('error' in monthlyResult) throw monthlyResult.error;
    if (!monthlyResult.response.ok) {
      throw new Error(`billing endpoint returned ${monthlyResult.response.status}`);
    }
    throw new Error('invalid billing payload');
  }
  return {
    ...monthly,
    ...credits,
    ...(subscriptionTier ? { subscriptionTier } : {}),
  };
}

function formatReset(iso: string): string {
  const parts = RESET_FORMATTER.formatToParts(new Date(iso));
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? '';
  const hour = part('hour') === '24' ? '00' : part('hour');
  return `${part('month')} ${part('day')}, ${hour}:${part('minute')} ${part('timeZoneName')} ${LOCAL_TIME_ZONE}`;
}

const detail = (label: string, value: string) => `   ${label.padEnd(11)}${value}`;

export function formatQuota(usage: BillingUsage | undefined): string[] {
  if (!usage) {
    return [
      '  Usage:',
      '    billing data unavailable — try again, or run /connect grok-build if not yet authenticated',
    ];
  }
  const tier = usage.subscriptionTier ? ` (${usage.subscriptionTier})` : '';
  const weekly =
    usage.weekly ??
    (usage.credits?.periodType === 'USAGE_PERIOD_TYPE_WEEKLY' ? usage.credits : undefined);
  if (!weekly) return [`Weekly Limit${tier}`, '    weekly usage unavailable'];
  return [
    `Weekly Limit${tier}`,
    detail('Used', `${Math.round(weekly.creditUsagePercent)}%`),
    detail('Reset', formatReset(weekly.billingPeriodEnd)),
  ];
}

export function remainingQuotaFraction(usage: BillingUsage) {
  if (usage.subscriptionTier?.trim().toLocaleLowerCase() === 'free') return undefined;
  if (!usage.credits) return undefined;
  return Math.min(1, Math.max(0, 1 - usage.credits.creditUsagePercent / 100));
}
