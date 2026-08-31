import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryService } from './telemetry.service';
import { TripDetectorService } from '../trips/trip-detector.service';
import { ChargingDetectorService } from '../charging/charging-detector.service';
import { TelemetrySanitizerService } from './telemetry-sanitizer.service';
import { TelemetryEventEngine, TelemetryVehicleState } from './telemetry-event-engine.service';
import { CreateTelemetryPointDto } from './dto/telemetry.dto';
import { VehicleStateMachineService, VehicleState } from '../tesla-fleet/vehicle-state-machine.service';
import { TelemetryGateway } from '../websockets/telemetry.gateway';
import { getDataQuality } from '../analytics/vehicle-analytics.service';
import { MetricsService } from '../metrics/metrics.service';
import { SnapshotService } from '../events/snapshot.service';

/**
 * TTL for exactly-once dedup keys.
 * 10 min covers restart + retry + DLQ replay re-delivery windows.
 * Longer = more Redis memory; shorter = risk of replay duplicates.
 */
const DEDUP_TTL_SEC = 600;

/**
 * Maximum number of telemetry points processed in a single pipeline batch.
 *
 * Backpressure guard: keeps per-batch DB write latency bounded and ensures
 * the Redis lock TTL (30 s) is never exhausted by a runaway large batch from
 * a DLQ replay burst or an overloaded fleet-telemetry session.
 *
 * Excess points are dropped with a warning logged; callers (DLQ, queue
 * processors) should respect this limit and chunk their own input before
 * calling processBatch().  Overridable via env TELEMETRY_MAX_BATCH_SIZE.
 */
const MAX_BATCH_SIZE = Math.min(
  5_000,
  Number(process.env.TELEMETRY_MAX_BATCH_SIZE ?? '500') || 500,
);

/** Log a warning when a single batch drops more than this many OOO points */
const OOO_WARN_THRESHOLD = 10;

/** Redis TTL for “raw replay needed” flag after pipeline lock contention */
const RAW_REPLAY_PENDING_TTL_SEC = 86_400;

/** Min interval between raw replay sweeps per vehicle (seconds) */
const RAW_REPLAY_COOLDOWN_SEC = 120;

/** Max rows processed in one replay sweep (across DB pages) */
const RAW_REPLAY_MAX_ROWS = 15_000;

/** Rows per telemetry_raw page — keeps heap bounded during replay */
const RAW_REPLAY_DB_PAGE = 500;

/** Default lookback when pending key is legacy `'1'` or unreadable */
const RAW_REPLAY_DEFAULT_LOOKBACK_MS = 3 * 3_600_000;

/** Do not scan raw older than this even if pendingAt is ancient (ms) */
const RAW_REPLAY_MAX_SPAN_MS = 7 * 24 * 3_600_000;

/** Fields compared for WebSocket diff emission (must match keys in Redis state cache) */
const DIFF_FIELDS = ['speed', 'power', 'soc', 'charging_state', 'lat', 'lng', 'vehicleState'] as const;

