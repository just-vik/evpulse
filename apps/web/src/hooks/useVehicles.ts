'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from './useAuth';
import { useUIStore } from '@/stores/uiStore';
import { useLayoutStore } from '@/stores/layout.store';
import { apiClient } from '@/lib/api';
import { Vehicle, VehicleCommand } from '@/types/api';

/**
 * Hook to fetch all vehicles
 */
export function useVehicles() {
  const { accessToken } = useAuth();

  const query = useQuery({
    queryKey: ['vehicles'],
    queryFn: async () => {
      if (!accessToken) throw new Error('Not authenticated');
      return await apiClient.getVehicles(accessToken);
    },
    enabled: !!accessToken,
    staleTime: 1000 * 60, // 1 minute
    gcTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
  });

  return query;
}

/**
 * Hook to fetch a single vehicle
 */
export function useVehicle(vehicleId: string | null | undefined) {
  const { accessToken } = useAuth();

  const query = useQuery({
    queryKey: ['vehicles', vehicleId],
    queryFn: async () => {
      if (!accessToken || !vehicleId) throw new Error('Invalid params');
      return await apiClient.getVehicle(vehicleId, accessToken);
    },
    enabled: !!accessToken && !!vehicleId,
    staleTime: 1000 * 30, // 30 seconds
    gcTime: 1000 * 60 * 5, // 5 minutes
  });

  return query;
}

/**
 * Hook to send vehicle commands
 */
export function useVehicleCommand() {
  const { accessToken } = useAuth();
  const queryClient = useQueryClient();
  const addToast = useUIStore((state) => state.addToast);
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: async ({
      vehicleId,
      command,
      params = {},
    }: {
      vehicleId: string;
      command: string;
      params?: Record<string, any>;
    }) => {
      if (!accessToken) throw new Error('Not authenticated');
      return await apiClient.sendVehicleCommand(vehicleId, command, params, accessToken);
    },

    onSuccess: (_data: VehicleCommand) => {
      queryClient.invalidateQueries({ queryKey: ['vehicles'] });
      addToast('success', t('vehicleDetail.commands.success'), 3000);
    },

    onError: (error: Error) => {
      console.error('Command failed:', error);
      addToast('error', error.message || t('vehicleDetail.commands.failed'), 3000);
    },
  });

  return mutation;
}

/**
 * Hook to monitor a single vehicle with adaptive polling interval.
 * Named differently from hooks/useVehicleStatus.ts (React Query, one-shot)
 * to avoid confusion when importing directly from this file.
 */
export function useVehiclePolling(vehicleId: string | null | undefined) {
  const { data: vehicle, isLoading, error, refetch } = useVehicle(vehicleId);
  const [, setUpdateInterval] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!vehicle) return;

    // Auto-refresh based on vehicle state
    let interval = 30 * 1000; // 30 seconds

    if (vehicle.vehicleState === 'online') {
      interval = 10 * 1000; // 10 seconds if online
    }

    if (vehicle.chargingState === 'charging' || vehicle.chargingState === 'discharging') {
      interval = 5 * 1000; // 5 seconds if actively charging/discharging
    }

    const timer = setInterval(() => {
      refetch();
    }, interval);

    setUpdateInterval(timer);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [vehicle, refetch]);

  return {
    vehicle,
    isLoading,
    error,
    refetch,
  };
}

/**
 * Hook to get all vehicles with their current status
 */
export function useAllVehiclesStatus() {
  const { data: vehicles, isLoading, error, refetch } = useVehicles();

  // Auto-refresh vehicles
  useEffect(() => {
    const interval = setInterval(() => {
      refetch();
    }, 10 * 1000); // 10 seconds

    return () => clearInterval(interval);
  }, [refetch]);

  return {
    vehicles: vehicles || [],
    isLoading,
    error,
    totalVehicles: vehicles?.length || 0,
    totalBattery: vehicles
      ? Math.round(vehicles.reduce((sum, v) => sum + ((v as any).batteryLevel ?? 0), 0) / vehicles.length)
      : 0,
    chargingCount: vehicles?.filter((v) => (v.chargingState ?? '').toLowerCase() === 'charging').length || 0,
    offlineCount: vehicles?.filter((v) => (v.vehicleState ?? '').toLowerCase() === 'offline').length || 0,
  };
}

/**
 * Hook to select a vehicle and monitor its status
 */
export function useSelectedVehicle() {
  const selectedVehicleId = useLayoutStore((state) => state.selectedVehicleId);
  const setSelectedVehicleId = useLayoutStore((state) => state.setSelectedVehicleId);

  const { vehicle, isLoading, error } = useVehiclePolling(selectedVehicleId);

  return {
    vehicle,
    isLoading,
    error,
    selectedVehicleId,
    setSelectedVehicleId,
  };
}
