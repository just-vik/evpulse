'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient, type CostForecastResponse } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'

export function useCostForecast(
  vehicleId: string | null,
  pricePerKwhOverride?: number,
) {
  const { accessToken } = useAuthStore()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['cost-forecast', vehicleId, pricePerKwhOverride ?? null],
    queryFn: () =>
      apiClient.getCostForecast(
        vehicleId!,
        accessToken!,
        pricePerKwhOverride,
      ),
    enabled: !!vehicleId && !!accessToken,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: 1,
  })

  return {
    forecast: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['cost-forecast', vehicleId, pricePerKwhOverride ?? null] }),
  }
}

