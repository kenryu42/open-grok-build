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
  creditUsagePercent: unknown,
  billingPeriodEnd: string,
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
        creditUsagePercent,
        billingPeriodStart: '2026-07-07T00:19:56+00:00',
        billingPeriodEnd,
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}
