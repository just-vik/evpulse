import { Injectable, Logger, Inject, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { SpanStatusCode } from '@opentelemetry/api';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { TelemetryGateway } from '../websockets/telemetry.gateway';
import { RangePredictorService } from '../ml/range-predictor.service';
import { tracer } from '../otel';

/**
 * TripEngineV2 — real-time WebSocket event emitter. Complementary to TripDetectorService.
 *
 * Runs as a consumer in the 'live-workers' group on the same Redis Stream
 * as the main batch pipeline ('api-workers'). Processes every point instantly
 * (BLOCK 5000) without the 10-second delay of the batch flush.
 *
 * Responsibilities:
 *   • Detect trip start / end in real time
 *   • Emit trip:point and trip:live events immediately (0 ms latency)
 *   • Track state in Redis (not DB — TripDetectorService handles DB writes)
 *
 * NOT responsible for:
 *   • Writing trips to PostgreSQL  (→ TripDetectorService, the primary engine)
 *   • Sophisticated gap/odometer handling (→ TripDetectorService)
 *   • Post-processing (→ TripPostProcessorService)
 *
 * Fixes vs v1:
 *   • Race condition: reads trip:id:{vehicleId} written by TripDetectorService
 *     so that emitted events carry the real DB trip ID (not a local live-{ts} ID)
 *   • Distance drift: odometer-based correction every 20 points
 *   • WebSocket flood: trip:live throttled to max once per 2 seconds;
 *     trip:point emits every GPS fix (lightweight, needed for live polyline)
 */

interface LiveTripState {
  id: string;           // local fallback ID (live-{ts}); prefer trip:id:{vehicleId}
  state: 'DRIVING' | 'STOPPING';
  startTs: number;
  lastTs: number;
  idleStartTs: number | null;
  distanceKm: number;
  energyKwh: number;
  startSoc: number | null;
  points: number;
  lastLat: number | null;
  lastLng: number | null;
  lastEmitTs: number;            // timestamp of last trip:live emission (throttle)
  startOdometerKm: number | null; // odometer at trip start (drift correction)
  lastOdometerKm: number | null;  // most recent odometer reading
}

const EMIT_INTERVAL_MS = 2_000; // trip:live max frequency
const DEDUP_TTL_SEC    = 600;   // exactly-once window (10 min)
const STATE_TTL_SEC    = 1_800; // 30 min — shorter TTL, heartbeat extends it

@Injectable()
export class TripEngineV2Service implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripEngineV2Service.name);
  private running = false;

  private readonly STREAM_KEY    = 'telemetry:stream';
  private readonly GROUP_NAME    = 'live-workers';
  // Unique per process+random — safe for N replicas on same Redis
  private readonly CONSUMER_NAME = `live-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;

  /** Dedicated blocking connection — see FleetTelemetryWorker for rationale. */
  private blockingRedis!: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly gateway: TelemetryGateway,
    private readonly configService: ConfigService,
    @Optional() private readonly rangePredictor?: RangePredictorService,
  ) {}

  async onModuleInit() {
    this.blockingRedis = new Redis({
      host: this.configService.get('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get('REDIS_PASSWORD'),
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
    this.blockingRedis.on('error', (e: Error) => this.logger.warn(`[BlockingRedis] ${e.message}`));

    // Create consumer group (idempotent)
    await this.redis
      .xgroup('CREATE', this.STREAM_KEY, this.GROUP_NAME, '$', 'MKSTREAM')
      .catch((err: Error) => { if (!err.message.includes('BUSYGROUP')) throw err; });

    // Restore trip snapshots into live keys for any vehicle whose live key expired
    // while the service was down (Redis eviction or restart).
    await this.restoreSnapshots();

    // Recover pending messages from before restart
    await this.drainPending();

    this.running = true;
    this.consumeLoop().catch((e: Error) =>
      this.logger.error(`TripEngineV2 consumer crashed: ${e.message}`),
    );

    this.logger.log('TripEngineV2 live consumer started');
  }

  async onModuleDestroy() {
    this.running = false;
    await this.blockingRedis?.quit().catch(() => {});
  }

  // ─── Consumer loop ─────────────────────────────────────────────────────────

  private async consumeLoop() {
    while (this.running) {
      try {
        const result = await this.blockingRedis.xreadgroup(
          'GROUP', this.GROUP_NAME, this.CONSUMER_NAME,
          'COUNT', '50',
          'BLOCK', '5000',
          'STREAMS', this.STREAM_KEY, '>',
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (!result) continue;

        const ids: string[] = [];
        for (const [, messages] of result) {
          for (const [msgId] of messages) ids.push(msgId);
        }

        await tracer.startActiveSpan('tripEngine.process_batch', { attributes: { 'batch.size': ids.length } }, async (batchSpan) => {
          try {
            for (const [, messages] of result) {
              for (const [msgId, fields] of messages) {
                const dataIdx = fields.indexOf('data');
                if (dataIdx !== -1 && dataIdx + 1 < fields.length) {
                  try {
                    const point = JSON.parse(fields[dataIdx + 1]);
                    await this.handlePoint(point.vehicleId, point);
                  } catch (e: any) {
                    // Dead Letter Queue — preserves payload for offline debugging
                    await this.redis.lpush('dlq:jobs:telemetry', JSON.stringify({
                      jobName: 'trip-engine-v2:consume',
                      data: {
                        vehicleId: (() => {
                          try { return JSON.parse(fields[dataIdx + 1])?.vehicleId; } catch { return undefined; }
                        })(),
                        data: (() => {
                          try { return JSON.parse(fields[dataIdx + 1]); } catch { return fields[dataIdx + 1]; }
                        })(),
                      },
                      error: e.message,
                      failedAt: new Date().toISOString(),
                    })).catch(() => {});
                  }
                }
              }
            }

            if (ids.length) {
              await this.redis.xack(this.STREAM_KEY, this.GROUP_NAME, ...ids);
            }
            batchSpan.end();
          } catch (e: any) {
            batchSpan.recordException(e);
            batchSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
            batchSpan.end();
            throw e;
          }
        });
      } catch (err: any) {
        if (this.running) {
          this.logger.warn(`TripEngineV2 loop error: ${err.message}`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
  }

  private async restoreSnapshots() {
    const keys = await this.redis.keys('trip:snapshot:*');
    for (const snapshotKey of keys) {
      const vehicleId = snapshotKey.replace('trip:snapshot:', '');
      const liveKey   = `trip:live:${vehicleId}`;
      const liveExists = await this.redis.exists(liveKey);
      if (!liveExists) {
        const raw = await this.redis.get(snapshotKey);
        if (raw) {
          await this.redis.set(liveKey, raw, 'EX', STATE_TTL_SEC);
          this.logger.log(`[V2] Restored trip snapshot for ${vehicleId}`);
        }
      }
    }
  }

  private async drainPending() {
    const result = await this.redis.xreadgroup(
      'GROUP', this.GROUP_NAME, this.CONSUMER_NAME,
      'COUNT', '500', 'STREAMS', this.STREAM_KEY, '0',
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result) return;
    const ids: string[] = [];
    for (const [, messages] of result) {
      for (const [msgId, fields] of messages) {
        const dataIdx = fields.indexOf('data');
        if (dataIdx !== -1 && dataIdx + 1 < fields.length) {
          try {
            const point = JSON.parse(fields[dataIdx + 1]);
            await this.handlePoint(point.vehicleId, point);
          } catch (e: any) {
            await this.redis.lpush('dlq:jobs:telemetry', JSON.stringify({
              jobName: 'trip-engine-v2:drain-pending',
              data: {
                vehicleId: (() => {
                  try { return JSON.parse(fields[dataIdx + 1])?.vehicleId; } catch { return undefined; }
                })(),
                data: (() => {
                  try { return JSON.parse(fields[dataIdx + 1]); } catch { return fields[dataIdx + 1]; }
                })(),
              },
              error: e.message,
              failedAt: new Date().toISOString(),
            })).catch(() => {});
          }
        }
        ids.push(msgId);
      }
    }
    if (ids.length) {
      await this.redis.xack(this.STREAM_KEY, this.GROUP_NAME, ...ids);
    }
  }

  // ─── State machine ─────────────────────────────────────────────────────────

  async handlePoint(vehicleId: string, p: any) {
    if (!vehicleId) return;

    // ── Exactly-once dedup ─────────────────────────────────────────────
    // Same pattern as TelemetryPipelineService. Prevents duplicate processing
    // when the same message is re-delivered after a consumer restart.
    const ts0 = p.timestamp ?? Date.now();
    const dedupKey = `dedup:v2:${vehicleId}:${ts0}`;
    const claimed = await (this.redis as any).set(dedupKey, '1', 'EX', DEDUP_TTL_SEC, 'NX');
    if (!claimed) return; // already processed

    const stateKey = `trip:live:${vehicleId}`;
    const raw = await this.redis.get(stateKey);
    const trip: LiveTripState | null = raw ? JSON.parse(raw) : null;

    // Real DB trip ID published by TripDetectorService when it creates the DB record.
    // Using this ensures trip:point events carry an ID the frontend can look up in DB.
    const realTripId = await this.redis.get(`trip:id:${vehicleId}`);

    const speed      = Number(p.speed ?? 0);
    const power      = Number(p.power ?? 0);
    const soc        = p.soc != null ? Number(p.soc) : null;
    const lat        = p.latitude  != null ? Number(p.latitude)  : null;
    const lng        = p.longitude != null ? Number(p.longitude) : null;
    const odometer   = p.odometer  != null ? Number(p.odometer)  : null;
    const shiftState = p.shift_state as string | undefined;
    const ts         = p.timestamp ? new Date(p.timestamp).getTime() : Date.now();
    const isDriving  = speed > 2 && (shiftState === 'D' || shiftState === 'R');
    const isStopped  = speed < 1;

    if (!trip) {
      if (isDriving) await this.startTrip(vehicleId, stateKey, { speed, power, soc, lat, lng, odometer, ts });
      return;
    }

    if (trip.state === 'DRIVING') {
      await this.handleDriving(vehicleId, stateKey, trip, realTripId, { speed, power, soc, lat, lng, odometer, ts, isStopped });
    } else {
      await this.handleStopping(vehicleId, stateKey, trip, realTripId, { speed, power, soc, lat, lng, ts, isDriving });
    }
  }

  private async startTrip(
    vehicleId: string,
    key: string,
    p: { speed: number; power: number; soc: number | null; lat: number | null; lng: number | null; odometer: number | null; ts: number },
  ) {
    const trip: LiveTripState = {
      id: `live-${Date.now()}`,
      state: 'DRIVING',
      startTs: p.ts,
      lastTs: p.ts,
      idleStartTs: null,
      distanceKm: 0,
      energyKwh: 0,
      startSoc: p.soc,
      points: 1,
      lastLat: p.lat,
      lastLng: p.lng,
      lastEmitTs: 0,
      startOdometerKm: p.odometer,
      lastOdometerKm: p.odometer,
    };
    await this.redis.set(key, JSON.stringify(trip), 'EX', STATE_TTL_SEC);
    this.logger.debug(`[V2] Trip started for ${vehicleId}`);
  }

  private async handleDriving(
    vehicleId: string,
    key: string,
    trip: LiveTripState,
    realTripId: string | null,
    p: { speed: number; power: number; soc: number | null; lat: number | null; lng: number | null; odometer: number | null; ts: number; isStopped: boolean },
  ) {
    // Incremental GPS distance
    if (p.lat != null && p.lng != null && trip.lastLat != null && trip.lastLng != null) {
      const dtMs = p.ts - trip.lastTs;
      if (dtMs > 0 && dtMs < 300_000) {
        trip.distanceKm += haversineKm(trip.lastLat, trip.lastLng, p.lat, p.lng);
      }
    }

    // Incremental energy (positive drive only, skip gaps > 6 min)
    if (p.power > 0 && trip.lastTs > 0) {
      const dtHrs = (p.ts - trip.lastTs) / 3_600_000;
      if (dtHrs > 0 && dtHrs < 0.1) {
        trip.energyKwh += p.power * dtHrs;
      }
    }

    trip.points++;
    trip.lastTs = p.ts;
    if (p.lat != null) trip.lastLat = p.lat;
    if (p.lng != null) trip.lastLng = p.lng;

    // ── Odometer drift correction (every 20 points) ─────────────────────
    // GPS haversine accumulates small errors; odometer is the ground truth.
    // Apply the same ratio logic as TripPostProcessorService.
    if (p.odometer != null) {
      if (trip.startOdometerKm == null) {
        trip.startOdometerKm = p.odometer;
      } else if (trip.points % 20 === 0) {
        const odoDelta = p.odometer - trip.startOdometerKm;
        if (odoDelta >= 0.3 && trip.distanceKm > 0) {
          const ratio = trip.distanceKm / odoDelta;
          if (ratio < 0.75) {
            trip.distanceKm = Math.round(odoDelta * 10) / 10;
          } else if (ratio < 0.92) {
            trip.distanceKm = Math.round(((trip.distanceKm + odoDelta) / 2) * 10) / 10;
          }
          // ratio ≥ 0.92 → GPS is accurate enough, keep it
        }
      }
      trip.lastOdometerKm = p.odometer;
    }

    if (p.isStopped) {
      trip.state = 'STOPPING';
      trip.idleStartTs = p.ts;
    }

    // ── WebSocket throttle ──────────────────────────────────────────────
    // trip:point emits every GPS fix (lightweight, feeds live polyline).
    // trip:live (full stats) is capped at EMIT_INTERVAL_MS to avoid frontend flooding.
    const shouldEmitStats = (p.ts - trip.lastEmitTs) >= EMIT_INTERVAL_MS;
    if (shouldEmitStats) trip.lastEmitTs = p.ts;

    await this.redis.set(key, JSON.stringify(trip), 'EX', STATE_TTL_SEC);

    // Persist snapshot every 10 points — no TTL so it survives Redis eviction.
    // On module restart, drainPending() recovers stream messages; this snapshot
    // is the fallback for in-flight trips that had no pending stream messages.
    if (trip.points % 10 === 0) {
      await this.redis.set(`trip:snapshot:${vehicleId}`, JSON.stringify(trip)).catch(() => {});
    }

    // Heartbeat: reset TTL every 10 points so active trips never hit the 30-min window.
    // Trips that genuinely stall (no telemetry for 30 min) will auto-expire cleanly.
    if (trip.points % 10 === 0) {
      await this.redis.expire(key, STATE_TTL_SEC);
    }
    await this.emitLive(vehicleId, trip, realTripId, p.lat, p.lng, p.speed, p.soc, shouldEmitStats);
  }

  private async handleStopping(
    vehicleId: string,
    key: string,
    trip: LiveTripState,
    realTripId: string | null,
    p: { speed: number; power: number; soc: number | null; lat: number | null; lng: number | null; ts: number; isDriving: boolean },
  ) {
    if (p.isDriving) {
      trip.state = 'DRIVING';
      trip.idleStartTs = null;
      await this.redis.set(key, JSON.stringify(trip), 'EX', STATE_TTL_SEC);
      await this.emitLive(vehicleId, trip, realTripId, p.lat, p.lng, p.speed, p.soc, true);
      return;
    }

    const idleMs = p.ts - (trip.idleStartTs ?? p.ts);
    if (idleMs > 120_000) {
      await this.redis.del(key);
      this.logger.debug(`[V2] Trip ended for ${vehicleId} (${trip.distanceKm.toFixed(1)} km live)`);
    }
  }

  private async emitLive(
    vehicleId: string,
    trip: LiveTripState,
    realTripId: string | null,
    lat: number | null,
    lng: number | null,
    speed: number,
    soc: number | null,
    emitStats: boolean,
  ) {
    const effectiveTripId = realTripId ?? trip.id;

    // Always emit GPS point — lightweight, needed for live polyline
    if (lat != null && lng != null) {
      this.gateway.emitTripPoint(vehicleId, effectiveTripId, lat, lng, speed);
    }

    // Stats update: throttled (emitStats flag set by caller)
    if (!emitStats) return;

    const durationMin    = Math.round((trip.lastTs - trip.startTs) / 60_000);
    const efficiencyWhkm = trip.distanceKm > 0.1
      ? Math.round((trip.energyKwh * 1000) / trip.distanceKm)
      : null;

    // Live range prediction — non-blocking, falls back to null on any error
    let estimatedRangeKm: number | null = null;
    if (this.rangePredictor && soc != null && soc > 0) {
      estimatedRangeKm = await this.rangePredictor
        .predictLive(vehicleId, soc, speed)
        .catch(() => null);
    }

    const socUsedPct = trip.startSoc != null && soc != null
      ? Math.round((trip.startSoc - soc) * 10) / 10
      : null;

    this.gateway.emitLiveTripUpdate(vehicleId, {
      tripId:    effectiveTripId,
      tripState: trip.state,
      speed,
      soc,
      lat,
      lng,
      liveStats: {
        distanceKm:     Math.round(trip.distanceKm * 10) / 10,
        durationMin,
        energyKwh:      Math.round(trip.energyKwh * 100) / 100,
        efficiencyWhkm,
        avgSpeedKmh:    durationMin > 0 ? Math.round((trip.distanceKm / durationMin) * 60) : null,
      },
      prediction: { estimatedRangeKm, socUsedPct },
      quality: { score: 80, gaps: 0, signalLossSec: 0, interpolated: 0 },
    });
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
