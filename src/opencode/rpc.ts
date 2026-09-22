import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';

const QuotaPeriod = z.object({
  creditUsagePercent: z.number().optional(),
  billingPeriodEnd: z.string().optional(),
  periodType: z.string().optional(),
  used: z.number().optional(),
  monthlyLimit: z.number().optional(),
});

const AccountQuota = z.object({
  updatedAt: z.string(),
  fresh: z.boolean(),
  subscriptionTier: z.string().optional(),
  credits: QuotaPeriod.optional(),
  monthly: QuotaPeriod.optional(),
  weekly: QuotaPeriod.optional(),
});

export const AccountSummary = z.object({
  key: z.string(),
  label: z.string(),
  selected: z.boolean(),
  environment: z.boolean(),
  exhausted: z.boolean(),
  quota: AccountQuota.optional(),
});

export const AccountsList = z.object({ accounts: z.array(AccountSummary) });

const AccountKey = z.object({ key: z.string() });

export const OpenGrokBuildRpc = Rpc.define({
  id: 'open-grok-build',
  methods: {
    'accounts.list': { input: z.object({}), output: AccountsList },
    'accounts.select': {
      input: AccountKey,
      output: z.object({ ok: z.literal(true) }),
      errors: { not_found: AccountKey },
    },
    'usage.report': {
      input: z.object({ key: z.string().optional() }),
      output: z.object({ lines: z.array(z.string()) }),
      errors: { not_found: AccountKey },
    },
    'quotas.refresh': {
      input: z.object({ keys: z.array(z.string()).optional() }),
      output: z.object({ updated: z.number(), failed: z.array(z.string()) }),
    },
  },
  events: {},
});

export type AccountsListOutput = z.infer<typeof AccountsList>;
