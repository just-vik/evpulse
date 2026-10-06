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

    // Freshness and timestamps come from the backend envelope (dataQuality,
    // dataFreshnessSec, lastUpdate — set by TelemetryGateway from the telemetry
    // timestamp), never from the arrival of this message. Sensor fields in `data`
    // are patched only when present (diff emits carry changed fields only).
    function onTelemetry(payload: {
      data: Record<string, unknown>;
      dataQuality?: VehicleStatusResponse['dataQuality'];
      dataFreshnessSec?: number | null;
      lastUpdate?: string | null;
    }) {
      const { data } = payload;
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
      if (payload.dataQuality       != null) patch.dataQuality       = payload.dataQuality;
      if (payload.dataFreshnessSec  !== undefined) patch.dataFreshnessSec = payload.dataFreshnessSec;
      if (payload.lastUpdate        !== undefined) patch.lastUpdate       = payload.lastUpdate;
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

    // Backend announces the back-online transition only as a hint. It does not carry
    // an authoritative state, so the REST snapshot (which computes state and freshness)
    // is the only thing that gets written into the cache.
    function onVehicleOnline() {
      queryClient.invalidateQueries({ queryKey: ['vehicle-status', vehicleId] });
    }

    // A trip started or ended changes the derived trip state in the status snapshot and
    // the aggregates built from trips. Invalidate instead of patching: the server row is
    // the only source of truth for those values.
    function onTripLifecycle() {
      queryClient.invalidateQueries({ queryKey: ['vehicle-status', vehicleId] });
      queryClient.invalidateQueries({ queryKey: ['trips-today', vehicleId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-full', vehicleId] });
    }

    on('telemetry',      onTelemetry);
    on('vehicle:update', onVehicleUpdate);
    on('vehicle:online', onVehicleOnline);
    on('trip:started',   onTripLifecycle);
    on('trip:ended',     onTripLifecycle);

    return () => {
      off('telemetry',      onTelemetry);
      off('vehicle:update', onVehicleUpdate);
      off('vehicle:online', onVehicleOnline);
      off('trip:started',   onTripLifecycle);
      off('trip:ended',     onTripLifecycle);
      if (subscribedRef.current) {
        unsubscribeVehicle(subscribedRef.current);
        subscribedRef.current = null;
      }
    };
  }, [vehicleId, connect, subscribeVehicle, unsubscribeVehicle, on, off, queryClient]);

  return { wsConnected: connected };
}
