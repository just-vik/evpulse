'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient, type EfficiencyPredictionResponse } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'

export function useEfficiencyPrediction(vehicleId: string | null) {
  const { accessToken } = useAuthStore()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['efficiency-prediction', vehicleId],
    queryFn: () =>
      apiClient.getEfficiencyPrediction(
        vehicleId!,
        accessToken!,
      ),
    enabled: !!vehicleId && !!accessToken,
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    retry: 1,
  })

  return {
    prediction: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['efficiency-prediction', vehicleId] }),
  }
}

