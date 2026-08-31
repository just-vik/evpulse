import { create } from 'zustand';
import type { DataQuality } from '@/features/vehicles/useVehicleSummary';

export interface TelemetryPoint {
  vehicleId: string;
  batteryLevel: number;
  range: number;
  outsideTemp: number;
  chargingState: string;
  state: string;
  latitude?: number;
  longitude?: number;
  timestamp: string;
  // P1.2 telemetry freshness fix: these now arrive on every live 'telemetry'
  // WS event (apps/api/src/websockets/telemetry.gateway.ts), so the freshness
  // badge is no longer read only from the periodically-stale REST cache.
  // Optional in the type as a defensive fallback (e.g. an older cached
  // client build during a rolling deploy) — in practice always present.
  dataQuality?: DataQuality;
  dataFreshnessSec?: number | null;
  lastUpdate?: string | null;
}

interface TelemetryState {
  current: TelemetryPoint | null;
  connected: boolean;
  setConnected: (value: boolean) => void;
  update: (point: TelemetryPoint) => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  current: null,
  connected: false,
  setConnected: (value) => set({ connected: value }),
  update: (point) => set({ current: point }),
}));
