import { useMemo } from 'react';

function pctDelta(current: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((current - prev) / Math.abs(prev)) * 100;
}

// ─── Trips ────────────────────────────────────────────────────────────────────

interface TripItem {
  startTime: string;
  distanceKm: number | null;
  energyUsedKwh: number | null;
  efficiencyWhkm: number | null;
  costTotal: number | null;
}

export interface TripsPeriodDeltas {
  count: number | null;
  totalDist: number | null;
  totalEnergy: number | null;
  totalCost: number | null;
  avgEffWhkm: number | null;
}

function aggregateTrips(items: TripItem[]) {
  const effs = items.filter(t => t.efficiencyWhkm != null && t.efficiencyWhkm > 0).map(t => t.efficiencyWhkm!);
  return {
    count: items.length,
    totalDist: items.reduce((s, t) => s + (t.distanceKm ?? 0), 0),
    totalEnergy: items.reduce((s, t) => s + (t.energyUsedKwh ?? 0), 0),
    totalCost: items.reduce((s, t) => s + (t.costTotal ?? 0), 0),
    avgEffWhkm: effs.length ? effs.reduce((a, b) => a + b) / effs.length : 0,
  };
}

export function useTripsPeriodStats(completed: TripItem[]): TripsPeriodDeltas | null {
  return useMemo(() => {
    if (completed.length < 6) return null;
    const sorted = [...completed].sort((a, b) => a.startTime.localeCompare(b.startTime));
    const mid = Math.floor(sorted.length / 2);
    const prev = aggregateTrips(sorted.slice(0, mid));
    const curr = aggregateTrips(sorted.slice(mid));
    return {
      count:       pctDelta(curr.count,       prev.count),
      totalDist:   pctDelta(curr.totalDist,   prev.totalDist),
      totalEnergy: pctDelta(curr.totalEnergy, prev.totalEnergy),
      totalCost:   pctDelta(curr.totalCost,   prev.totalCost),
      avgEffWhkm:  pctDelta(curr.avgEffWhkm,  prev.avgEffWhkm),
    };
  }, [completed]);
}

// ─── Charging ─────────────────────────────────────────────────────────────────

interface ChargingItem {
  startTime: string;
  endTime: string | null;
  energyAddedKwh: number | null;
  costTotal: number | null;
  manualCost: number | null;
}

export interface ChargingPeriodDeltas {
  count: number | null;
  totalEnergy: number | null;
  totalCost: number | null;
  avgPerSession: number | null;
}

function aggregateCharging(items: ChargingItem[]) {
  const energy = items.reduce((s, c) => s + (c.energyAddedKwh != null ? Number(c.energyAddedKwh) : 0), 0);
  const cost   = items.reduce((s, c) => {
    const v = c.manualCost ?? c.costTotal;
    return s + (v != null ? Number(v) : 0);
  }, 0);
  return {
    count:          items.length,
    totalEnergy:    energy,
    totalCost:      cost,
    avgPerSession:  items.length > 0 ? energy / items.length : 0,
  };
}

export function useChargingPeriodStats(sessions: ChargingItem[]): ChargingPeriodDeltas | null {
  return useMemo(() => {
    const completed = sessions.filter(s => s.endTime != null);
    if (completed.length < 6) return null;
    const sorted = [...completed].sort((a, b) => a.startTime.localeCompare(b.startTime));
    const mid = Math.floor(sorted.length / 2);
    const prev = aggregateCharging(sorted.slice(0, mid));
    const curr = aggregateCharging(sorted.slice(mid));
    return {
      count:          pctDelta(curr.count,          prev.count),
      totalEnergy:    pctDelta(curr.totalEnergy,    prev.totalEnergy),
      totalCost:      pctDelta(curr.totalCost,      prev.totalCost),
      avgPerSession:  pctDelta(curr.avgPerSession,  prev.avgPerSession),
    };
  }, [sessions]);
}
