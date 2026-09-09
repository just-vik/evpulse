/**
 * Read-only validation tool for the singleton-bridging route fix
 * (map-matching.service.ts / trip-post-processor.service.ts, 2026-09-09).
 *
 * Purpose: before running a real backfill against production trips, sample
 * a controlled mix of historical trips (sparse/normal/dense GPS, trips with
 * >120s gaps, short trips) and report what the NEW map-matching logic would
 * produce vs what is currently stored — without writing anything to the DB.
 *
 * NEVER calls prisma.trip.update / tripPoint.deleteMany / any write. Only
 * SELECTs against Postgres and read-only GET calls to OSRM.
 *
 * Usage (run inside the api container, where OSRM_URL/DATABASE_URL resolve):
 *   npx ts-node --transpile-only --compiler-options '{"experimentalDecorators":true}' \
 *     scripts/diagnose-route-quality.ts [tripId1 tripId2 ...]
 *
 * With no trip IDs given, auto-selects ~10 trips across five categories:
 * sparse / normal / dense GPS coverage, trips with a >120s real-GPS gap,
 * and short trips.
 *
 * Telemetry point terminology (four different numbers, easy to conflate):
 *   - rawTripPointRows:   every trip_points row for the trip, interpolated included.
 *   - nonInterpolatedRows: rows where interpolated=false — telemetry actually
 *                          reported a fix at that timestamp, but its lat/lon
 *                          can still be null (Fleet Telemetry sends a row for
 *                          a speed/power change even without a fresh GPS lock).
 *   - validGpsPoints:     the subset of nonInterpolatedRows with a real,
 *                         in-range, non-jump lat/lon — this is what actually
 *                         feeds MapMatchingService.match() (mapMatchInputPoints).
 *   - bridgePoints:       NOT raw telemetry at all — synthetic 2-point OSRM
 *                         /route legs created by bridgeSingletons() to
 *                         reconnect a validGpsPoint that got isolated by two
 *                         large gaps. Counted via singletonBridgeCount.
 * Earlier root-cause analysis for the Sulzbach→Wallau trip said "7 real GPS
 * fixes" — that was validGpsPoints. This script's nonInterpolatedRows for the
 * same trip is 15, because it also counts the 8 rows where telemetry reported
 * a speed/power update with no GPS lock (null lat/lon). Same trip, two
 * different — both correct — counts of two different things.
 */

import { PrismaClient } from '@prisma/client';
import { MapMatchingService } from '../src/maps/map-matching.service';
import { resolveRouteQuality, RouteQuality } from '../src/trips/route-quality.util';

// Instantiated lazily inside main() (CLI-only) rather than at module scope —
// constructing PrismaClient at import time breaks importing buildValidPoints()
// in isolation for tests (a test runner's module resolution may find a
// different generated client than the one this script's runtime uses).
let prisma: PrismaClient;
let mapMatching: MapMatchingService;

// ── Minimal duplicate of trip-post-processor Stage-1 GPS validity filter ────
// (jump filter: reject any point implying > 200 km/h from the previous one).
// Duplicated deliberately — this is a read-only diagnostic tool and must not
// call into the production pipeline's private, side-effecting methods.

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface RealPoint { lat: number; lon: number; ts: Date; }

