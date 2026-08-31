import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { API_ORIGIN } from '@/services/api';
import { useTelemetryStore, type TelemetryPoint } from '@/store/useTelemetryStore';
import { useAuthStore } from '@/store/authStore';
import { useVehicleStore } from '@/store/useVehicleStore';
import type { DataQuality } from '@/features/vehicles/useVehicleSummary';

const CACHE_KEY = 'telemetry_last_24h';
const MAX_POINTS = 500;

function mapPatch(
  vehicleId: string,
  prev: TelemetryPoint | null,
  data: Record<string, unknown> | undefined,
  ts: string,
): TelemetryPoint {
  const soc = typeof data?.soc === 'number' ? data.soc : prev?.batteryLevel ?? 0;
  const range =
    typeof data?.batteryRangeKm === 'number'
      ? data.batteryRangeKm
      : prev?.range ?? 0;
  const outsideTemp =
    typeof data?.outsideTemp === 'number'
      ? data.outsideTemp
      : prev?.outsideTemp ?? 0;
  const chargingState =
    typeof data?.chargingState === 'string'
      ? data.chargingState
      : prev?.chargingState ?? 'Unknown';
  const state =
    typeof data?.vehicleState === 'string'
      ? data.vehicleState
      : prev?.state ?? 'Unknown';
  const lat =
    typeof data?.latitude === 'number'
      ? data.latitude
      : typeof data?.lat === 'number'
        ? data.lat
        : prev?.latitude;
  const lng =
    typeof data?.longitude === 'number'
      ? data.longitude
      : typeof data?.lng === 'number'
        ? data.lng
        : prev?.longitude;

  return {
    vehicleId,
    batteryLevel: soc,
    range,
    outsideTemp,
    chargingState,
    state,
    latitude: lat,
    longitude: lng,
    timestamp: ts,
  };
}

async function persistSnapshot(point: TelemetryPoint) {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    const list: TelemetryPoint[] = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const next = [...list, point]
      .filter((p) => new Date(p.timestamp).getTime() > cutoff)
      .slice(-MAX_POINTS);
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function useTelemetrySocket() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const vehicleId = useVehicleStore((s) => s.selectedVehicleId);
  const update = useTelemetryStore((s) => s.update);
  const setConnected = useTelemetryStore((s) => s.setConnected);
  const socketRef = useRef<Socket | null>(null);
  const queryClient = useQueryClient();
  // Distinguishes the very first connect (REST already covers first load)
  // from a reconnect (socket dropped and came back — e.g. app was
  // backgrounded) — only the latter triggers the one-off status refetch.
  const hasConnectedOnceRef = useRef(false);

  useEffect(() => {
    if (!accessToken) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
      hasConnectedOnceRef.current = false;
      return;
    }

    const socket = io(`${API_ORIGIN}/telemetry`, {
      auth: { token: accessToken },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 3000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      if (hasConnectedOnceRef.current) {
        // Reconnect, not first mount. GET /vehicles/:id/status makes no
        // Tesla API call — it's a DB/Redis-only read (verified against
        // apps/api/src/analytics/vehicle-analytics.service.ts) — so one
        // extra invalidation here costs nothing on the Tesla side. Only
        // refetches immediately if the query is actually mounted/observed
        // right now; otherwise just marks it stale for next mount.
        void queryClient.invalidateQueries({ queryKey: ['vehicle-status'] });
      }
      hasConnectedOnceRef.current = true;
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on(
      'telemetry',
      (payload: {
        vehicleId: string;
        data?: Record<string, unknown>;
        timestamp?: string;
        lastUpdate?: string | null;
        dataQuality?: DataQuality;
        dataFreshnessSec?: number | null;
      }) => {
        if (!payload?.vehicleId) return;
        const ts = payload.timestamp ?? new Date().toISOString();
        const prev = useTelemetryStore.getState().current;
        const patched = mapPatch(payload.vehicleId, prev, payload.data, ts);
        // Freshness envelope fields — always present on real emits (see
        // apps/api/src/websockets/telemetry.gateway.ts); carry-forward
        // fallback only for defensive safety against an older payload shape.
        const next: TelemetryPoint = {
          ...patched,
          dataQuality: payload.dataQuality ?? prev?.dataQuality ?? 'OFFLINE',
          dataFreshnessSec: payload.dataFreshnessSec ?? null,
          lastUpdate: payload.lastUpdate ?? prev?.lastUpdate ?? null,
        };
        update(next);
        void persistSnapshot(next);
      },
    );

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [accessToken, setConnected, update, queryClient]);

  useEffect(() => {
    const s = socketRef.current;
    if (!vehicleId || !accessToken || !s) return;

    const subscribe = () => {
      if (s.connected) s.emit('subscribe:vehicle', { vehicleId });
    };
    subscribe();
    s.on('connect', subscribe);
    return () => {
      s.off('connect', subscribe);
      if (s.connected) s.emit('unsubscribe:vehicle', { vehicleId });
    };
  }, [vehicleId, accessToken]);
}
