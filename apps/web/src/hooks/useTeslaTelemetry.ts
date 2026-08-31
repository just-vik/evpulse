'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from './useWebSocket';
import type { VehicleStatusResponse } from '@/lib/api';

/**
 * Subscribes to vehicle WebSocket room and patches the React Query cache
 * for ['vehicle-status', vehicleId] whenever telemetry or state events arrive.
 * Mount alongside useVehicleStatus — no extra renders, no returned value needed.
 */
export function useTeslaTelemetry(vehicleId: string | null) {
  const queryClient = useQueryClient();
  const { connect, subscribeVehicle, unsubscribeVehicle, on, off, connected } = useWebSocket({
    autoConnect: true,
  });
  const subscribedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!vehicleId) return;

    connect();
    subscribeVehicle(vehicleId);
    subscribedRef.current = vehicleId;

    function patchCache(patch: Partial<VehicleStatusResponse>) {
      queryClient.setQueryData<VehicleStatusResponse>(
        ['vehicle-status', vehicleId],
        (prev) => {
          if (!prev) return prev;
          return { ...prev, ...patch };
        },
      );
    }

    function onTelemetry({ data }: { data: Record<string, unknown> }) {
      const patch: Partial<VehicleStatusResponse> = {};
      if (data.soc            != null) patch.soc            = Number(data.soc);
      if (data.speed          != null) patch.speed          = Number(data.speed);
      if (data.power          != null) patch.power          = Number(data.power);
      if (data.batteryTemp    != null) patch.batteryTemp    = Number(data.batteryTemp);
      if (data.outsideTemp    != null) patch.outsideTemp    = Number(data.outsideTemp);
      if (data.insideTemp     != null) patch.insideTemp     = Number(data.insideTemp);
      if (data.odometer       != null) patch.odometer       = Number(data.odometer);
      if (data.batteryRangeKm != null) patch.batteryRangeKm = Number(data.batteryRangeKm);
      if (data.locked         != null) patch.locked         = Boolean(data.locked);
      if (data.vehicleState   != null) patch.vehicleState   = String(data.vehicleState);
      if (data.chargingState  != null) patch.chargingState  = String(data.chargingState);
      if (data.lastUpdate     != null) patch.lastUpdate     = String(data.lastUpdate);
      if (data.timestamp      != null) patch.lastUpdate     = String(data.timestamp);
      // Mark data as fresh when WS push arrives
      patch.dataQuality    = 'REALTIME';
      patch.dataFreshnessSec = 0;
      patchCache(patch);
    }

    function onVehicleUpdate({ data }: { data: Record<string, unknown> }) {
      const patch: Partial<VehicleStatusResponse> = {};
      if (data.state         != null) patch.vehicleState  = String(data.state);
      if (data.vehicleState  != null) patch.vehicleState  = String(data.vehicleState);
      if (data.chargingState != null) patch.chargingState = String(data.chargingState);
      if (data.locked        != null) patch.locked        = Boolean(data.locked);
      patchCache(patch);
    }

    function onVehicleOnline({ dataQuality }: { dataQuality: string }) {
      patchCache({
        vehicleState: 'online',
        dataQuality: (dataQuality as VehicleStatusResponse['dataQuality']) ?? 'REALTIME',
        isOnline: true,
      });
      // Refresh from HTTP once to pull full state after reconnect
      queryClient.invalidateQueries({ queryKey: ['vehicle-status', vehicleId] });
    }

    on('telemetry',      onTelemetry);
    on('vehicle:update', onVehicleUpdate);
    on('vehicle:online', onVehicleOnline);

    return () => {
      off('telemetry',      onTelemetry);
      off('vehicle:update', onVehicleUpdate);
      off('vehicle:online', onVehicleOnline);
      if (subscribedRef.current) {
        unsubscribeVehicle(subscribedRef.current);
        subscribedRef.current = null;
      }
    };
  }, [vehicleId, connect, subscribeVehicle, unsubscribeVehicle, on, off, queryClient]);

  return { wsConnected: connected };
}
