import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';

// ─────────────────────── Shared types ────────────────────────────────────────

export interface BufferedPoint {
  timestamp:    Date;
  speed:        number;
  power:        number | null;
  soc:          number | null;
  latitude:     number | null;
  longitude:    number | null;
  /** Kalman-smoothed coordinates (persisted to smooth_lat / smooth_lng) */
  smoothLat?:   number | null;
  smoothLng?:   number | null;
  elevationM:   number | null;
  interpolated: boolean;
}

export type QualityLabel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface TripQuality {
  score:         number;       // 0–100
  label:         QualityLabel;
  gaps:          number;       // count of gaps > 60 s
  signalLossSec: number;       // total seconds with no telemetry
  interpolated:  number;       // synthetic points inserted
}

export interface LiveTripStats {
  distanceKm:     number;
  durationMin:    number;
  energyKwh:      number;
  efficiencyWhkm: number | null;
  avgSpeedKmh:    number | null;
  quality:        TripQuality;
}

export interface TripBuffer {
  vehicleId:     string;
  dbTripId:      string | null;
  startTime:     string;        // ISO string (JSON-safe)
  startSoc:      number;
  startLat:      number | null;
  startLon:      number | null;
  startOdometer: number | null;
  points:        BufferedPoint[];
  energyKwh:     number;
  stoppedMs:     number;
  movingMs:      number;
  socAtStop:     number | null;
  gaps:          number;
  signalLossSec: number;
  interpolated:  number;
  pointsSinceCheckpoint: number;
}

// ─────────────────────── Service ─────────────────────────────────────────────

/**
 * TripBuilderService
 *
 * Buffers all in-progress trip data in memory.  DB writes are deferred to
 * finalize(), enabling:
 *   • quality checks + interpolation before committing
 *   • bulk createMany (much faster than one-by-one inserts)
 *   • clean rollback of false-starts (single delete, not hundreds)
 *
 * Fault tolerance:
 *   Every CHECKPOINT_EVERY points the buffer is serialised to Redis
 *   (key: trip:builder:{vehicleId}, TTL 24 h).  On onModuleInit() all
 *   live keys are restored to the in-memory Map, so a process restart
 *   does not lose the current trip.
 */
@Injectable()
export class TripBuilderService implements OnModuleInit {
  private readonly logger = new Logger(TripBuilderService.name);
  private readonly mem    = new Map<string, TripBuffer>();

  private readonly REDIS_PREFIX      = 'trip:builder:';
  private readonly REDIS_TTL_SEC     = 86_400; // 24 h
  private readonly CHECKPOINT_EVERY  = 50;     // points between Redis writes

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ── startup: restore any live trips from Redis ─────────────────────────────

