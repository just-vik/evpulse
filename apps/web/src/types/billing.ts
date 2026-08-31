export type Plan = 'FREE' | 'PRO' | 'FLEET';

export interface SubscriptionData {
  plan: Plan;
  status: 'ACTIVE' | 'INACTIVE';
  pastDue: boolean;
  maxVehicles: number;
  tripHistoryDays: number;
  chargingHistoryDays: number;
  analyticsDepthDays: number;
  liveRefreshSeconds: number;
  aiInsights: boolean;
  fleetDashboard: boolean;
  webhooks: boolean;
}

export const FREE_DEFAULTS: SubscriptionData = {
  plan: 'FREE',
  status: 'INACTIVE',
  pastDue: false,
  maxVehicles: 1,
  tripHistoryDays: 7,
  chargingHistoryDays: 7,
  analyticsDepthDays: 7,
  liveRefreshSeconds: 60,
  aiInsights: false,
  fleetDashboard: false,
  webhooks: false,
};

/** Normalizes /billing/me JSON into strict unions for React Query typing. */
export function parseSubscriptionData(raw: {
  plan: string;
  status: string;
  pastDue: boolean;
  maxVehicles: number;
  tripHistoryDays: number;
  chargingHistoryDays: number;
  analyticsDepthDays: number;
  liveRefreshSeconds: number;
  aiInsights: boolean;
  fleetDashboard: boolean;
  webhooks: boolean;
}): SubscriptionData {
  const plan: Plan =
    raw.plan === 'PRO' ? 'PRO' : raw.plan === 'FLEET' ? 'FLEET' : 'FREE';
  const status: 'ACTIVE' | 'INACTIVE' =
    raw.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
  return {
    plan,
    status,
    pastDue: Boolean(raw.pastDue),
    maxVehicles: Number(raw.maxVehicles) || 1,
    tripHistoryDays: Number(raw.tripHistoryDays) || 7,
    chargingHistoryDays: Number(raw.chargingHistoryDays) || 7,
    analyticsDepthDays: Number(raw.analyticsDepthDays) || 7,
    liveRefreshSeconds: Number(raw.liveRefreshSeconds) || 60,
    aiInsights: Boolean(raw.aiInsights),
    fleetDashboard: Boolean(raw.fleetDashboard),
    webhooks: Boolean(raw.webhooks),
  };
}
