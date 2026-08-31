'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import type { BatteryHealth } from '@/types/api'

export function useBatteryHealth(vehicleId: string | null) {
  const { accessToken } = useAuthStore()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['battery-health', vehicleId],
    queryFn: () => apiClient.getBatteryHealth(vehicleId!, accessToken!),
    enabled: !!vehicleId && !!accessToken,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
  })

  return {
    health: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['battery-health', vehicleId] }),
  }
}