@Injectable()
export class TelemetryPipelineService {
  private readonly logger = new Logger(TelemetryPipelineService.name);
  private readonly dedupHeartbeatMs = Math.max(
    10_000,
    Number(process.env.TELEMETRY_DEDUP_HEARTBEAT_MS ?? '45000') || 45_000,
  );

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly telemetryService: TelemetryService,
    private readonly tripDetector: TripDetectorService,
    private readonly chargingDetector: ChargingDetectorService,
    private readonly sanitizer: TelemetrySanitizerService,
    private readonly stateMachine: VehicleStateMachineService,
    private readonly eventEngine: TelemetryEventEngine,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly gateway?: TelemetryGateway,
    @Optional() private readonly snapshotSvc?: SnapshotService,
  ) {}

  /**
   * Processes a telemetry batch:
   *  1. Sort by timestamp
   *  2. Exactly-once dedup via Redis NX (per vehicleId+timestamp)
   *  3. Run trip / charging detectors on each unique raw point
   *  4. Delta-filter / aggregate for storage
   *  5. Batched insert of aggregated points into TimescaleDB
   */
  async processBatch(
    vehicleId: string,
    points: CreateTelemetryPointDto[],
    source: 'fleet_telemetry' | 'v1_streaming' | 'rest_poll' | 'mqtt' | 'replay' = 'fleet_telemetry',
    traceId: string = randomUUID(),
  ): Promise<void> {
    const _t0 = Date.now();
    this.logger.debug(`[${traceId}] processBatch start vehicleId=${vehicleId} points=${points.length} source=${source}`);

    if (!points.length) return;

    // ── Backpressure guard ────────────────────────────────────────────────────
    // Clamp the batch to MAX_BATCH_SIZE to keep per-batch DB latency bounded.
    // Excess points are NOT dropped — they are pushed to the DLQ so a later
    // replay pass will process them without data loss.
    const excess  = points.length > MAX_BATCH_SIZE ? points.slice(MAX_BATCH_SIZE) : [];
    const safePts = excess.length > 0 ? points.slice(0, MAX_BATCH_SIZE) : points;
    if (excess.length > 0) {
      this.logger.warn(
        `[${traceId}] Batch clamped ${points.length} → ${MAX_BATCH_SIZE} for ${vehicleId} (source=${source}). ` +
        `${excess.length} excess points enqueued to DLQ for later replay.`,
      );
      this.metrics?.telemetryPointsDedupDropped.inc({ source }, excess.length);
      // Push overflow to DLQ — fire-and-forget so it never blocks the hot path.
      // LTRIM caps the list at MAX_DLQ_SIZE so Redis memory stays bounded even
      // if the replay worker is down for an extended period.
      // LLEN is appended to the pipeline so we can update the Prometheus gauge.
      const DLQ_KEY      = 'dlq:telemetry';
      const MAX_DLQ_SIZE = 100_000;
      (this.redis as any)
        .multi()
        .lpush(DLQ_KEY, JSON.stringify({ vehicleId, source, points: excess, enqueuedAt: Date.now() }))
        .ltrim(DLQ_KEY, 0, MAX_DLQ_SIZE - 1)
        .llen(DLQ_KEY)
        .exec()
        .then((results: [Error | null, unknown][] | null) => {
          // results[2] is the LLEN reply: [null, depth]
          const depth = results?.[2]?.[1];
          if (typeof depth === 'number') {
            this.metrics?.dlqDepth.set(depth);
          }
          this.metrics?.dlqPushTotal.inc({ source });
        })
        .catch((err: Error) =>
          this.logger.error(`[${traceId}] Failed to enqueue overflow to DLQ: ${err.message}`),
        );
    }

    // ── Single-writer guard ───────────────────────────────────────────────────
    // Guarantees at most one pipeline execution per vehicle at any given time.
    // Without this, two workers could simultaneously call processBatch for the
    // same vehicleId (e.g. live stream flush + DLQ replay, or two API pods on
    // a burst), interleaving their state-machine calls and producing ghost trips.
    //
    // TTL = 30 s: the processing of a 10-second batch should complete in < 5 s;
    // 30 s is a generous ceiling that auto-releases the lock after a worker crash.
    //
    // On contention: skip silently — the contending worker will persist the raw
    // events (fire-and-forget below) but defer detector calls.  The next flush
    // cycle will pick up any missed points via the DLQ or the next stream read.
    const pipelineLockKey = `lock:pipeline:${vehicleId}`;
    const lockAcquired = await (this.redis as any).set(pipelineLockKey, traceId, 'PX', 30_000, 'NX');
    if (!lockAcquired) {
      this.logger.debug(`[${traceId}] Pipeline lock busy for ${vehicleId} — skipping detector pass`);
      // Still persist raw events so nothing is lost (use clamped safePts)
      this.saveRawBatch(vehicleId, safePts, source).catch(() => {});
      // Replay batches must not re-arm pending — avoids feedback while replay fights for the lock.
      if (source !== 'replay') {
        await this.markRawReplayPending(vehicleId).catch(() => {});
      }
      return;
    }

    // Heartbeat: extend the lock TTL every 5 s so a slow but alive worker never
    // loses its lock mid-batch.
    //
    // Uses an atomic Lua CAS script to avoid the TOCTOU race between GET and
    // PEXPIRE: if two ops are split by a network delay, worker A's GET could see
    // its own traceId, but by the time PEXPIRE fires the lock may have expired
    // and been claimed by worker B.  The Lua script is executed atomically by
    // Redis, so the check-and-extend is indivisible.
    // Canonical CAS-extend Lua script (Redis executes this atomically):
    //   if redis.call('get', KEYS[1]) == ARGV[1] then
    //     return redis.call('pexpire', KEYS[1], ARGV[2])
    //   else
    //     return 0
    //   end
    const luaCasExtend = [
      `if redis.call('get', KEYS[1]) == ARGV[1] then`,
      `  return redis.call('pexpire', KEYS[1], ARGV[2])`,
      `else`,
      `  return 0`,
      `end`,
    ].join('\n');
    const heartbeatTimer = setInterval(async () => {
      await (this.redis as any)
        .eval(luaCasExtend, 1, pipelineLockKey, traceId, '30000')
        .catch(() => {});
    }, 5_000);

    try {
      await this._processBatchInner(vehicleId, safePts, source, traceId, _t0);
    } finally {
      clearInterval(heartbeatTimer);
      // Only release our own lock (compare-and-delete pattern)
      const current = await (this.redis as any).get(pipelineLockKey).catch(() => null);
      if (current === traceId) {
        await this.redis.del(pipelineLockKey).catch(() => {});
      }
      this.scheduleBackfillIfNeeded(vehicleId).catch((e: Error) =>
        this.logger.warn(`scheduleBackfillIfNeeded(${vehicleId}): ${e.message}`),
      );
    }
  }

  private async _processBatchInner(
    vehicleId: string,
    points: CreateTelemetryPointDto[],
    source: 'fleet_telemetry' | 'v1_streaming' | 'rest_poll' | 'mqtt' | 'replay',
    traceId: string,
    _t0: number,
  ): Promise<void> {
    // 0) Persist raw events BEFORE normalization — immutable event store.
    //    Fire-and-forget: never block the hot path for raw storage.
    this.saveRawBatch(vehicleId, points, source).catch((e) =>
      this.logger.warn(`[${traceId}] [Pipeline] raw save failed for ${vehicleId}: ${e.message}`),
    );

    // 1) Sort by timestamp
    points.sort(
      (a, b) =>
        new Date(a.timestamp || new Date()).getTime() -
        new Date(b.timestamp || new Date()).getTime(),
    );

    // 1b) Sanitize: strict pre-filter for physically impossible / corrupt values
    points = this.sanitizer.sanitize(vehicleId, points);
    if (!points.length) return;

    // 2) Exactly-once dedup via SHA-256 payload hash.
    //
    //    Upgrade over the previous timestamp-only approach:
    //      - Works even when timestamp is null
    //      - DLQ replay cannot re-insert the same point (hash matches)
    //      - Race-condition safe: Redis SET NX is atomic
    //
    //    The hash covers vehicleId + rounded coordinates + key signals.
    //    Rounding (lat/lng to 4 dp = ~11m, soc/speed to 1 dp) prevents
    //    float representation differences from creating false negatives.
    const unique: CreateTelemetryPointDto[] = [];
    let heartbeatPassed = 0;
    for (const p of points) {
      const hash = this.payloadHash(vehicleId, p);
      const claimed = await (this.redis as any).set(
        `telemetry:hash:${hash}`, '1', 'EX', DEDUP_TTL_SEC, 'NX',
      );
      if (claimed) {
        unique.push(p);
        continue;
      }

      // Heartbeat bypass: even fully duplicated parked points must occasionally
      // reach detectors, otherwise STOPPING timeout/split logic never advances.
      const tsMs = p.timestamp
        ? new Date(p.timestamp as unknown as Date).getTime()
        : Date.now();
      const heartbeatBucket = Math.floor(tsMs / this.dedupHeartbeatMs);
      const hbKey = `telemetry:hb:${vehicleId}:${heartbeatBucket}`;
      const hbClaimed = await (this.redis as any).set(
        hbKey, '1', 'EX', DEDUP_TTL_SEC, 'NX',
      );
      if (hbClaimed) {
        unique.push(p);
        heartbeatPassed += 1;
      }
    }

    this.logger.debug(
      `[${traceId}] t+${Date.now()-_t0}ms: dedup done unique=${unique.length}/${points.length} hb=${heartbeatPassed} windowMs=${this.dedupHeartbeatMs}`,
    );
    if (points.length > unique.length) {
      this.metrics?.telemetryPointsDedupDropped.inc({ source }, points.length - unique.length);
    }
    if (!unique.length) return;

    // ── Out-of-order guard ───────────────────────────────────────────────────
    // Prevents DLQ replay or delayed batches from rewinding the state machine
    // with stale data that would produce ghost trips or charging ghosts.
    //
    // Strategy: track the epoch ms of the last point that entered the detector
    // loop, per vehicle, in Redis.  Points older than (lastTs − TOLERANCE) are
    // dropped from the detector pass.  They've already been persisted to
    // telemetry_raw above, so they're never truly lost — just not re-processed
    // by detectors that rely on ordering invariants.
    //
    // TOLERANCE = 30 s: absorbs legitimate clock drift, out-of-order TCP packets,
    // and brief REST API timestamp jitter.  Anything older than 30 s behind
    // the last seen point is definitely stale or from a different flush window.
    const OOO_TOLERANCE_MS = 30_000;
    const lastTsKey = `pipeline:lastTs:${vehicleId}`;
    const lastTsRaw = await (this.redis as any).get(lastTsKey).catch(() => null);
    const lastProcessedMs = lastTsRaw ? parseInt(lastTsRaw as string, 10) : 0;

    const inOrder = unique.filter(p => {
      const ptMs = p.timestamp ? new Date(p.timestamp as unknown as string).getTime() : 0;
      if (ptMs >= lastProcessedMs - OOO_TOLERANCE_MS) return true;

      // Critical events bypass the OOO guard: a delayed charging disconnect or
      // shift-state change must reach the state machine even if its timestamp is
      // slightly behind the last cursor.  Dropping it would leave a session open
      // forever or miss a trip start after a long REST-poll gap.
      if (this.isCriticalEvent(p)) {
        this.logger.warn(
          `[${traceId}] OOO critical event passed through for ${vehicleId} ` +
          `ts=${ptMs} lastProcessedMs=${lastProcessedMs}`,
        );
        return true;
      }
      return false;
    });
    const oooDropped = unique.length - inOrder.length;
    if (oooDropped > 0) {
      this.metrics?.pipelineTelemetryOooDropped.inc({ source }, oooDropped);
      const msg =
        `[${traceId}] Out-of-order: dropped ${oooDropped} point(s) for ${vehicleId} ` +
        `(lastProcessedMs=${lastProcessedMs})`;
      if (oooDropped > OOO_WARN_THRESHOLD) {
        this.logger.warn(`${msg} — high OOO count; check Fleet ordering / pipeline:lastTs`);
      } else {
        this.logger.warn(msg);
      }
    }
    // Advance the last-processed cursor to the latest timestamp in this batch.
    const batchMaxMs = inOrder.reduce((max, p) => {
      const pts = p.timestamp ? new Date(p.timestamp as unknown as string).getTime() : 0;
      return pts > max ? pts : max;
    }, lastProcessedMs);
    if (batchMaxMs > lastProcessedMs) {
      await (this.redis as any).set(lastTsKey, String(batchMaxMs), 'EX', 24 * 3600).catch(() => {});
    }

    const toProcess = inOrder.length > 0 ? inOrder : [];
    if (!toProcess.length) return;

    // 3a) Update vehicle state from the latest point so status stays fresh
    //     even when REST polling is deferred (fleet-live mode).
    const latestPoint = toProcess[toProcess.length - 1];
    const { justWoke, newState: vehicleStateNow } = await this.stateMachine.updateFromTelemetry(vehicleId, {
      speed:          latestPoint.speed,
      power:          latestPoint.power,
      charging_state: (latestPoint as any).charging_state ?? null,
    });

    // When MQTT reveals the car just woke from sleep, set wake-hint so the REST
    // polling loop immediately fetches fresh data (temperatures, locked state, etc.)
    // that MQTT may have buffered stale values for.
    if (justWoke) {
      await (this.redis as any).set(`tesla:wake-hint:${vehicleId}`, '1', 'EX', 180);
      this.logger.log(`[Pipeline] Vehicle ${vehicleId} wake detected via MQTT — wake-hint set`);
    }

    this.logger.debug(`[${traceId}] t+${Date.now()-_t0}ms: stateMachine done`);

    // 3b) Event engine + detectors — one unified pass per point.
    //
    //   Order of operations for each telemetry point:
    //     1. TelemetryEventEngine.process()  — classify high-level state
    //        (IDLE / DRIVING / CHARGING), fire cross-domain transition handlers
    //        (DRIVING→CHARGING closes open trip; CHARGING→DRIVING closes open session)
    //     2. TripDetectorService             — always called; manages IDLE/DRIVING/STOPPING
    //        sub-state and creates / finalizes trip records
    //     3. ChargingDetectorService         — always called; manages isCharging sub-state
    //        and creates / finalizes charging session records
    //
    //   Why call both sub-detectors unconditionally (not only the "active" one)?
    //     - Both detectors maintain their own state machines that need updating even when
    //       the vehicle is in the opposite domain (e.g., TripDetector needs to keep its
    //       rolling speed/power history fresh while the car is charging so it starts
    //       correctly when the car departs).
    //     - The sub-detectors already guard against acting on irrelevant points.
    for (const point of toProcess) {
      const pointTs = point.timestamp
        ? new Date(point.timestamp as unknown as Date).toISOString()
        : new Date().toISOString();

      // ── Step 1: Classify state + fire transition hooks ──────────────────
      let telState: TelemetryVehicleState = TelemetryVehicleState.IDLE;
      try {
        telState = await this.eventEngine.process(vehicleId, {
          speed:               point.speed,
          power:               point.power,
          soc:                 point.soc,
          charging_state:      point.charging_state ?? (point as any).charging_state ?? null,
          timestamp:           pointTs,
          charge_energy_added: (point as any).charge_energy_added ?? null,
        });
      } catch (e: any) {
        this.logger.error(`EventEngine error for ${vehicleId}: ${e.message}`);
        this.metrics?.detectorErrors.inc({ detector: 'event_engine' });
      }

      // ── Step 2: Trip detector (always — manages sub-state) ──────────────
      try {
        await this.tripDetector.checkTripState(vehicleId, {
          speed:               point.speed,
          power:               point.power,
          soc:                 point.soc,
          latitude:            point.latitude,
          longitude:           point.longitude,
          odometer:            point.odometer ?? undefined,
          charging_state:      point.charging_state ?? (point as any).charging_state,
          shift_state:         point.shift_state    ?? (point as any).shift_state,
          charge_energy_added: (point as any).charge_energy_added ?? null,
          timestamp:           pointTs,
        });
      } catch (e: any) {
        this.logger.error(`TripDetector error for ${vehicleId}: ${e.message}`);
        this.metrics?.detectorErrors.inc({ detector: 'trip' });
        await (this.redis as any).lpush('dlq:jobs:telemetry', JSON.stringify({
          jobName: 'pipeline:trip-detector',
          traceId,
          data: { vehicleId, data: point },
          error: e.message,
          failedAt: new Date().toISOString(),
        })).catch(() => {});
      }

      // ── Step 3: Charging detector (always — manages sub-state) ──────────
      try {
        await this.chargingDetector.checkChargingState(vehicleId, {
          charging_state:      point.charging_state ?? (point as any).charging_state,
          power:               point.power,
          current:             point.current,
          voltage:             point.voltage,
          soc:                 point.soc,
          lat:                 point.latitude  ?? null,
          lng:                 point.longitude ?? null,
          speed:               point.speed     ?? null,
          charger_type:        (point as any).charger_type,
          fast_charger_type:   (point as any).fast_charger_type ?? null,
          fast_charger_brand:  (point as any).fast_charger_brand ?? null,
          charge_energy_added: (point as any).charge_energy_added ?? null,
          timestamp:           pointTs,
        });
      } catch (e: any) {
        this.logger.error(`ChargingDetector error for ${vehicleId}: ${e.message}`);
        this.metrics?.detectorErrors.inc({ detector: 'charging' });
        await (this.redis as any).lpush('dlq:jobs:telemetry', JSON.stringify({
          jobName: 'pipeline:charging-detector',
          traceId,
          data: { vehicleId, data: point },
          error: e.message,
          failedAt: new Date().toISOString(),
        })).catch(() => {});
      }
    }

    this.logger.debug(`[${traceId}] t+${Date.now()-_t0}ms: detector loop done`);

    // 3c) Vehicle state cache — lightweight snapshot of latest values for fast reads
    //     by TripEngineV2, WebSocket emitters, and frontend polling.
    //     Before writing: check for auto-recovery (vehicle was OFFLINE, now back online).
    const latest = toProcess[toProcess.length - 1];

    const nextState = {
      speed:          latest.speed ?? 0,
      soc:            latest.soc ?? null,
      charging_state: latest.charging_state ?? (latest as any).charging_state ?? null,
      lat:            latest.latitude  ?? null,
      lng:            latest.longitude ?? null,
      power:          latest.power ?? 0,
      vehicleState:   vehicleStateNow as string,
      updatedAt:      Date.now(),
    };

    try {
      const prevRaw = await (this.redis as any).get(`vehicle:state:${vehicleId}`);
      if (prevRaw) {
        const prev = JSON.parse(prevRaw);

        // Auto-recovery: was OFFLINE, now has fresh data — always emit full state
        const prevFreshnessSec = prev.updatedAt
          ? Math.floor((Date.now() - prev.updatedAt) / 1000)
          : null;
        const wasOffline = getDataQuality(prevFreshnessSec) === 'OFFLINE';
        if (wasOffline) {
          this.logger.log(`[Pipeline] Vehicle ${vehicleId} back online`);
          this.gateway?.emitVehicleOnline(vehicleId, 'REALTIME');
          // Emit full state so frontend shows fresh data without waiting for REST poll
          this.gateway?.emitTelemetryUpdate(vehicleId, {
            ...nextState,
            odometer:       (latest as any).odometer       ?? null,
            batteryRangeKm: (latest as any).batteryRangeKm ?? null,
            outsideTemp:    (latest as any).outsideTemp     ?? null,
            insideTemp:     (latest as any).insideTemp      ?? null,
            locked:         (latest as any).locked          ?? null,
          });
        } else if (this.gateway) {
          // Still online — only emit changed fields (bandwidth optimization)
          const diff: Record<string, any> = {};
          for (const field of DIFF_FIELDS) {
            if ((prev as any)[field] !== (nextState as any)[field]) {
              diff[field] = (nextState as any)[field];
            }
          }
          if (Object.keys(diff).length > 0) {
            this.gateway.emitTelemetryUpdate(vehicleId, diff);
          }
          // Immediately push state change so frontend status updates without waiting
          // for the next REST poll (15s interval).
          if ((prev as any).vehicleState !== nextState.vehicleState) {
            this.logger.log(`[Pipeline] ${vehicleId} state ${(prev as any).vehicleState} → ${nextState.vehicleState} — pushing vehicle:update`);
            this.gateway.emitVehicleStateChange(vehicleId, nextState.vehicleState);
            // Force snapshot on every state transition — captures the exact moment
            // for time-travel debugging and fast detector recovery after restart.
            this.snapshotSvc?.take(vehicleId, nextState, 'transition', true).catch(() => {});
          }
        }
      } else if (this.gateway) {
        // First point ever — emit full state
        this.gateway.emitTelemetryUpdate(vehicleId, nextState);
      }
    } catch { /* non-fatal */ }

    await (this.redis as any).set(
      `vehicle:state:${vehicleId}`,
      JSON.stringify(nextState),
      'EX', 90, // 90s — stale beyond 2 polling cycles
    ).catch(() => {});

    // Periodic snapshot (debounced to 5 min) — keeps DB in sync with Redis
    // so detectors can recover from a cold start without replaying all events.
    this.snapshotSvc?.take(vehicleId, nextState, 'pipeline').catch(() => {});

    // Heartbeat key: lightweight "last seen" timestamp for freshness checks.
    // TTL 700s (> 600s OFFLINE threshold) so it naturally expires if no data.
    await (this.redis as any).set(
      `vehicle:last_seen:${vehicleId}`,
      Date.now().toString(),
      'EX', 700,
    ).catch(() => {});

    // 4) Telemetry Aggregator Layer: delta-filter for storage
    const aggregated: CreateTelemetryPointDto[] = [];
    let deltaMs = 5_000;

    // State-aware sampling: widen window for PARKED/SLEEPING
    try {
      const state = await this.stateMachine.getVehicleState(vehicleId);
      if (state.state === VehicleState.PARKED) {
        deltaMs = 60_000;
      } else if (
        state.state === VehicleState.SLEEPING ||
        state.state === VehicleState.OFFLINE
      ) {
        deltaMs = 300_000;
      }
    } catch {
      // fallback: use base deltaMs
    }

    let lastKept: CreateTelemetryPointDto | null = null;
    let lastKeptTime = 0;

    // Must match the detector pass (inOrder / toProcess). Aggregating `unique`
    // would persist OOO-dropped points without ever calling trip/charging
    // detectors — trips/charts then disagree (telemetry without trips).
    for (const point of inOrder) {
      const t = new Date(point.timestamp || new Date()).getTime();

      if (!lastKept) {
        aggregated.push(point);
        lastKept = point;
        lastKeptTime = t;
        continue;
      }

      const sameValues =
        point.speed === lastKept.speed &&
        point.power === lastKept.power &&
        point.soc === lastKept.soc &&
        point.batteryRangeKm === lastKept.batteryRangeKm &&
        // Never drop shift_state transitions (D→P is critical for trip split on rebuild)
        (point.shift_state ?? null) === (lastKept.shift_state ?? null);

      const closeInTime = t - lastKeptTime < deltaMs;

      const distM = this.haversineMeters(
        lastKept.latitude ?? null,
        lastKept.longitude ?? null,
        point.latitude ?? null,
        point.longitude ?? null,
      );
      const tinyMove = distM < 10;

      if (sameValues && closeInTime && tinyMove) {
        continue;
      }

      aggregated.push(point);
      lastKept = point;
      lastKeptTime = t;
    }

    this.logger.debug(`[${traceId}] t+${Date.now()-_t0}ms: aggregation done stored=${aggregated.length}`);
    await this.telemetryService.createManyTelemetryPoints(vehicleId, aggregated);

    const elapsedMs = Date.now() - _t0;
    this.metrics?.pipelineLatencyMs.observe(elapsedMs);

    this.logger.debug(
      `[${traceId}] t+${elapsedMs}ms Pipeline: ${aggregated.length} stored (raw=${points.length}, unique=${unique.length}, dropped=${points.length - unique.length} dupes) for ${vehicleId}`,
    );
  }

  /**
   * Fire-and-forget raw event persistence.
   * sha256 hash of the normalized payload is stored for fast dedup queries
   * and future replay filtering.
   */
  /**
   * Content-based dedup fingerprint.
   *
   * Canonical object covers vehicle + time + the four most discriminating
   * signals. Values are rounded to absorb float serialization noise:
   *   lat/lng  → 4 decimal places (~11 m resolution)
   *   soc/spd  → 1 decimal place
   *
   * Returns a 16-hex-char prefix of SHA-256 (64 bits).
   * Collision probability is negligible for telemetry volumes (<2^32/day).
   */
  private payloadHash(vehicleId: string, p: CreateTelemetryPointDto): string {
    const canonical = JSON.stringify({
      v:   vehicleId,
      ts:  p.timestamp ? new Date(p.timestamp as any).toISOString() : null,
      soc: p.soc   != null ? Math.round(p.soc   * 10) / 10 : null,
      spd: p.speed != null ? Math.round(p.speed * 10) / 10 : null,
      lat: p.latitude  != null ? Math.round(p.latitude  * 10000) / 10000 : null,
      lng: p.longitude != null ? Math.round(p.longitude * 10000) / 10000 : null,
      pwr: p.power != null ? Math.round(p.power) : null,
      chg: (p as any).charging_state ?? null,
      shf: (p as any).shift_state ?? null,
      cea: (p as any).charge_energy_added != null
        ? Math.round(Number((p as any).charge_energy_added) * 1000) / 1000
        : null,
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  private async saveRawBatch(
    vehicleId: string,
    points: CreateTelemetryPointDto[],
    source: string,
  ): Promise<void> {
    if (!points.length) return;
    const receivedAt = new Date();
    const rows = points.map((p) => {
      const normalized = JSON.stringify(p);
      const payloadHash = createHash('sha256').update(normalized).digest('hex');
      return {
        vehicleId,
        source,
        receivedAt,
        payload:     p as any,
        payloadHash,
      };
    });
    await this.prisma.telemetryRaw.createMany({ data: rows, skipDuplicates: true });
  }

  /**
   * Returns true for points that must be processed even if they arrive out of
   * chronological order.  These are state-change signals whose omission would
   * leave a state machine stuck (e.g. open charging session that never closes).
   *
   * Heuristics (conservative — false positives only waste a detector call):
   *  - Charging state: Disconnected / Complete / Stopped  → always end a session
   *  - shift_state present             → driving state change (trip start/stop)
   *  - Supercharger / fast-charge flag → session start candidate
   */
  private isCriticalEvent(p: CreateTelemetryPointDto): boolean {
    const cs = (p as any).charging_state as string | null | undefined;
    if (cs === 'Disconnected' || cs === 'Complete' || cs === 'Stopped') return true;
    if ((p as any).shift_state != null) return true;
    if ((p as any).fast_charger_type != null) return true;
    return false;
  }

  private haversineMeters(
    lat1: number | null,
    lon1: number | null,
    lat2: number | null,
    lon2: number | null,
  ): number {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return 0;
    const R = 6_371_000;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Stores epoch ms of the earliest lock contention since the last successful replay.
   * Extends TTL on every contention while preserving the oldest timestamp.
   */
  private async markRawReplayPending(vehicleId: string): Promise<void> {
    const key = `pipeline:raw_replay_pending:${vehicleId}`;
    const nowMs = Date.now();
    const existing = await (this.redis as any).get(key).catch(() => null);
    let pendingAtMs = nowMs;
    if (existing != null && String(existing) !== '1') {
      const ex = parseInt(String(existing), 10);
      // Ignore tiny integers (legacy flag was "1", not epoch ms)
      if (!Number.isNaN(ex) && ex > 1_000_000_000_000) {
        pendingAtMs = Math.min(ex, nowMs);
      }
    }
    await (this.redis as any).set(
      key,
      String(pendingAtMs),
      'EX',
      RAW_REPLAY_PENDING_TTL_SEC,
    );
  }

  /**
   * If another worker hit pipeline lock contention, it only wrote telemetry_raw.
   * After this worker releases the lock, replay a recent raw window through the
   * full pipeline so detectors and telemetry_points stay aligned.
   */
  private async scheduleBackfillIfNeeded(vehicleId: string): Promise<void> {
    const pendingKey = `pipeline:raw_replay_pending:${vehicleId}`;
    const pendingRaw = await (this.redis as any).get(pendingKey).catch(() => null);
    if (!pendingRaw) return;

    const cooldownKey = `pipeline:raw_replay_cooldown:${vehicleId}`;
    const cd = await (this.redis as any).set(
      cooldownKey,
      '1',
      'EX',
      RAW_REPLAY_COOLDOWN_SEC,
      'NX',
    );
    if (cd !== 'OK') return;

    try {
      const pendingAtMs = this.parseRawReplayPendingAt(String(pendingRaw));
      await this.replayRecentRawThroughPipeline(vehicleId, pendingAtMs);
      await this.redis.del(pendingKey).catch(() => {});
    } catch (e: any) {
      this.logger.error(`Raw replay failed for ${vehicleId}: ${e?.message ?? e}`);
      await this.redis.del(cooldownKey).catch(() => {});
    }
  }

  /** Epoch ms when contention started, or null → use default lookback window */
  private parseRawReplayPendingAt(raw: string): number | null {
    if (raw === '1') return null;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n <= 0 || n < 1_000_000_000_000) return null;
    return n;
  }

  private rawPayloadToDto(payload: unknown): CreateTelemetryPointDto | null {
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const o = payload as Record<string, unknown>;
    const ts = o.timestamp;
    let timestamp: Date | undefined;
    if (ts instanceof Date) timestamp = ts;
    else if (typeof ts === 'string' || typeof ts === 'number') {
      const d = new Date(ts);
      if (!Number.isNaN(d.getTime())) timestamp = d;
    }
    if (timestamp == null) return null;
    const out = { ...o } as CreateTelemetryPointDto;
    out.timestamp = timestamp;
    return out;
  }

  /**
   * @param pendingAtMs  epoch ms when contention was first recorded; null → env/default lookback
   */
  private async replayRecentRawThroughPipeline(
    vehicleId: string,
    pendingAtMs: number | null,
  ): Promise<void> {
    const now = Date.now();
    const defaultLb =
      Number(process.env.TELEMETRY_RAW_REPLAY_LOOKBACK_MS ?? String(RAW_REPLAY_DEFAULT_LOOKBACK_MS)) ||
      RAW_REPLAY_DEFAULT_LOOKBACK_MS;

    let sinceMs: number;
    if (pendingAtMs != null) {
      // Include ~1 min before first contention; cap how far back we scan
      sinceMs = pendingAtMs - 60_000;
      const minSince = now - RAW_REPLAY_MAX_SPAN_MS;
      sinceMs = Math.max(sinceMs, minSince);
      sinceMs = Math.min(sinceMs, now);
    } else {
      sinceMs = now - defaultLb;
    }
    const since = new Date(sinceMs);

    let cursorReceivedAt: Date | undefined;
    let cursorId: string | undefined;
    let totalRows = 0;
    let totalPiped = 0;

    while (totalRows < RAW_REPLAY_MAX_ROWS) {
      const pageTake = Math.min(RAW_REPLAY_DB_PAGE, RAW_REPLAY_MAX_ROWS - totalRows);
      const rows = await this.prisma.telemetryRaw.findMany({
        where: {
          vehicleId,
          receivedAt: { gte: since },
          ...(cursorReceivedAt && cursorId
            ? {
                OR: [
                  { receivedAt: { gt: cursorReceivedAt } },
                  {
                    AND: [
                      { receivedAt: cursorReceivedAt },
                      { id: { gt: cursorId } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        take: pageTake,
        select: { id: true, receivedAt: true, payload: true },
      });

      if (!rows.length) break;

      const points: CreateTelemetryPointDto[] = [];
      for (const r of rows) {
        const dto = this.rawPayloadToDto(r.payload);
        if (dto) points.push(dto);
      }

      totalRows += rows.length;
      totalPiped += points.length;

      for (let i = 0; i < points.length; i += MAX_BATCH_SIZE) {
        const chunk = points.slice(i, i + MAX_BATCH_SIZE);
        await this.processBatch(vehicleId, chunk, 'replay');
      }

      const last = rows[rows.length - 1];
      cursorReceivedAt = last.receivedAt;
      cursorId = last.id;
      if (rows.length < pageTake) break;
    }

    if (!totalRows) {
      this.logger.debug(
        `Raw replay for ${vehicleId}: no rows in telemetry_raw since ${since.toISOString()}`,
      );
      return;
    }

    this.logger.log(
      `Raw replay for ${vehicleId}: ${totalPiped}/${totalRows} usable raw row(s) ` +
        `since ${since.toISOString()} (lock-contention recovery, paged)`,
    );
  }
}