// Exported so its coordinate-validity invariant (rows with interpolated=false
// but null lat/lon must never count as a valid GPS point) can be pinned by a
// regression test — see diagnose-route-quality.buildValidPoints.spec.ts.
export function buildValidPoints(rawPoints: { latitude: number | null; longitude: number | null; timestamp: Date; interpolated: boolean }[]): {
  nonInterpolatedRows: number;
  invalidCount: number;
  jumpCount: number;
  validPoints: RealPoint[];
  largestGapSeconds: number;
} {
  const nonInterpolated = rawPoints.filter(p => !p.interpolated);
  let invalidCount = 0;
  let jumpCount = 0;
  const validPoints: RealPoint[] = [];
  let prev: RealPoint | null = null;

  for (const p of nonInterpolated) {
    const lat = p.latitude, lon = p.longitude;
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) {
      invalidCount++;
      continue;
    }
    if (prev) {
      const dtMs = p.timestamp.getTime() - prev.ts.getTime();
      const distKm = haversineKm(prev.lat, prev.lon, lat, lon);
      if (dtMs > 0 && dtMs < 180_000) {
        const impliedKmh = distKm / (dtMs / 3_600_000);
        if (impliedKmh > 200) { jumpCount++; invalidCount++; continue; }
      }
    }
    const pt = { lat, lon, ts: p.timestamp };
    validPoints.push(pt);
    prev = pt;
  }

  let largestGapSeconds = 0;
  for (let i = 1; i < validPoints.length; i++) {
    const gap = (validPoints[i].ts.getTime() - validPoints[i - 1].ts.getTime()) / 1000;
    if (gap > largestGapSeconds) largestGapSeconds = gap;
  }

  return { nonInterpolatedRows: nonInterpolated.length, invalidCount, jumpCount, validPoints, largestGapSeconds };
}

// ── Polyline decode (duplicated from map-matching.service.ts — unexported there) ──

