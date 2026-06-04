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
