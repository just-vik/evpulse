'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'

function getWeekStart(): Date {
  const now = new Date()
  const day = now.getDay() // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(now)
  monday.setDate(now.getDate() + diff)
  monday.setHours(0, 0, 0, 0)
  return monday
}

function getWeekEnd(): Date {
  const monday = getWeekStart()
  const nextMonday = new Date(monday)
  nextMonday.setDate(monday.getDate() + 7)
  return nextMonday
}

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

  const now = new Date()
  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthTo   = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const monthKey  = `${now.getFullYear()}-${now.getMonth()}`

  const query = useQuery({
    queryKey: ['cost-summary', vehicleId, rate ?? null, monthKey],
    queryFn: () => apiClient.getCostSummary(vehicleId!, rate, accessToken!, { from: monthFrom, to: monthTo }),
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
    refresh: () => queryClient.invalidateQueries({ queryKey: ['cost-summary', vehicleId] }),
  }
}

export function useTripsThisWeek(vehicleId: string | null) {
  const { accessToken } = useAuthStore()
  const queryClient = useQueryClient()

  const weekStart = getWeekStart()
  const weekEnd   = getWeekEnd()

  const query = useQuery({
    queryKey: ['trips-week', vehicleId, weekStart.toISOString()],
    queryFn: () => apiClient.getTripsToday(vehicleId!, accessToken!, { from: weekStart, to: weekEnd }),
    enabled: !!vehicleId && !!accessToken,
    refetchInterval: 60_000,
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    retry: 1,
  })

  return {
    tripsThisWeek: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    weekStart,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['trips-week', vehicleId] }),
  }
}

export function useChargingThisWeek(vehicleId: string | null) {
  const { accessToken } = useAuthStore()
  const queryClient = useQueryClient()

  const weekStart = getWeekStart()
  const weekEnd   = getWeekEnd()

  const query = useQuery({
    queryKey: ['charging-week', vehicleId, weekStart.toISOString()],
    queryFn: () => apiClient.getChargingSummary(vehicleId!, accessToken!, { from: weekStart, to: weekEnd }),
    enabled: !!vehicleId && !!accessToken,
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    gcTime: 15 * 60_000,
    retry: 1,
  })

  return {
    chargingThisWeek: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    weekStart,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['charging-week', vehicleId] }),
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


