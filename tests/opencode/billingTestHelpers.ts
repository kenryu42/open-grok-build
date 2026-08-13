export function billingJsonResponse(
  monthlyLimit: unknown,
  used: unknown,
  billingPeriodEnd: unknown,
  status = 200,
) {
  return new Response(
    JSON.stringify({
      config: {
        monthlyLimit: { val: monthlyLimit },
        used: { val: used },
        billingPeriodEnd,
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

export function creditsJsonResponse(
  onDemandCap: unknown,
  onDemandUsed: unknown,
  billingPeriodEnd: string,
  config: Record<string, unknown> = {},
  status = 200,
) {
  return new Response(
    JSON.stringify({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-07-07T00:19:56+00:00',
          end: billingPeriodEnd,
        },
        onDemandCap: { val: onDemandCap },
        onDemandUsed: { val: onDemandUsed },
        billingPeriodStart: '2026-07-07T00:19:56+00:00',
        billingPeriodEnd,
        ...config,
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

export function settingsJsonResponse(tier: unknown, status = 200) {
  return new Response(JSON.stringify({ subscription_tier_display: tier }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