function decodePoly(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

const ENDPOINT_TOLERANCE_KM = 0.3; // 300 m

// ── Candidate selection (only used when no explicit trip IDs are given) ────

async function pickSampleTrips(): Promise<string[]> {
  const sparse = await prisma.$queryRaw<{ tripId: string }[]>`
    SELECT tp."tripId", count(*) FILTER (WHERE tp.interpolated = false AND tp.latitude IS NOT NULL) AS real_pts
    FROM trip_points tp
    JOIN trips t ON t.id = tp."tripId"
    WHERE t."endTime" IS NOT NULL
    GROUP BY tp."tripId"
    HAVING count(*) FILTER (WHERE tp.interpolated = false AND tp.latitude IS NOT NULL) BETWEEN 5 AND 10
    ORDER BY random() LIMIT 3`;

  const normal = await prisma.$queryRaw<{ tripId: string }[]>`
    SELECT tp."tripId", count(*) FILTER (WHERE tp.interpolated = false AND tp.latitude IS NOT NULL) AS real_pts
    FROM trip_points tp
    JOIN trips t ON t.id = tp."tripId"
    WHERE t."endTime" IS NOT NULL
    GROUP BY tp."tripId"
    HAVING count(*) FILTER (WHERE tp.interpolated = false AND tp.latitude IS NOT NULL) BETWEEN 11 AND 30
    ORDER BY random() LIMIT 3`;

  const dense = await prisma.$queryRaw<{ tripId: string }[]>`
    SELECT tp."tripId", count(*) FILTER (WHERE tp.interpolated = false AND tp.latitude IS NOT NULL) AS real_pts
    FROM trip_points tp
    JOIN trips t ON t.id = tp."tripId"
    WHERE t."endTime" IS NOT NULL
    GROUP BY tp."tripId"
    HAVING count(*) FILTER (WHERE tp.interpolated = false AND tp.latitude IS NOT NULL) > 30
    ORDER BY random() LIMIT 2`;

  const bigGap = await prisma.$queryRaw<{ tripId: string }[]>`
    WITH real_pts AS (
      SELECT "tripId", timestamp,
        timestamp - lag(timestamp) OVER (PARTITION BY "tripId" ORDER BY timestamp) AS gap
      FROM trip_points WHERE interpolated = false AND latitude IS NOT NULL
    )
    SELECT "tripId", max(extract(epoch FROM gap)) AS max_gap_s
    FROM real_pts GROUP BY "tripId"
    HAVING max(extract(epoch FROM gap)) > 120
    ORDER BY random() LIMIT 2`;

  const short = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM trips
    WHERE "endTime" IS NOT NULL AND "distanceKm" IS NOT NULL AND "distanceKm" < 2
    ORDER BY random() LIMIT 2`;

  const ids = [
    ...sparse.map(r => r.tripId),
    ...normal.map(r => r.tripId),
    ...dense.map(r => r.tripId),
    ...bigGap.map(r => r.tripId),
    ...short.map(r => r.id),
  ];
  return Array.from(new Set(ids));
}

// ── Per-trip diagnosis (read-only) ──────────────────────────────────────────

async function diagnoseTrip(tripId: string) {
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) return { tripId, error: 'trip not found' };

  const rawPoints = await prisma.tripPoint.findMany({
    where: { tripId },
    orderBy: { timestamp: 'asc' },
    select: { latitude: true, longitude: true, timestamp: true, interpolated: true },
  });

  const { nonInterpolatedRows, invalidCount, jumpCount, validPoints, largestGapSeconds } = buildValidPoints(rawPoints);
  // mapMatchInputPoints: an alias for validPoints.length, named for what it
  // actually is — the exact array passed into MapMatchingService.match() below.
  const mapMatchInputPoints = validPoints.length;

  const durationS = trip.endTime ? (trip.endTime.getTime() - trip.startTime.getTime()) / 1000 : null;

  const before = {
    distanceKm: trip.distanceKm,
    routeType: trip.routeType,
    reliability: trip.reliability,
    qualityScore: trip.qualityScore,
    repairReason: trip.repairReason,
  };

  if (validPoints.length < 2) {
    return {
      tripId, durationS, nonInterpolatedRows, validGpsPoints: mapMatchInputPoints, invalidCount, jumpCount, largestGapSeconds,
      before, after: null, routeQuality: 'UNAVAILABLE' as RouteQuality,
      note: 'fewer than 2 valid GPS points — match() not attempted (matches production gap-recovery path)',
    };
  }

  let osrmError: string | null = null;
  const result = await mapMatching
    .match(validPoints.map(p => ({ lat: p.lat, lon: p.lon, timestamp: p.ts })))
    .catch((e: Error) => { osrmError = e.message; return null; });

  const reconstructedDistancePercent = result && result.distanceKm > 0
    ? Math.round((result.routedDistanceKm / result.distanceKm) * 1000) / 10
    : result ? 0 : null;

  // NOTE: resolveRouteQuality's `rawGpsPointsCount` param is documented as
  // "non-interpolated, non-null" fixes — i.e. mapMatchInputPoints here, not
  // nonInterpolatedRows (which can include telemetry rows with a null lat/lon).
  // Passing the wrong one would make trips with many null-coordinate rows
  // look artificially well-covered.
  const routeQuality = resolveRouteQuality({
    rawGpsPointsCount: mapMatchInputPoints,
    singletonBridgesCount: result?.singletonBridgeCount ?? 0,
    largestGapSeconds,
    reconstructedDistancePercent: reconstructedDistancePercent ?? 100,
  });

  // Mirror trip-post-processor's osrmOk gate: OSRM's raw distance is only
  // ever applied when it agrees with the odometer-preferred reference within
  // 15–30% — otherwise distanceKm stays exactly as it is today. Reporting
  // result.distanceKm alone (as "after") would misleadingly suggest distance
  // changes on every trip, when in production it usually doesn't.
  const usedNonGps = /distance_from_odometer|distance_hybrid/.test(before.repairReason ?? '');
  const reference = before.distanceKm;
  const osrmOk = result
    ? (reference ? result.distanceKm >= reference * 0.85 && result.distanceKm <= reference * 1.30 : result.distanceKm > 0)
    : false;
  let finalDistanceKmPreview = before.distanceKm;
  if (result && osrmOk) {
    finalDistanceKmPreview = (!usedNonGps || validPoints.length >= 10)
      ? result.distanceKm
      : (reference != null ? Math.round((result.distanceKm + reference) / 2 * 10) / 10 : result.distanceKm);
  }

  let startPreservedKm: number | null = null;
  let endPreservedKm: number | null = null;
  if (result) {
    const decoded = decodePoly(result.polyline);
    if (decoded.length >= 1) {
      const [flat, flon] = decoded[0];
      const [llat, llon] = decoded[decoded.length - 1];
      startPreservedKm = Math.round(haversineKm(validPoints[0].lat, validPoints[0].lon, flat, flon) * 1000) / 1000;
      endPreservedKm = Math.round(
        haversineKm(validPoints[validPoints.length - 1].lat, validPoints[validPoints.length - 1].lon, llat, llon) * 1000,
      ) / 1000;
    }
  }

  return {
    tripId,
    vehicleId: trip.vehicleId,
    durationS,
    nonInterpolatedRows,      // telemetry rows with interpolated=false — may include null lat/lon
    validGpsPoints: mapMatchInputPoints, // coordinate-valid, jump-filtered — what OSRM actually received
    invalidCount,             // nonInterpolatedRows rejected for null/out-of-range coords
    jumpCount,                // of invalidCount, how many specifically failed the >200km/h jump filter
    largestGapSeconds: Math.round(largestGapSeconds),
    before,
    after: result ? {
      osrmDistanceKm: result.distanceKm,           // raw OSRM output — NOT necessarily applied
      distanceKmWouldApply: finalDistanceKmPreview, // what production would actually persist
      distanceKmChanged: finalDistanceKmPreview !== before.distanceKm,
      type: result.type,
      segmentCount: result.segmentCount,
      singletonBridgeCount: result.singletonBridgeCount, // bridgePoints — synthetic, not raw telemetry
      matchedDistanceKm: result.matchedDistanceKm,
      routedDistanceKm: result.routedDistanceKm,
      reconstructedDistancePercent,
    } : null,
    osrmError,
    routeQuality,
    startPreservedKm,
    endPreservedKm,
    startPreserved: startPreservedKm != null ? startPreservedKm <= ENDPOINT_TOLERANCE_KM : null,
    endPreserved: endPreservedKm != null ? endPreservedKm <= ENDPOINT_TOLERANCE_KM : null,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  prisma = new PrismaClient();
  mapMatching = new MapMatchingService();

  const explicitIds = process.argv.slice(2);
  const tripIds = explicitIds.length ? explicitIds : await pickSampleTrips();

  console.log(`\nDiagnosing ${tripIds.length} trip(s) — READ-ONLY, no DB writes, no prisma.trip.update calls.\n`);

  const rows: any[] = [];
  for (const id of tripIds) {
    const row = await diagnoseTrip(id);
    rows.push(row);
    console.log(JSON.stringify(row, null, 2));
  }

  console.log('\n─── Summary ───────────────────────────────────────────────\n');
  console.table(rows.map(r => ({
    tripId: r.tripId,
    validGpsPts: r.validGpsPoints,
    maxGapS: r.largestGapSeconds,
    bridges: r.after?.singletonBridgeCount ?? '-',
    segments: r.after?.segmentCount ?? '-',
    beforeDistKm: r.before?.distanceKm ?? '-',
    distanceChanges: r.after?.distanceKmChanged ?? '-',
    beforeRouteType: r.before?.routeType ?? '-',
    afterRouteType: r.after?.type ?? (r.osrmError ? 'ERROR' : 'n/a'),
    routeQuality: r.routeQuality,
    startOk: r.startPreserved,
    endOk: r.endPreserved,
  })));

  const safe = rows.filter(r => r.after && r.startPreserved !== false && r.endPreserved !== false && !r.osrmError);
  const needsAttention = rows.filter(r => !safe.includes(r));

  console.log(`\nSafe to apply real backfill (${safe.length}): ${safe.map(r => r.tripId).join(', ') || '(none)'}`);
  console.log(`Needs attention before backfill (${needsAttention.length}): ${needsAttention.map(r => r.tripId).join(', ') || '(none)'}`);

  await prisma.$disconnect();
}

// Guarded so importing this module (e.g. from a test, to exercise
// buildValidPoints in isolation) never opens a DB connection or calls OSRM —
// main() only runs when the file is executed directly as a CLI script.
if (require.main === module) {
  main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
}
