'use client';

import { useVehicleStatus } from './useVehicleStatus';

export type FreshnessState = 'realtime' | 'delayed' | 'stale' | 'offline';

export interface TelemetryFreshness {
  state: FreshnessState;
  lastEventAt: Date | null;
  latencyMs: number | null;
  cssClass: string;
  dotClass: string;
}

const STATE_CSS: Record<FreshnessState, { badge: string; dot: string }> = {
  realtime: { badge: 'freshness-realtime', dot: 'status-dot status-dot-online' },
  delayed:  { badge: 'freshness-delayed',  dot: 'status-dot status-dot-warning' },
  stale:    { badge: 'freshness-stale',    dot: 'status-dot status-dot-warning' },
  offline:  { badge: 'freshness-offline',  dot: 'status-dot status-dot-offline' },
};

export function useTelemetryFreshness(vehicleId: string | null): TelemetryFreshness {
  const { status } = useVehicleStatus(vehicleId);

  const dataQuality = (status as any)?.dataQuality as string | undefined;
  const dataFreshnessSec = (status as any)?.dataFreshnessSec as number | null | undefined;
  const lastUpdateStr = (status as any)?.lastUpdate as string | undefined;

  let state: FreshnessState = 'offline';
  if (dataQuality === 'REALTIME') state = 'realtime';
  else if (dataQuality === 'DELAYED') state = 'delayed';
  else if (dataQuality === 'STALE') state = 'stale';
  else if (status != null) state = 'offline';

  const lastEventAt = lastUpdateStr ? new Date(lastUpdateStr) : null;
  const latencyMs = dataFreshnessSec != null ? dataFreshnessSec * 1000 : null;
  const { badge, dot } = STATE_CSS[state];

  return { state, lastEventAt, latencyMs, cssClass: badge, dotClass: dot };
}
