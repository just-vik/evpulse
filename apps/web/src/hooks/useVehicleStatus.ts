'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient, type VehicleStatusResponse } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { useTeslaTelemetry } from './useTeslaTelemetry'

export interface VehicleStatus extends VehicleStatusResponse {}

async function fetchStatus(
  vehicleId: string,
  token: string | null,
): Promise<VehicleStatus | null> {
  if (!vehicleId || !token) return null
  return apiClient.getVehicleStatus(vehicleId, token) as Promise<VehicleStatus>
}

export function useVehicleStatus(vehicleId: string | null) {
  const { accessToken } = useAuthStore()
  const queryClient = useQueryClient()

  // Subscribe to WebSocket — patches query cache on each push
  const { wsConnected } = useTeslaTelemetry(vehicleId)

  const query = useQuery({
    queryKey: ['vehicle-status', vehicleId],
    queryFn: () => fetchStatus(vehicleId!, accessToken),
    enabled: !!vehicleId && !!accessToken,
    // Slow down HTTP polling while WS is the primary source
    refetchInterval: wsConnected ? 30_000 : 5_000,
    staleTime: wsConnected ? 25_000 : 3_000,
    gcTime: 60_000,
    retry: 1,
  })

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    wsConnected,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['vehicle-status', vehicleId] }),
  }
}
