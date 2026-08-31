export interface DateRange {
  from: Date;
  to: Date;
}

type HistoryKey = 'tripHistoryDays' | 'chargingHistoryDays' | 'analyticsDepthDays';

interface EntitlementLimits {
  tripHistoryDays: number;
  chargingHistoryDays: number;
  analyticsDepthDays: number;
}

/**
 * Clamps a requested date range to the entitlement limit.
 * Never throws — always returns a valid range.
 * The `clamped` flag signals the frontend to show an upgrade prompt.
 */
export function clampDateRange(
  requested: Partial<DateRange>,
  entitlements: EntitlementLimits,
  historyKey: HistoryKey,
): DateRange & { clamped: boolean; limitDays: number } {
  const limitDays     = entitlements[historyKey];
  const now           = new Date();
  const hardLimit     = new Date(now.getTime() - limitDays * 86_400_000);
  const requestedFrom = requested.from ?? new Date(now.getTime() - 3650 * 86_400_000);

  const from = requestedFrom < hardLimit ? hardLimit : requestedFrom;
  const to   = requested.to && requested.to < now ? requested.to : now;

  return { from, to, clamped: requestedFrom < hardLimit, limitDays };
}