  async onModuleInit(): Promise<void> {
    try {
      const keys = await this.redis.keys(`${this.REDIS_PREFIX}*`);
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const buf = JSON.parse(raw) as TripBuffer;
        // Re-hydrate Date objects stored as ISO strings inside points array
        buf.points = buf.points.map(p => ({
          ...p, timestamp: new Date(p.timestamp as unknown as string),
        }));
        this.mem.set(buf.vehicleId, buf);
        this.logger.log(
          `[Builder] Restored in-progress trip for ${buf.vehicleId} ` +
          `(tripId=${buf.dbTripId}, ${buf.points.length} pts)`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`[Builder] Redis restore failed: ${e.message}`);
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  has(vehicleId: string): boolean {
    return this.mem.has(vehicleId);
  }

  start(vehicleId: string, opts: {
    dbTripId:      string | null;
    startSoc:      number;
    startLat:      number | null;
    startLon:      number | null;
    startOdometer: number | null;
    now:           Date;
  }): void {
    const buf: TripBuffer = {
      vehicleId,
      dbTripId:      opts.dbTripId,
      startTime:     opts.now.toISOString(),
      startSoc:      opts.startSoc,
      startLat:      opts.startLat,
      startLon:      opts.startLon,
      startOdometer: opts.startOdometer,
      points:        [],
      energyKwh:     0,
      stoppedMs:     0,
      movingMs:      0,
      socAtStop:     null,
      gaps:          0,
      signalLossSec: 0,
      interpolated:  0,
      pointsSinceCheckpoint: 0,
    };
    this.mem.set(vehicleId, buf);
    this.checkpoint(vehicleId).catch(() => null);
  }

  restoreFromDb(vehicleId: string, dbTripId: string, startTime: Date, startSoc: number): void {
    if (this.mem.has(vehicleId)) return;
    const buf: TripBuffer = {
      vehicleId, dbTripId,
      startTime:     startTime.toISOString(),
      startSoc,
      startLat:      null, startLon:      null,
      startOdometer: null,
      points:        [],
      energyKwh:     0, stoppedMs: 0, movingMs: 0,
      socAtStop:     null, gaps: 0, signalLossSec: 0,
      interpolated:  0, pointsSinceCheckpoint: 0,
    };
    this.mem.set(vehicleId, buf);
    this.logger.log(`[Builder] Restored from DB trip ${dbTripId} for ${vehicleId}`);
  }

  setDbTripId(vehicleId: string, dbTripId: string): void {
    const buf = this.mem.get(vehicleId);
    if (buf) { buf.dbTripId = dbTripId; this.checkpoint(vehicleId).catch(() => null); }
  }

  // ── point accumulation ────────────────────────────────────────────────────

  addPoint(vehicleId: string, point: BufferedPoint, dtMs: number): void {
    const buf = this.mem.get(vehicleId);
    if (!buf) return;

    const lastPoint = buf.points.length > 0
      ? buf.points[buf.points.length - 1]
      : null;

    // Insert interpolated points for moderate gaps (60 s – 5 min)
    if (lastPoint && dtMs > 60_000 && dtMs <= 5 * 60_000) {
      const interp = interpolatePoints(lastPoint, point, 10_000);
      buf.points.push(...interp);
      buf.interpolated   += interp.length;
      buf.gaps           += 1;
      buf.signalLossSec  += Math.round(dtMs / 1000);
    } else if (dtMs > 5 * 60_000) {
      buf.gaps           += 1;
      buf.signalLossSec  += Math.round(dtMs / 1000);
    }

    buf.points.push(point);

    // If startOdometer wasn't available at trip start (fleet telemetry sends it separately),
    // capture it from the first point that has an odometer reading.
    const pointOdometer = (point as any).odometer as number | null | undefined;
    if (buf.startOdometer == null && pointOdometer != null) {
      buf.startOdometer = pointOdometer;
    }

    // Time-based stats (skip gap intervals)
    const dtSafe = dtMs > 0 && dtMs <= 60_000 && dtMs < 30 * 60_000 ? dtMs : 0;
    const stopped = (point.speed ?? 0) <= 5;
    buf.stoppedMs += stopped  ? dtSafe : 0;
    buf.movingMs  += !stopped ? dtSafe : 0;

    buf.pointsSinceCheckpoint++;
    if (buf.pointsSinceCheckpoint >= this.CHECKPOINT_EVERY) {
      buf.pointsSinceCheckpoint = 0;
      this.checkpoint(vehicleId).catch(() => null);
    }
  }

  updateEnergy(vehicleId: string, energyKwh: number): void {
    const buf = this.mem.get(vehicleId);
    if (buf) buf.energyKwh = energyKwh;
  }

  setSocAtStop(vehicleId: string, soc: number | null): void {
    const buf = this.mem.get(vehicleId);
    if (buf && buf.socAtStop == null) {
      buf.socAtStop = soc;
      this.checkpoint(vehicleId).catch(() => null); // state change → force checkpoint
    }
  }

  // ── finalize / rollback ────────────────────────────────────────────────────

  finalize(vehicleId: string): TripBuffer | null {
    const buf = this.mem.get(vehicleId);
    if (!buf) return null;
    this.mem.delete(vehicleId);
    this.redis.del(`${this.REDIS_PREFIX}${vehicleId}`).catch(() => null);
    return buf;
  }

  /** Returns the DB tripId so the caller can clean up the DB record if needed. */
  rollback(vehicleId: string): string | null {
    const buf = this.mem.get(vehicleId);
    const tripId = buf?.dbTripId ?? null;
    this.mem.delete(vehicleId);
    this.redis.del(`${this.REDIS_PREFIX}${vehicleId}`).catch(() => null);
    return tripId;
  }

  getBuffer(vehicleId: string): TripBuffer | null {
    return this.mem.get(vehicleId) ?? null;
  }

  // ── live stats ─────────────────────────────────────────────────────────────

  getLiveStats(vehicleId: string): LiveTripStats | null {
    const buf = this.mem.get(vehicleId);
    if (!buf || buf.points.length === 0) return null;

    const distanceKm  = computeDistanceKm(buf.points);
    const durationMin = (Date.now() - new Date(buf.startTime).getTime()) / 60_000;

    const rawEff = distanceKm > 0.1 && buf.energyKwh > 0
      ? Math.round((buf.energyKwh * 1000 / distanceKm) * 10) / 10
      : null;

    const movingPts = buf.points.filter(p => !p.interpolated && (p.speed ?? 0) > 0);
    const avgSpeedKmh = movingPts.length
      ? movingPts.reduce((s, p) => s + (p.speed ?? 0), 0) / movingPts.length
      : null;

    return {
      distanceKm:     Math.round(distanceKm * 10) / 10,
      durationMin:    Math.round(durationMin * 10) / 10,
      energyKwh:      Math.round(buf.energyKwh * 100) / 100,
      efficiencyWhkm: rawEff != null && rawEff <= 600 ? rawEff : null,
      avgSpeedKmh:    avgSpeedKmh != null ? Math.round(avgSpeedKmh * 10) / 10 : null,
      quality:        this.computeQuality(buf),
    };
  }

  // ── quality scoring ────────────────────────────────────────────────────────

  computeQuality(buf: TripBuffer): TripQuality {
    let score = 100;
    // Each gap costs 5 points (cap -30)
    score -= Math.min(30, buf.gaps * 5);
    // Each minute of signal loss costs 2 points (cap -20)
    score -= Math.min(20, Math.floor(buf.signalLossSec / 60) * 2);
    // Each interpolated point costs 0.1 (cap -30 for fully synthetic track)
    if (buf.points.length > 0) {
      score -= Math.min(30, Math.round(buf.interpolated * 0.1));
    }
    const finalScore = Math.max(0, score);
    return {
      score:         finalScore,
      label:         finalScore >= 80 ? 'HIGH' : finalScore >= 50 ? 'MEDIUM' : 'LOW',
      gaps:          buf.gaps,
      signalLossSec: buf.signalLossSec,
      interpolated:  buf.interpolated,
    };
  }

  // ── Redis checkpoint ───────────────────────────────────────────────────────

  private async checkpoint(vehicleId: string): Promise<void> {
    const buf = this.mem.get(vehicleId);
    if (!buf) return;
    try {
      await this.redis.set(
        `${this.REDIS_PREFIX}${vehicleId}`,
        JSON.stringify(buf),
        'EX', this.REDIS_TTL_SEC,
      );
    } catch (e: any) {
      this.logger.warn(`[Builder] Redis checkpoint failed for ${vehicleId}: ${e.message}`);
    }
  }
}

// ─────────────────────── Pure helpers (exported for detector) ─────────────────

/**
 * Douglas-Peucker polyline simplification.
 * Reduces point count while preserving shape within `epsilonKm` tolerance.
 * Typical epsilon for overview maps: 0.01–0.05 km (10–50 m).
 */
export function douglasPeucker(
  points: Pick<BufferedPoint, 'latitude' | 'longitude'>[],
  epsilonKm = 0.01,
): Pick<BufferedPoint, 'latitude' | 'longitude'>[] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx  = 0;

  const start = points[0];
  const end   = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToLineDistKm(points[i], start, end);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > epsilonKm) {
    const left  = douglasPeucker(points.slice(0, maxIdx + 1), epsilonKm);
    const right = douglasPeucker(points.slice(maxIdx), epsilonKm);
    return [...left.slice(0, -1), ...right];
  }

