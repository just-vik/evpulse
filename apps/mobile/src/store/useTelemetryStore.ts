import { create } from 'zustand';

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
