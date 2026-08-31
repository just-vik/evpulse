import { ConfigService } from '@nestjs/config';

/**
 * Haversine для reconciler: при невалидных числах / диапазонах возвращает null (никогда NaN).
 * (0,0) для одной из точек считаем недостоверным для авто (часто «пустой» GPS).
 */
export function haversineKmMerge(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number | null {
  if (![lat1, lon1, lat2, lon2].every((x) => typeof x === 'number' && Number.isFinite(x))) {
    return null;
  }
  if (Math.abs(lat1) > 90 || Math.abs(lat2) > 90) return null;
  if (Math.abs(lon1) > 180 || Math.abs(lon2) > 180) return null;
  if ((lat1 === 0 && lon1 === 0) || (lat2 === 0 && lon2 === 0)) return null;

  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const dist = R * c;
  return Number.isFinite(dist) && dist >= 0 ? dist : null;
}

/**
 * Shared merge rules for TripReconcilerService and TripCleanupService (auto-merge).
 * Multi-stop outings (P между точками) должны склеиваться, если разрыв не «ночной»
 * и конец A географически близок к началу B.
 */
export function tripReconcileMaxGapMs(config?: ConfigService): number {
  const raw = config?.get<string>('TRIP_RECONCILE_MAX_GAP_MS') ?? process.env.TRIP_RECONCILE_MAX_GAP_MS;
  const n = Number(raw);
  // Default 10 min (was 30 min — caused genuine parking stops of 7–29 min to be merged
  // into preceding trips; was 6 h before that). 10 min aligns with FORCE_END_GAP_MS:
  // signal-loss splits produce exactly a ~10 min gap and still get healed, while genuine
  // parking stops (>10 min) are correctly kept as separate trips. Supercharger stops
  // (20–45 min) are guarded separately via hasChargingBetween.
  return Number.isFinite(n) && n >= 120_000 ? n : 10 * 60 * 1000;
}

export function tripReconcileMaxProximityKm(config?: ConfigService): number {
  const raw = config?.get<string>('TRIP_RECONCILE_MAX_PROXIMITY_KM') ?? process.env.TRIP_RECONCILE_MAX_PROXIMITY_KM;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/** Разрывы ≤ этого порога считаем «светофорными» — склеиваем даже при большом расхождении GPS между концом A и началом B. */
export function tripReconcileShortGapMs(config?: ConfigService): number {
  const raw = config?.get<string>('TRIP_RECONCILE_SHORT_GAP_MS') ?? process.env.TRIP_RECONCILE_SHORT_GAP_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 30_000 ? n : 3 * 60_000;
}

/**
 * Max allowed [from, to] span for a single rebuild/dryRun request — resource-protection
 * guard, unrelated to billing entitlements (see clampDateRange in billing/entitlements.helper.ts
 * for that). A wide-open range would replay years of raw telemetry through the detector
 * (rebuild) or scan years of trips (dryRun) in one request and could stall the worker/DB.
 */
export function tripRebuildMaxRangeDays(config?: ConfigService): number {
  const raw = config?.get<string>('TRIP_REBUILD_MAX_RANGE_DAYS') ?? process.env.TRIP_REBUILD_MAX_RANGE_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 45;
}