  return [start, end];
}

function pointToLineDistKm(
  p:     Pick<BufferedPoint, 'latitude' | 'longitude'>,
  start: Pick<BufferedPoint, 'latitude' | 'longitude'>,
  end:   Pick<BufferedPoint, 'latitude' | 'longitude'>,
): number {
  if (
    p.latitude == null || p.longitude == null ||
    start.latitude == null || start.longitude == null ||
    end.latitude == null || end.longitude == null
  ) return 0;

  const dx = end.longitude! - start.longitude!;
  const dy = end.latitude!  - start.latitude!;

  if (dx === 0 && dy === 0) {
    return haversineKm(p.latitude, p.longitude, start.latitude, start.longitude);
  }

  const t = Math.max(0, Math.min(1,
    ((p.longitude! - start.longitude!) * dx + (p.latitude! - start.latitude!) * dy) /
    (dx * dx + dy * dy),
  ));
  const closestLat = start.latitude!  + t * dy;
  const closestLon = start.longitude! + t * dx;
  return haversineKm(p.latitude, p.longitude, closestLat, closestLon);
}

export function computeDistanceKm(
  points: Pick<BufferedPoint, 'latitude' | 'longitude'>[],
): number {
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    km += haversineKm(
      points[i - 1].latitude, points[i - 1].longitude,
      points[i].latitude,     points[i].longitude,
    );
  }
  return km;
}

