'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import {
  type Plan,
  type SubscriptionData,
  FREE_DEFAULTS,
  parseSubscriptionData,
} from '@/types/billing';

export type { Plan, SubscriptionData };

export function useSubscription() {
  const accessToken = useAuthStore((s) => s.accessToken);

  const { data, isLoading } = useQuery<SubscriptionData>({
    queryKey: ['billing', 'me'],
    queryFn: async () =>
      parseSubscriptionData(await apiClient.getBillingStatus(accessToken ?? '')),
    enabled: !!accessToken,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    retry: 0,
    placeholderData: FREE_DEFAULTS,
  });

  const sub = data ?? FREE_DEFAULTS;

  return {
    isLoading,
    plan: sub.plan,
    status: sub.status,
    pastDue: sub.pastDue,
    isActive: sub.status === 'ACTIVE',
    isPro: sub.plan === 'PRO' && sub.status === 'ACTIVE',
    isFleet: sub.plan === 'FLEET' && sub.status === 'ACTIVE',
    limits: {
      maxVehicles: sub.maxVehicles,
      tripHistoryDays: sub.tripHistoryDays,
      chargingHistoryDays: sub.chargingHistoryDays,
      analyticsDepthDays: sub.analyticsDepthDays,
      liveRefreshSeconds: sub.liveRefreshSeconds,
    },
    features: {
      aiInsights: sub.aiInsights,
      fleetDashboard: sub.fleetDashboard,
      webhooks: sub.webhooks,
    },
  };
}
