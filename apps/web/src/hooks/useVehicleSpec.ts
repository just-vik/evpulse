'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient, type VehicleSpecResponse } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'

export function useVehicleSpec(vehicleId: string | null) {
  const { accessToken } = useAuthStore()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['vehicle-spec', vehicleId],
    queryFn: () => apiClient.getVehicleSpec(vehicleId!, accessToken!),
    enabled: !!vehicleId && !!accessToken,
    refetchInterval: 10 * 60_000,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
  })

  return {
    spec: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['vehicle-spec', vehicleId] }),
  }
}