export function haversineKm(
  lat1: number | null, lon1: number | null,
  lat2: number | null, lon2: number | null,
): number {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return 0;
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Google Encoded Polyline Algorithm
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function encodePolyline(
  points: Pick<BufferedPoint, 'latitude' | 'longitude'>[],
): string {
  const raw = points.filter(p => p.latitude != null && p.longitude != null);
  if (raw.length === 0) return '';
  // Apply Douglas-Peucker simplification (10 m tolerance) before encoding
  const gps = raw.length > 4 ? douglasPeucker(raw, 0.01) : raw;

  let result  = '';
  let prevLat = 0;
  let prevLon = 0;

  for (const p of gps) {
    const lat = Math.round(p.latitude! * 1e5);
    const lon = Math.round(p.longitude! * 1e5);
    result += encodeValue(lat - prevLat);
    result += encodeValue(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return result;
}

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode(((v & 0x1f) | 0x20) + 63);
    v >>>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

export function interpolatePoints(
  from: BufferedPoint,
  to:   BufferedPoint,
  intervalMs: number,
): BufferedPoint[] {
  const dtMs  = to.timestamp.getTime() - from.timestamp.getTime();
  const count = Math.floor(dtMs / intervalMs) - 1;
  if (count <= 0) return [];

  const result: BufferedPoint[] = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    result.push({
      timestamp:  new Date(from.timestamp.getTime() + t * dtMs),
      speed:      lerp(from.speed, to.speed, t),
      power:      from.power != null && to.power != null ? lerp(from.power, to.power, t) : null,
      soc:        from.soc   != null && to.soc   != null ? lerp(from.soc,   to.soc,   t) : null,
      latitude:   from.latitude  != null && to.latitude  != null ? lerp(from.latitude,  to.latitude,  t) : null,
      longitude:  from.longitude != null && to.longitude != null ? lerp(from.longitude, to.longitude, t) : null,
      elevationM: null,
      interpolated: true,
    });
  }
  return result;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
