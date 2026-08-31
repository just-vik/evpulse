'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';

/**
 * Single hook — fetches ONE aggregated endpoint:
 * GET /vehicles/:id/dashboard/full
 * Returns: status + tripsToday + chargingSummary + costSummary + batteryHealth + vampireDrain
 */
export function useDashboardData(vehicleId: string | null) {
  const { accessToken } = useAuthStore();
  const { preferences } = useUIStore();
  const queryClient = useQueryClient();
  const rate = preferences.energyRate ?? 0.35;

  const query = useQuery({
    queryKey: ['dashboard-full', vehicleId, rate],
    queryFn: () => apiClient.getFullDashboard(vehicleId!, rate, accessToken!),
    enabled: !!vehicleId && !!accessToken,
    refetchInterval: 30_000,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  return {
    status:          query.data?.status          ?? null,
    tripsToday:      query.data?.tripsToday      ?? null,
    chargingSummary: query.data?.chargingSummary ?? null,
    costSummary:     query.data?.costSummary     ?? null,
    health:          (query.data?.batteryHealth  as any) ?? null,
    drainStats:      (query.data?.vampireDrain   as any) ?? null,
    isLoading: query.isLoading,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['dashboard-full', vehicleId, rate] }),
  };
}
