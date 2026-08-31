'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'

export interface TripsTodaySummary {
  vehicleId:      string
  tripCount:      number
  distanceKm:     number
  energyKwh:      number
  efficiencyWhKm: number | null
}

export interface ChargingSummary {
  vehicleId:      string
  sessions:       number
  energyKwh:      number
  avgSessionKwh:  number | null
}

export interface CostSummary {
  vehicleId:   string
  period:      { startDate: string; endDate: string }
  energyKwh:   number
  totalCost:   number
  costPerKm:   number | null
  sessions:    number
  pricePerKwh: number
}

export function useTripsToday(vehicleId: string | null) {
  const { accessToken } = useAuthStore()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['trips-today', vehicleId],
    queryFn: () => apiClient.getTripsToday(vehicleId!, accessToken!),
    enabled: !!vehicleId && !!accessToken,
    refetchInterval: 60_000,
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    retry: 1,
  })

  return {
    tripsToday: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['trips-today', vehicleId] }),
  }
}

export function useChargingSummary(vehicleId: string | null) {
  const { accessToken } = useAuthStore()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['charging-summary', vehicleId],
    queryFn: () => apiClient.getChargingSummary(vehicleId!, accessToken!),
    enabled: !!vehicleId && !!accessToken,
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    gcTime: 15 * 60_000,
    retry: 1,
  })

  return {
    chargingSummary: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['charging-summary', vehicleId] }),
  }
}

export function useCostSummary(vehicleId: string | null, rate?: number) {
  const { accessToken } = useAuthStore()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['cost-summary', vehicleId, rate ?? null],
    queryFn: () => apiClient.getCostSummary(vehicleId!, rate, accessToken!),
    enabled: !!vehicleId && !!accessToken,
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    gcTime: 15 * 60_000,
    retry: 1,
  })

  return {
    costSummary: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['cost-summary', vehicleId, rate ?? null] }),
  }
}

export function useVehicleAggregates(vehicleId: string | null) {
  const trips    = useTripsToday(vehicleId)
  const charging = useChargingSummary(vehicleId)
  const cost     = useCostSummary(vehicleId)

  return {
    trips,
    charging,
    cost,
    isLoading: trips.isLoading || charging.isLoading || cost.isLoading,
  }
}


