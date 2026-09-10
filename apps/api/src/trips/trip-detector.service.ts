import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { PrismaService } from '../prisma/prisma.service';
import { BatteryAnalyticsService } from '../battery/battery-analytics.service';
import { EnergyAnalyticsService } from '../analytics/energy-analytics.service';
import { GeocodingService } from '../geocoding/geocoding.service';
import { TelemetryGateway } from '../websockets/telemetry.gateway';
import { TripState } from './trip-state.enum';
import { TripPostProcessorService } from './trip-post-processor.service';
import { FeatureBuilderService } from '../ml/feature-builder.service';
import { EventStoreService } from '../events/event-store.service';
import { KalmanGpsFilter } from './kalman-gps.filter';
import { TariffResolverService } from '../charging/tariff-resolver.service';
import {
  TripBuilderService,
  TripBuffer,
  BufferedPoint,
  computeDistanceKm,
  haversineKm,
  encodePolyline,
  douglasPeucker,
  interpolatePoints,
} from './trip-builder.service';

/**
 * TripDetectorService — Primary trip engine: authoritative DB writer.
 *
 * Runs in the batch telemetry pipeline ('api-workers' consumer group).
 * All trip records and trip_points in PostgreSQL originate here.
 * For real-time WebSocket events (0 ms latency), see TripEngineV2Service.
 *
 * State machine:
 * ┌─────────┐  gear D/R OR 2× speed>5  ┌─────────┐  multi-signal stop  ┌──────────┐
 * │  IDLE   │──────────────────────────▶│ DRIVING │────────────────────▶│ STOPPING │
 * └─────────┘                           └─────────┘                     └──────────┘
 *      ▲                                     ▲  ◀──── speed>3 (resume) ──────┘  │
 *      └─────────────────────────────────────┴──── gear P ≥30s OR 3min ─────────┘
 *                                                  OR charger plugged
 *
 * Multi-signal STOPPING:
 *   speed < 2 km/h  AND  |power| < 5 kW  (filters creep, slope, autopilot)
 *
 * Gap handling:
 *   60 s – 5 min  →  interpolate at 10 s steps, stay in DRIVING
 *   5 min – 6 min →  stay in DRIVING, mark gap, skip energy
 *   > 6 min       →  force-end trip (covers Tesla sleeping mid-park)
 *
 * DB write strategy (TripBuilder pattern):
 *   • trip record created in DB immediately on start (for real-time WebSocket)
 *   • trip_points buffered in memory until trip ends
 *   • at finalize: bulk createMany + update trip record in one round-trip
 *   • rollback (false start < 100 m): single deleteMany + delete trip
 */
@Injectable()
export class TripDetectorService {
  private readonly logger = new Logger(TripDetectorService.name);
  // TezLab-like calibration: split on real parking pauses, avoid over-splitting in traffic.
  private readonly STOP_TIMEOUT_CITY_MS: number;
  private readonly STOP_TIMEOUT_HIGHWAY_MS: number;
  private readonly PAUSE_SPLIT_CITY_MS: number;
  private readonly PAUSE_SPLIT_HIGHWAY_MS: number;
  private readonly PAUSE_SPLIT_RADIUS_KM: number;
  /** Telemetry gap threshold to force-end a trip (signal loss). Kept separate from
   *  PAUSE_SPLIT_CITY_MS so that a 3-min red-light stop doesn't kill the trip. */
  private readonly FORCE_END_GAP_MS: number;
  // Presentation-level grouping thresholds (sessionId)
  private readonly SESSION_MAX_GAP_MS: number;
  private readonly SESSION_MAX_DIST_KM: number;

  private readonly cache = new Map<string, DetectorCache>();
  /** Per-vehicle battery capacity (kWh), populated at trip start to avoid hardcoded 75 kWh */
  private readonly batteryKwhByVehicle = new Map<string, number>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly geocoding: GeocodingService,
    private readonly tripBuilder: TripBuilderService,
    private readonly kalman: KalmanGpsFilter,
    private readonly configService: ConfigService,
    @Optional() private readonly batteryAnalytics?: BatteryAnalyticsService,
    @Optional() private readonly energyAnalytics?: EnergyAnalyticsService,
    @Optional() private readonly telemetryGateway?: TelemetryGateway,
    @Optional() private readonly tripPostProcessor?: TripPostProcessorService,
    @Optional() private readonly featureBuilder?: FeatureBuilderService,
    @Optional() private readonly eventStore?: EventStoreService,
    private readonly tariffResolver?: TariffResolverService,
  ) {
    this.STOP_TIMEOUT_CITY_MS = this.numCfg('TRIP_STOP_TIMEOUT_CITY_MS', 240_000);
    this.STOP_TIMEOUT_HIGHWAY_MS = this.numCfg('TRIP_STOP_TIMEOUT_HIGHWAY_MS', 480_000);
    this.PAUSE_SPLIT_CITY_MS = this.numCfg('TRIP_PAUSE_SPLIT_CITY_MS', 180_000);
    this.PAUSE_SPLIT_HIGHWAY_MS = this.numCfg('TRIP_PAUSE_SPLIT_HIGHWAY_MS', 300_000);
    this.PAUSE_SPLIT_RADIUS_KM = this.numCfg('TRIP_PAUSE_SPLIT_RADIUS_KM', 0.30);
    // Force-end gap is separate from pause-split: a telemetry silence ≥ 6 min
    // (e.g. Tesla sleeping mid-park) ends the trip; a 3-min red light does not.
    this.FORCE_END_GAP_MS = this.numCfg('TRIP_FORCE_END_GAP_MS', 6 * 60_000);
    this.SESSION_MAX_GAP_MS = this.numCfg('TRIP_SESSION_MAX_GAP_MS', 6 * 60_000);
    this.SESSION_MAX_DIST_KM = this.numCfg('TRIP_SESSION_MAX_DIST_KM', 0.8);
  }

  // ─────────────────────── Public entry point ───────────────────────────────

  async checkTripState(
    vehicleId: string,
    data: {
      speed?: number;
      power?: number | null;
      soc?: number;
      latitude?: number;
      longitude?: number;
      odometer?: number;
      charging_state?: string;
      shift_state?: string;
      timestamp?: string;
      charge_energy_added?: number | null;
    },
  ): Promise<void> {
    // Distributed lock: prevents race conditions when multiple API instances run.
    // If another instance is processing this vehicle right now, skip silently.
    const lockKey = `lock:trip:${vehicleId}`;
    // ioredis v5 overload: set(key, value, 'PX', ms, 'NX') → 'OK' | null
    const acquired = await (this.redis as any).set(lockKey, '1', 'PX', 5_000, 'NX');
    if (!acquired) return;
    try {
      await this._checkTripStateInner(vehicleId, data);
      await this.persistDetectorState(vehicleId);
    } finally {
      await this.redis.del(lockKey);
    }
  }

  private async _checkTripStateInner(
    vehicleId: string,
    data: {
      speed?: number;
      power?: number | null;
      soc?: number;
      latitude?: number;
      longitude?: number;
      odometer?: number;
      charging_state?: string;
      shift_state?: string;
      timestamp?: string;
      charge_energy_added?: number | null;
    },
  ): Promise<void> {
    const speed = data.speed ?? 0;
    const power = data.power ?? 0;
    const lat = data.latitude ?? null;
    const lon = data.longitude ?? null;
    const shift = data.shift_state ?? null;
    const now = data.timestamp ? new Date(data.timestamp) : new Date();
    const powerKnown = data.power != null && data.power !== 0;

    // isPlugged: real charging session (not HVAC preconditioning / balancing < 1 kW)
    // Primary signal: charge_energy_added growing (Tesla cumulative kWh this session)
    // Fallback: charger power >= 1 kW (handles older API responses without energy field)
    const prevCEA = this.cache.get(vehicleId)?.prevChargeEnergyAdded ?? null;
    const chargeEnergyGrowing = data.charge_energy_added != null && prevCEA != null
      && data.charge_energy_added > prevCEA;
    const isPlugged = (data.charging_state === 'Charging' || data.charging_state === 'Complete') && (
      chargeEnergyGrowing || Math.abs(data.power ?? 0) >= 1.0
    );

    // ── Bootstrap cache on first call ─────────────────────────────────────
    let prev = this.cache.get(vehicleId);
    if (!prev) {
      // Fast-path recovery: restore detector cache snapshot from Redis.
      const persisted = await this.loadPersistedDetectorState(vehicleId);
      if (persisted) {
        prev = persisted;
      }
      // Check if there's an active trip in DB (process restart recovery)
      if (!prev) {
        const dbTrip = await this.prisma.trip.findFirst({
          where: { vehicleId, endTime: null },
        });
        if (dbTrip && !this.tripBuilder.has(vehicleId)) {
          this.tripBuilder.restoreFromDb(vehicleId, dbTrip.id, dbTrip.startTime, dbTrip.startSoc ?? 0);
          // Use trip startTime as lastTime so gap-detection fires correctly on the next point.
          // Without this, dtMs=0 on first point after restart → long-gap force-end never triggers.
          prev = makeEmptyCache(dbTrip.startTime, TripState.DRIVING);
        } else {
          prev = makeEmptyCache(now, TripState.IDLE);
        }
      }
      this.cache.set(vehicleId, prev);
    }

    // ── Telemetry gap — 3-mode handling ──────────────────────────────────
    // Mode 1: < gapThreshold  → normal, no special handling
    // Mode 2: gapThreshold–FORCE_END_GAP_MS → low-confidence, stay in state, skip energy
    // Mode 3: > FORCE_END_GAP_MS → force-end any active trip (true signal loss)
    const dtMs = Math.max(0, now.getTime() - (prev.lastTime ?? now).getTime());

    // Dynamic gap threshold: adapts to actual polling cadence instead of a hardcoded 60 s.
    // Tesla Fleet Telemetry fires every ~10 s; REST polling is 60–300 s depending on state.
    // A gap that looks "big" on Fleet Telemetry (2× median ≈ 20 s) would be perfectly
    // normal on REST poll (2× median ≈ 180 s).  Using the median of the last 10 observed
    // intervals automatically calibrates to whichever ingest path is active.
    //
    // Floor: 60 s — never treat a normal REST poll as a gap.
    // Ceiling: FORCE_END_GAP_MS / 3 — leave headroom before the hard force-end.
    const newIntervalHistory: number[] = dtMs > 0 && dtMs < this.FORCE_END_GAP_MS
      ? [...(prev.intervalHistory ?? []).slice(-9), dtMs]
      : (prev.intervalHistory ?? []);
    // Mutate prev so all downstream cache.set({...prev}) calls carry the updated history.
    prev = { ...prev, intervalHistory: newIntervalHistory };

    // Use max(median×2.5, lastInterval×1.2) to handle outlier last intervals.
    // Edge-case: history=[10s,10s,10s,300s] → median=10s → threshold=25s, BUT the
    // car just sent a 300s gap, so threshold should be max(25, 360) = 360s.
    // Without the lastInterval guard, a single 300s gap would itself be flagged
    // as a "gap" and incorrectly end a trip that's in a REST-poll window.
    const lastInterval = newIntervalHistory.length > 0
      ? newIntervalHistory[newIntervalHistory.length - 1]!
      : 0;
    const dynamicGapMs = newIntervalHistory.length >= 3
      ? Math.min(
          Math.max(
            60_000,
            median(newIntervalHistory) * 2.5,
            lastInterval * 1.2,          // don't flag the current interval as a gap
          ),
          this.FORCE_END_GAP_MS / 3,
        )
      : 60_000;

    const isGap = dtMs > dynamicGapMs;
    // isMidGap: gap too long to treat as normal but short enough not to force-end.
    // isLongGap: true signal loss — force-end any active trip.
    // FORCE_END_GAP_MS (default 10 min) is kept separate from PAUSE_SPLIT_CITY_MS
    // (3 min) so a long red light / brief stop does NOT terminate the trip.
    const isMidGap = dtMs > dynamicGapMs && dtMs < this.FORCE_END_GAP_MS;
    const isLongGap = dtMs >= this.FORCE_END_GAP_MS;

    if (this.tripBuilder.has(vehicleId) && isLongGap) {
      const buf = this.tripBuilder.getBuffer(vehicleId)!;
      this.logger.warn(
        `[Trip] ${Math.round(dtMs / 1000)}s gap for ${vehicleId} — force-ending trip ${buf.dbTripId} (reason: SIGNAL_LOSS)`,
      );
      // Always pass 'now' (force-end trigger time) — finalizeTripToDb will determine
      // the correct endTime internally based on whether odometer fallback is used.
      await this.finalizeTripToDb(vehicleId, data, now, buf.dbTripId);
      this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
      // Cooldown: prevent immediate trip restart after signal loss (90 s)
      const cached = this.cache.get(vehicleId)!;
      cached.gapCooldownUntil = new Date(now.getTime() + 90_000);
      return;
    }

    // Mid-gap (60 s–5 min): stay in current state, update time, skip transitions.
    // Exception: if the car is in STOPPING state and the idle timeout elapsed during
    // the gap, finalize the trip now — otherwise the timeout is silently bypassed
    // and the car can incorrectly "resume" driving after the gap.
    // Sparse-history exception:
    // when backfilling low-frequency telemetry (2-5 min points), freezing DRIVING
    // on every mid-gap hides real stop windows and merges distinct trips.
    // If the current point is clearly stationary, allow normal FSM transitions.
    const sparseStopCandidate = prev.tripState === TripState.DRIVING && speed < 1 && Math.abs(power) < 3;
    if (isMidGap && prev.tripState !== TripState.IDLE && !sparseStopCandidate) {
      // Generic split guard for sparse telemetry:
      // if we already observed a stop marker (idleSince), the gap is >= city split
      // threshold, and the current point is clearly moving again, split now.
      if (
        this.tripBuilder.has(vehicleId) &&
        prev.idleSince &&
        dtMs >= this.PAUSE_SPLIT_CITY_MS &&
        speed > 15
      ) {
        const buf = this.tripBuilder.getBuffer(vehicleId)!;
        this.logger.log(
          `[Trip] Mid-gap idle-resume (${Math.round(dtMs / 1000)}s, nowSpeed=${speed.toFixed(1)}) for ${vehicleId} — splitting trip`,
        );
        await this.finalizeTripToDb(vehicleId, { ...data, soc: prev.socAtStop ?? data.soc }, prev.idleSince, buf.dbTripId);
        this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
        return;
      }

      if (prev.tripState === TripState.STOPPING && prev.idleSince && this.tripBuilder.has(vehicleId)) {
        const idleMs = now.getTime() - prev.idleSince.getTime();
        const avgSpeedRecent = rollingAvgSpeed(prev.recentSpeeds, now, 300_000);
        const isHighway = avgSpeedRecent > 50;
        const stopTimeoutMs = isHighway ? this.STOP_TIMEOUT_HIGHWAY_MS : this.STOP_TIMEOUT_CITY_MS;
        const buf = this.tripBuilder.getBuffer(vehicleId)!;
        if (idleMs > stopTimeoutMs) {
          this.logger.log(
            `[Trip] STOPPING timeout (${Math.round(idleMs / 1000)}s) elapsed during mid-gap for ${vehicleId} — finalizing`,
          );
          await this.finalizeTripToDb(vehicleId, { ...data, soc: prev.socAtStop ?? data.soc }, prev.idleSince, buf.dbTripId);
          this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
          return;
        }
        // Pause-at-point during mid-gap: if the car was stopped longer than the
        // pause-split threshold AND is now clearly moving, end the old trip and let
        // normal FSM detection start a fresh one on the next point.
        // This catches the common case where telemetry has 1-min resolution and
        // a real parking stop (4–7 min) falls between stop-timeout and pause-split.
        // Reconciler-aligned guard: if the car was genuinely parked for at least the
        // city pause-split threshold and then clearly moved again, split the trip.
        // Using pauseSplitMs (3 min city / 5 min highway) avoids splitting on
        // traffic lights — a 90 s idle followed by a gap looks identical to a red light.
        const pauseSplitMs = isHighway ? this.PAUSE_SPLIT_HIGHWAY_MS : this.PAUSE_SPLIT_CITY_MS;
        const normalStopResumed =
          idleMs > pauseSplitMs &&
          speed > 5;
        if (normalStopResumed) {
          this.logger.log(
            `[Trip] Mid-gap normal-stop resume (${Math.round(idleMs / 1000)}s, nowSpeed=${speed.toFixed(1)}) for ${vehicleId} — splitting trip`,
          );
          await this.finalizeTripToDb(vehicleId, { ...data, soc: prev.socAtStop ?? data.soc }, prev.idleSince, buf.dbTripId);
          this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
          return;
        }
        if (idleMs >= pauseSplitMs && speed > 5) {
          this.logger.log(
            `[Trip] Pause-at-point (${Math.round(idleMs / 1000)}s) during mid-gap for ${vehicleId} — splitting trip`,
          );
          await this.finalizeTripToDb(vehicleId, { ...data, soc: prev.socAtStop ?? data.soc }, prev.idleSince, buf.dbTripId);
          this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
          return;
        }
      }
      // DRIVING-state pause detection: with 1-min telemetry the smoothing window
      // keeps smoothSpeed high even after the car stops, so the state never
      // reaches STOPPING. Detect this via: large gap + last point was stopped + now driving.
      if (
        prev.tripState === TripState.DRIVING &&
        this.tripBuilder.has(vehicleId) &&
        dtMs >= this.PAUSE_SPLIT_CITY_MS &&   // gap itself >= 3 min (shortest split threshold)
        (prev.speed ?? 0) < 2 &&             // car was stopped at end of gap
        Math.abs(prev.power ?? 0) < 3 &&     // and not using power (not creeping/regen)
        speed > 15                            // and is now clearly driving
      ) {
        this.logger.log(
          `[Trip] Mid-gap stopped→driving (gap=${Math.round(dtMs / 1000)}s, prevSpeed=${prev.speed?.toFixed(1)}, nowSpeed=${speed.toFixed(1)}) for ${vehicleId} — splitting trip`,
        );
        const buf = this.tripBuilder.getBuffer(vehicleId)!;
        // End the trip at the last known point (car was stopped), not at now
        await this.finalizeTripToDb(vehicleId, { ...data, soc: prev.socAtStop ?? data.soc }, prev.lastTime!, buf.dbTripId);
        this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
        return;
      }

      this.logger.debug(`[Trip] Mid-gap ${Math.round(dtMs / 1000)}s for ${vehicleId} — holding state`);
      // Still record the GPS point in the trip buffer even during a mid-gap.
      // State transitions are frozen, but we do want to capture the actual
      // speed/location so that: (a) GPS distance is accurate, (b) the last
      // buffer point reflects whether the car was moving or stopped when the
      // gap ended (critical for correct endTime computation via actualEndTime).
      if (this.tripBuilder.has(vehicleId) && lat != null && lon != null) {
        const { lat: rLat, lon: rLon, smoothLat, smoothLon } = this.smoothGps(vehicleId, lat, lon, now);
        this.tripBuilder.addPoint(vehicleId, {
          timestamp:    now,
          speed,
          power:        data.power ?? null,
          soc:          data.soc ?? null,
          latitude:     rLat,
          longitude:    rLon,
          smoothLat,
          smoothLng:    smoothLon,
          elevationM:   (data as any).elevationM ?? null,
          interpolated: false,
        }, dtMs);
      }
      this.cache.set(vehicleId, {
        ...prev,
        lastTime: now,
        gapAccumMs: (prev.gapAccumMs ?? 0) + dtMs,
      });
      return;
    }

    // ── EMA power smoothing + incremental energy integral ────────────────
    // EMA on instantaneous power before integration filters sensor spikes.
    // alpha = 0.3 → each new reading contributes 30%, history 70%.
    const ALPHA_POWER = 0.3;
    const newEmaPower = prev.emaPower === undefined
      ? power  // cold start: seed with first reading, no lag
      : ALPHA_POWER * power + (1 - ALPHA_POWER) * prev.emaPower;

    const dtHours = dtMs / 3_600_000;
    const canIntegrate = !isPlugged && !isGap && dtHours > 0 && dtHours < 0.5;
    const deltaEnergy = canIntegrate ? newEmaPower * dtHours : 0;
    const energyKwh = prev.energyKwh + deltaEnergy;

    // Regen: power < −10 kW + speed > 5 km/h (filters BMS balancing noise on Model Y)
    const regenDelta = canIntegrate && power < -10 && speed > 5 ? Math.abs(power) * dtHours : 0;
    const regenKwh = (prev.regenKwh ?? 0) + regenDelta;

    this.tripBuilder.updateEnergy(vehicleId, energyKwh);

    // ── Rolling speed window (last 5 min, trimmed every step) ────────────
    const SPEED_WINDOW_MS = 5 * 60_000;
    const recentSpeeds: SpeedSample[] = [
      ...prev.recentSpeeds.filter(s => now.getTime() - s.ts <= SPEED_WINDOW_MS),
      { speed, ts: now.getTime() },
    ];
    // Keep at most 60 samples (1 per 5s at default polling) to bound memory
    if (recentSpeeds.length > 60) recentSpeeds.splice(0, recentSpeeds.length - 60);

    const avgSpeed60s = rollingAvgSpeed(recentSpeeds, now, 60_000);   // last 1 min
    const avgSpeed5min = rollingAvgSpeed(recentSpeeds, now, 300_000);  // last 5 min
    // Highway context: car was recently cruising at highway speeds
    const isHighwayContext = avgSpeed5min > 50;

    // ── Signal smoothing ──────────────────────────────────────────────────
    // Keep last 5 speed/power samples and last 3 SOC samples.
    // Use smoothed values for all state-machine decisions to filter noise.
    const speedHistory = [...(prev.speedHistory.slice(-4)), speed];
    const powerHistory = [...(prev.powerHistory.slice(-4)), power];
    const socHistory = [...(prev.socHistory.slice(-2)), ...(data.soc != null ? [data.soc] : [])];

    const smoothSpeed = movingAvg(speedHistory);
    const smoothPower = median(powerHistory);
    // smoothedSoc is only used for energy confidence, not state decisions

    // ── Confidence ────────────────────────────────────────────────────────
    const gpsOk = lat !== null && lon !== null;
    const confidence = computeConfidence(speed, avgSpeed60s, powerKnown, gpsOk, dtMs);

    // ── Two-threshold confidence hysteresis ───────────────────────────────
    // < 0.3 → hard ignore: point is too noisy to process at all (don't update cache)
    // 0.3–0.6 → freeze: update cache values but skip state transitions
    // ≥ 0.6 → allow transitions
    //
    // EXCEPTION: when the car is clearly stationary (speed < 0.5 km/h) we bypass
    // confidence checks entirely so the DRIVING → STOPPING transition fires even
    // when GPS and power are absent (both are unavailable on a parked Tesla).
    const isClearlyStationary = speed < 0.5;

    if (confidence < 0.3 && !isClearlyStationary) {
      this.logger.debug(
        `[Trip] Hard-ignored point for ${vehicleId} (confidence=${confidence.toFixed(2)})`,
      );
      return;
    }

    if (confidence < 0.6 && !isClearlyStationary && prev.tripState === TripState.DRIVING) {
      this.logger.debug(
        `[Trip] Frozen state for ${vehicleId} (confidence=${confidence.toFixed(2)})`,
      );
      this.cache.set(vehicleId, {
        ...prev,
        speed, power, lat, lon, shiftState: shift,
        lastTime: now, energyKwh, regenKwh,
        recentSpeeds, speedHistory, powerHistory, socHistory,
        lastConfidence: confidence,
        prevChargeEnergyAdded: data.charge_energy_added ?? prev.prevChargeEnergyAdded,
        emaPower: newEmaPower,
      });
      return;
    }

    // ── GPS displacement ──────────────────────────────────────────────────
    const dispM = gpsOk ? haversineKm(prev.lat, prev.lon, lat, lon) * 1000 : Infinity;

    // ── Multi-signal stop / resume detection using SMOOTHED signals ───────
    // Stop variance: if speed history shows high variance (car oscillating between
    // 0 and 10 km/h), we require more confidence before calling it a stop.
    const speedVariance = variance(speedHistory);
    const highVariance = speedVariance > 25; // > 5 km/h std-dev

    // Confidence is intentionally NOT required here — when parked, Tesla stops sending
    // GPS and power data, dropping confidence to near-zero. Speed alone (+ 20-45s
    // hysteresis window below) is sufficient to confirm a real stop.
    const isStopped =
      smoothSpeed < 2 &&
      Math.abs(smoothPower) < 3 &&
      !highVariance;
    // isResuming: smoothed speed clearly back
    const isResuming = !isPlugged && smoothSpeed > 4 && (shift === 'D' || shift === 'R' || shift == null);

    // ── STATE MACHINE ──────────────────────────────────────────────────────
    switch (prev.tripState) {

      // ── IDLE ───────────────────────────────────────────────────────────────
      case TripState.IDLE: {
        // Require smoothSpeed > 5 for gear-based start. The old threshold (> 2) caused
        // ghost trips: car briefly shifts D→P at 2–3 km/h (reversing, parking manoeuvre)
        // and the detector fired immediately with no dwell, creating 0 km / 20 s trips.
        // fastStart (> 8 km/h) and the 5 km/h + dwell path still cover all real starts.
        const shiftDriving = (shift === 'D' || shift === 'R') && smoothSpeed > 5;

        // 🚀 FAST START (новый)
        const fastStart =
          smoothSpeed > 8 &&
          prev.speedHistory.slice(-2).every(s => s > 5);

        // 📊 мягкий старт (адаптивный)
        const adaptiveDwell =
          smoothSpeed > 15 ? 5000 :
            smoothSpeed > 10 ? 10000 :
              20000;

        const dwellMs = now.getTime() - prev.stateChangedAt.getTime();

        // ❄️ cooldown
        let inCooldown = prev.gapCooldownUntil != null && now < prev.gapCooldownUntil;

        // 🚀 escape cooldown если реально едет
        if (inCooldown && smoothSpeed > 15) {
          const cached = this.cache.get(vehicleId);
          if (cached) cached.gapCooldownUntil = null;
          inCooldown = false;
        }

        // ❗ ГЛАВНЫЙ FIX
        if (
          !isPlugged &&
          !inCooldown &&
          (
            fastStart ||
            shiftDriving ||
            (smoothSpeed > 5 && dwellMs > adaptiveDwell)
          )
        ) {
          // Use last known SOC from cache history when current point has null SOC.
          // Fleet telemetry sends fields at different rates — the point that triggers
          // trip start may arrive before the next UsableBatteryLevel update.
          // Defaulting to 0 would produce wrong startSoc and corrupt energy calculations.
          const startSoc = data.soc ?? prev.socHistory[prev.socHistory.length - 1] ?? null;

          // Prefer the last known parked location as the trip start when available.
          // Covers both polling-gap departures (car already on highway when first seen)
          // and cold-start GPS where the first fix has artificially low speed and a
          // wrong position — the cached parked coords are the correct "from" anchor.
          const prevWasParked = (prev.speed ?? 0) < 2 && prev.lat != null && prev.lon != null;
          const startData = prevWasParked
            ? { ...data, latitude: prev.lat!, longitude: prev.lon! }
            : data;

          const tripId = await this.startTrip(vehicleId, startData, now, startSoc);

          const tripStartLat = startData.latitude ?? lat;
          const tripStartLon = startData.longitude ?? lon;

          this.tripBuilder.start(vehicleId, {
            dbTripId: tripId,
            startSoc: startSoc ?? 0,
            startLat: tripStartLat,
            startLon: tripStartLon,
            startOdometer: data.odometer ?? null,
            now,
          });

          // Add the trip-start point immediately so GPS distance calculation
          // includes the first GPS fix (not just the second telemetry point onward).
          // Kalman filter was reset inside startTrip, so this first fix initialises it.
          const { lat: rStartLat, lon: rStartLon, smoothLat: sStartLat, smoothLon: sStartLon } =
            this.smoothGps(vehicleId, lat, lon, now);
          this.tripBuilder.addPoint(vehicleId, {
            timestamp:    now,
            speed,
            power:        data.power ?? null,
            soc:          data.soc ?? null,
            latitude:     rStartLat,
            longitude:    rStartLon,
            smoothLat:    sStartLat,
            smoothLng:    sStartLon,
            elevationM:   (data as any).elevationM ?? null,
            interpolated: false,
          }, 0);

          this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.DRIVING);

          return;
        }

        // fallback
        this.cache.set(vehicleId, {
          ...prev,
          speed,
          power,
          lat,
          lon,
          shiftState: shift,
          lastTime: now,
          energyKwh,
          recentSpeeds,
          speedHistory,
          powerHistory,
          socHistory,
          lastConfidence: confidence,
          prevChargeEnergyAdded: data.charge_energy_added ?? prev.prevChargeEnergyAdded,
          emaPower: newEmaPower,
        });

        return;
      }

      // ── DRIVING ────────────────────────────────────────────────────────────
      case TripState.DRIVING: {
        if (!this.tripBuilder.has(vehicleId)) {
          // Builder lost (e.g., rapid double-restart) — reset to IDLE
          this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
          return;
        }

        // ── Real-time GPS jump filter ─────────────────────────────────────
        // Detect teleport/GNSS glitch and null out coordinates on the bad point.
        // The point is still written to the buffer (for continuity) but with no GPS.
        let pointLat: number | null = lat;
        let pointLon: number | null = lon;
        // Only apply jump filter when car is moving — a parked car with speed=0
        // may receive a REST-poll GPS fix from a location far from the last
        // MQTT GPS point (e.g. last known home location vs. where it was driving),
        // which would incorrectly null every incoming GPS point.
        if (gpsOk && prev.lat != null && prev.lon != null && dtMs > 0 && dtMs < 180_000 && speed >= 2) {
          const distKm = haversineKm(prev.lat, prev.lon, lat!, lon!);
          const dtHrs = dtMs / 3_600_000;
          const impliedKmh = distKm / dtHrs;
          const isTeleport = distKm > 0.3 && dtMs < 5_000;
          if (impliedKmh > 200 || isTeleport) {
            this.logger.debug(`[Trip] GPS jump nulled for ${vehicleId}: ${distKm.toFixed(2)} km in ${dtMs}ms`);
            pointLat = null;
            pointLon = null;
          }
        }

        const { lat: rawLat, lon: rawLon, smoothLat: smLat, smoothLon: smLon } =
          this.smoothGps(vehicleId, pointLat, pointLon, now);
        const bufPoint: BufferedPoint = {
          timestamp: now,
          speed,
          power: data.power ?? null,
          soc: data.soc ?? null,
          latitude:  rawLat,
          longitude: rawLon,
          smoothLat: smLat,
          smoothLng: smLon,
          elevationM: (data as any).elevationM ?? null,
          interpolated: false,
        };
        this.tripBuilder.addPoint(vehicleId, bufPoint, dtMs);

        // Emit live stats + GPS to frontend on every DRIVING point (use smoothed for display)
        this.emitLive(vehicleId, speed, data.soc, smLat ?? rawLat, smLon ?? rawLon);

        // ── Charger detected while stopped → bypass hysteresis, close now ──
        // Without this, the standard 20–45 s stop-hysteresis would record those
        // seconds of charging energy inside the trip. When charging is confirmed
        // (charge_energy_added growing OR charger power ≥ 1 kW) AND car is
        // already stationary, there is no reason to wait.
        if (isPlugged && isStopped) {
          this.tripBuilder.setSocAtStop(vehicleId, data.soc ?? null);
          const buf = this.tripBuilder.getBuffer(vehicleId)!;
          this.logger.log(`[Trip] Charger detected (DRIVING) for ${vehicleId} — closing trip ${buf.dbTripId} immediately`);
          await this.finalizeTripToDb(vehicleId, data, now, buf.dbTripId);
          this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
          return;
        }

        // ── High-power stationary charging (Supercharger without charging_state) ──
        // When speed≈0 but power > 30 kW (impossible while driving), the car is
        // plugged into a DC fast charger. isStopped is false in this case because
        // |smoothPower| < 3 kW fails, so we handle it explicitly here.
        // This is a belt-and-suspenders — the event engine also detects this via
        // state transition, but may lag 1–2 polling cycles behind actual plug-in.
        if (smoothSpeed < 2 && power > 30) {
          this.tripBuilder.setSocAtStop(vehicleId, data.soc ?? null);
          const buf = this.tripBuilder.getBuffer(vehicleId)!;
          this.logger.log(`[Trip] DC fast charge detected (${power.toFixed(0)} kW) for ${vehicleId} — closing trip ${buf.dbTripId}`);
          await this.finalizeTripToDb(vehicleId, data, now, buf.dbTripId);
          this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
          return;
        }

        // ── shift=P → immediate finalize ─────────────────────────────────────
        // Explicit user requirement: close trip as soon as drivetrain switches
        // from Drive/Reverse to Park. This avoids "hanging" active trips when
        // there is no extra telemetry point 30s later.
        // Use raw speed (not smoothSpeed): after highway driving the smoothed
        // average stays high for several points, blocking this check even when
        // the car is genuinely stopped (speed=0) with shift='P'.
        if (shift === 'P' && speed < 5) {
          this.tripBuilder.setSocAtStop(vehicleId, data.soc ?? null);
          const buf = this.tripBuilder.getBuffer(vehicleId)!;
          await this.finalizeTripToDb(vehicleId, { ...data, soc: data.soc ?? prev.socAtStop ?? null }, now, buf.dbTripId);
          this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
          return;
        }

        // ── DRIVING → STOPPING with hysteresis ─────────────────────────────
        if (isStopped) {
          const attemptAt = prev.stoppingAttemptAt ?? now;
          const stoppingDurationMs = now.getTime() - attemptAt.getTime();

          // 🚀 адаптивный стоп (трасса / город)
          const requiredStopTime =
            avgSpeed5min > 70 ? 45000 :
              avgSpeed5min > 40 ? 30000 :
                20000;

          // ⛔ еще не остановился
          if (stoppingDurationMs < requiredStopTime) {
            this.cache.set(vehicleId, {
              ...prev,
              stoppingAttemptAt: attemptAt,
              lastTime: now,
              energyKwh,
              regenKwh,
              speedHistory,
              powerHistory,
            });
            return;
          }

          // ✅ ПОДТВЕРЖДЕННАЯ ОСТАНОВКА
          this.tripBuilder.setSocAtStop(vehicleId, data.soc ?? null);

          this.cache.set(vehicleId, {
            ...prev,
            tripState: TripState.STOPPING,
            speed,
            power,
            lat,
            lon,
            shiftState: shift,
            idleSince: attemptAt,
            socAtStop: data.soc ?? null,
            stopLat: lat,
            stopLon: lon,
            lastTime: now,
            energyKwh,
            regenKwh,
            recentSpeeds,
            speedHistory,
            powerHistory,
            socHistory,
            stoppingAttemptAt: null,
            lastConfidence: confidence,
            consecutiveMoving: 0,
            prevChargeEnergyAdded: data.charge_energy_added ?? prev.prevChargeEnergyAdded,
            emaPower: newEmaPower,
          });

          return;
        }

        // 🚀 ВАЖНО: RESUME (ты этого не сделал)
        if (isResuming) {
          this.cache.set(vehicleId, {
            ...prev,
            tripState: TripState.DRIVING,
            stoppingAttemptAt: null,
            lastTime: now,
            speedHistory,
            powerHistory,
          });
          return;
        }

        // Car is moving — clear any stop attempt
        this.cache.set(vehicleId, {
          ...prev, tripState: TripState.DRIVING,
          speed, power, lat, lon, shiftState: shift,
          idleSince: null, socAtStop: null, stopLat: null, stopLon: null,
          lastTime: now, energyKwh, regenKwh,
          recentSpeeds, speedHistory, powerHistory, socHistory,
          stoppingAttemptAt: null, lastConfidence: confidence,
          consecutiveMoving: 0,
          prevChargeEnergyAdded: data.charge_energy_added ?? prev.prevChargeEnergyAdded,
          emaPower: newEmaPower,
        });
        return;
      }

      // ── STOPPING ──────────────────────────────────────────────────────────
      case TripState.STOPPING: {
        if (!this.tripBuilder.has(vehicleId)) {
          this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
          return;
        }

        const idleSince = prev.idleSince ?? now;
        const idleMs = now.getTime() - idleSince.getTime();
        const socAtStop = prev.socAtStop;

        // Adaptive stop timeout — consistent with mid-gap handler above.
        // Highway context (avg speed > 50 km/h in last 5 min before stop):
        //   → 10 min, allows waiting through traffic jams on motorways.
        // City / unknown:
        //   → 5 min, covers the longest red-light cycles in DE (max 120 s),
        //     congested intersections, and brief parking-lot manoeuvres.
        //     Previously 3 min, which fragmented trips in heavy city traffic.
        // shift=P + 30 s always takes priority (unambiguous park).
        const stopTimeoutMs = isHighwayContext
          ? this.STOP_TIMEOUT_HIGHWAY_MS
          : this.STOP_TIMEOUT_CITY_MS;
        const parkConfirmed = shift === 'P';
        const timedOut = idleMs > stopTimeoutMs;
        const pauseSplitMs = isHighwayContext
          ? this.PAUSE_SPLIT_HIGHWAY_MS
          : this.PAUSE_SPLIT_CITY_MS;
        const stopPointDistKm = (prev.stopLat != null && prev.stopLon != null && lat != null && lon != null)
          ? haversineKm(prev.stopLat, prev.stopLon, lat, lon)
          : null;
        const pausedAtPoint = stopPointDistKm != null
          && stopPointDistKm <= this.PAUSE_SPLIT_RADIUS_KM
          && idleMs >= pauseSplitMs;

        if (parkConfirmed || isPlugged || timedOut || pausedAtPoint) {
          const endData = { ...data, soc: socAtStop ?? data.soc };
          const buf = this.tripBuilder.getBuffer(vehicleId)!;
          if (pausedAtPoint) {
            this.logger.log(
              `[Trip] Pause split for ${vehicleId}: idle=${Math.round(idleMs / 1000)}s, drift=${(stopPointDistKm! * 1000).toFixed(0)}m`,
            );
          }
          if (timedOut && !parkConfirmed && !isPlugged) {
            this.logger.log(
              `[Trip] STOPPING timeout (${Math.round(idleMs / 1000)}s) for ${vehicleId} — ending trip (car ${isResuming ? 'resumed' : 'still stopped'})`,
            );
          }
          // Use idleSince as endTime so parked time doesn't inflate trip duration.
          // If car resumed before timeout fired (parkConfirmed/isPlugged), use now.
          const finalizeAt = (timedOut && !parkConfirmed && !isPlugged) ? idleSince : now;
          await this.finalizeTripToDb(vehicleId, endData, finalizeAt, buf.dbTripId);
          this.resetCache(vehicleId, speed, power, lat, lon, shift, now, TripState.IDLE);
          return;
        }

        // Resume: car started moving again within the debounce window (traffic light, roundabout).
        // This check is AFTER the timeout/park guards above so a resumed-but-timed-out stop
        // correctly ends the trip instead of silently continuing it.
        if (isResuming) {
          const { lat: rResLat, lon: rResLon, smoothLat: sResLat, smoothLon: sResLon } =
            this.smoothGps(vehicleId, lat, lon, now);
          const bufPoint: BufferedPoint = {
            timestamp: now, speed,
            power: data.power ?? null, soc: data.soc ?? null,
            latitude: rResLat, longitude: rResLon,
            smoothLat: sResLat, smoothLng: sResLon,
            elevationM: (data as any).elevationM ?? null,
            interpolated: false,
          };
          this.tripBuilder.addPoint(vehicleId, bufPoint, dtMs);
          this.cache.set(vehicleId, {
            ...prev, tripState: TripState.DRIVING,
            speed, power, lat, lon, shiftState: shift,
            idleSince: null, socAtStop: null, stopLat: null, stopLon: null,
            lastTime: now, energyKwh, regenKwh,
            recentSpeeds, speedHistory, powerHistory, socHistory,
            stoppingAttemptAt: null, lastConfidence: confidence,
            consecutiveMoving: 1,
            prevChargeEnergyAdded: data.charge_energy_added ?? prev.prevChargeEnergyAdded,
            emaPower: newEmaPower,
          });
          return;
        }

        // Still in debounce window
        this.cache.set(vehicleId, {
          ...prev, tripState: TripState.STOPPING,
          speed, power, lat, lon, shiftState: shift,
          idleSince, socAtStop,
          stopLat: prev.stopLat ?? lat,
          stopLon: prev.stopLon ?? lon,
          lastTime: now, energyKwh, regenKwh,
          recentSpeeds, speedHistory, powerHistory, socHistory,
          stoppingAttemptAt: null, lastConfidence: confidence,
          consecutiveMoving: 0,
          prevChargeEnergyAdded: data.charge_energy_added ?? prev.prevChargeEnergyAdded,
          emaPower: newEmaPower,
        });
        return;
      }
    }
  }

  // ─────────────────────── GPS smoothing ───────────────────────────────────

  /**
   * Apply Kalman smoothing to a GPS fix.
   * Returns { lat, lon } (raw, for state machine distance) and
   * { smoothLat, smoothLon } (filtered, for storage in smooth_lat/smooth_lng).
   * When coordinates are null, smoothed values are also null.
   */
  private smoothGps(
    vehicleId: string,
    lat: number | null,
    lon: number | null,
    now: Date,
  ): { lat: number | null; lon: number | null; smoothLat: number | null; smoothLon: number | null } {
    if (lat == null || lon == null) return { lat, lon, smoothLat: null, smoothLon: null };
    const { lat: sLat, lng: sLon } = this.kalman.process(vehicleId, lat, lon, now.getTime());
    return { lat, lon, smoothLat: sLat, smoothLon: sLon };
  }

  // ─────────────────────── Trip start ───────────────────────────────────────

  /** Creates a trip record in DB immediately for real-time visibility. Returns tripId. */
  private async startTrip(
    vehicleId: string,
    data: { soc?: number; latitude?: number; longitude?: number },
    now: Date,
    startSocOverride?: number | null,
  ): Promise<string> {
    // Hard guard: never create a second open trip for the same vehicle.
    // If one exists (e.g., after restart/race), reuse it and continue buffering.
    const openTrip = await this.prisma.trip.findFirst({
      where: { vehicleId, endTime: null },
      orderBy: { startTime: 'desc' },
    });
    if (openTrip) {
      return openTrip.id;
    }

    // Idempotency guard: prevents duplicate trip starts from bursty duplicate points.
    const startWindow = Math.floor(now.getTime() / 30_000);
    const startKey = `trip:start:idem:${vehicleId}:${startWindow}`;
    const startClaimed = await (this.redis as any).set(startKey, '1', 'EX', 120, 'NX');
    if (!startClaimed) {
      const existingTrip = await this.prisma.trip.findFirst({
        where: { vehicleId, endTime: null },
        orderBy: { startTime: 'desc' },
      });
      if (existingTrip) return existingTrip.id;
    }

    // Cache battery capacity for live range estimates (non-blocking)
    if (!this.batteryKwhByVehicle.has(vehicleId)) {
      this.prisma.vehicle.findUnique({ where: { id: vehicleId }, include: { vehicleSpec: true } })
        .then(v => {
          const kwh = (v as any)?.batteryCapacityDetected ?? v?.vehicleSpec?.batteryUsableKwh ?? (v as any)?.batteryCapacityUsable ?? 75;
          this.batteryKwhByVehicle.set(vehicleId, kwh);
        })
        .catch(() => { });
    }

    // Reset Kalman filter so the new trip starts from a clean state
    this.kalman.reset(vehicleId);

    const trip = await this.prisma.trip.create({
      data: {
        vehicleId,
        startTime: now,
        startSoc: startSocOverride ?? data.soc ?? 0,
        startLocation: null,
        startLat: data.latitude ?? null,
        startLon: data.longitude ?? null,
      },
    });
    this.logger.log(`[Trip] Started ${trip.id} for vehicle ${vehicleId}`);

    this.eventStore?.emitTripStarted(vehicleId, {
      tripId:    trip.id,
      startTime: trip.startTime.toISOString(),
      startSoc:  trip.startSoc,
      startLat:  trip.startLat ?? null,
      startLon:  trip.startLon ?? null,
    });

    if (data.latitude != null && data.longitude != null) {
      this.geocoding.reverseShort(data.latitude, data.longitude)
        .then(addr => addr
          ? this.prisma.trip.update({ where: { id: trip.id }, data: { startLocation: addr } })
          : null,
        )
        .catch(() => null);
    }

    this.telemetryGateway?.emitTripStarted(vehicleId, {
      id: trip.id, vehicleId,
      startTime: trip.startTime, startSoc: trip.startSoc, endTime: null,
    });

    // Publish real DB trip ID so TripEngineV2 can emit trip:point / trip:live
    // with the correct ID the frontend can correlate with DB records.
    await this.redis.set(`trip:id:${vehicleId}`, trip.id, 'EX', 7200);

    return trip.id;
  }

  // ─────────────────────── Trip finalize ────────────────────────────────────

  /**
   * Flush TripBuilder buffer to DB.
   *
   * Steps:
   *   1. Get finalized buffer from TripBuilder
   *   2. Bulk-insert all points (createMany)
   *   3. Calculate distance / energy / efficiency from the full track
   *   4. Update the trip record
   *   5. Delete & rollback if trip is too short (< 100 m)
   */
  private async finalizeTripToDb(
    vehicleId: string,
    data: { soc?: number; latitude?: number; longitude?: number; odometer?: number; speed?: number },
    now: Date,
    tripId: string | null,
  ): Promise<void> {
    if (tripId) {
      // Idempotency guard: finalize side-effects must run once per trip.
      const finalizeKey = `trip:finalize:idem:${tripId}`;
      const finalizeClaimed = await (this.redis as any).set(finalizeKey, '1', 'EX', 600, 'NX');
      if (!finalizeClaimed) return;
    }

    const buffer = this.tripBuilder.finalize(vehicleId);

    // Recovery mode: no buffer, use existing DB points
    if (!buffer && tripId) {
      await this.finalizeTripFromDb(vehicleId, tripId, data, now);
      return;
    }
    if (!buffer || !tripId) return;

    // ── Bulk-write buffered points ────────────────────────────────────────
    if (buffer.points.length > 0) {
      await this.prisma.tripPoint.createMany({
        data: buffer.points.map(p => ({
          tripId,
          timestamp:    p.timestamp,
          speed:        p.speed,
          power:        p.power,
          soc:          p.soc,
          latitude:     p.latitude,
          longitude:    p.longitude,
          smoothLat:    (p as any).smoothLat ?? null,
          smoothLng:    (p as any).smoothLng ?? null,
          elevationM:   p.elevationM,
          interpolated: p.interpolated ?? false,
        })),
        skipDuplicates: true,
      });
    }

    // ── Metrics from buffer ───────────────────────────────────────────────
    let distanceKm = computeDistanceKm(buffer.points);

    // Odometer fallback when GPS significantly under-reports the distance.
    // This happens when the car drives during a telemetry gap: the buffer only has
    // a few GPS points near the trip start, but the odometer shows the true distance.
    // Condition: GPS dist is less than 50% of odometer delta (AND odo delta is meaningful).
    //
    // If the current telemetry point lacks an odometer value (MQTT batch without that field),
    // look up the most recent odometer from telemetry_points near the trip end as a fallback.
    const startOdometer = buffer.startOdometer;
    let endOdometer = data.odometer ?? null;
    if (endOdometer == null && startOdometer != null) {
      const now2MinAgo = new Date(now.getTime() - 2 * 60_000);
      const nearbyOdo = await this.prisma.telemetryPoint.findFirst({
        where: {
          vehicleId,
          timestamp: { gte: now2MinAgo, lte: new Date(now.getTime() + 30_000) },
          odometer:  { not: null },
        },
        orderBy: { timestamp: 'desc' },
        select:  { odometer: true },
      }).catch(() => null);
      endOdometer = nearbyOdo?.odometer ?? null;
    }

    let usedOdometerFallback = false;
    if (startOdometer != null && endOdometer != null) {
      const odoDistKm = endOdometer - startOdometer;
      // Use odometer when GPS significantly underestimates.
      // Threshold raised to 75% (was 50%): sparse telemetry (1 point/min) commonly
      // produces GPS haversine 50–70% of true distance — the old 50% threshold
      // failed to catch these cases.  At 75% the fallback fires for all genuinely
      // sparse-GPS scenarios while still leaving well-sampled GPS tracks unaffected.
      if (odoDistKm > 0.1 && distanceKm < Math.max(0.3, odoDistKm * 0.75)) {
        this.logger.debug(
          `[Trip] Odometer fallback: GPS=${distanceKm.toFixed(2)} km → odo=${odoDistKm.toFixed(2)} km (ratio=${(distanceKm / odoDistKm).toFixed(2)})`,
        );
        distanceKm = Math.round(odoDistKm * 10) / 10;
        usedOdometerFallback = true;
      }
    }

    // When odometer fallback is used, inject the force-end GPS position as a final
    // buffer point so the polyline actually reaches the real end location.
    // Only inject when the position is valid and meaningfully far from the last point.
    if (usedOdometerFallback && data.latitude != null && data.longitude != null) {
      const lastGpsPoint = [...buffer.points].reverse().find(
        p => p.latitude != null && p.longitude != null,
      );
      const distFromLastKm = lastGpsPoint
        ? haversineKm(lastGpsPoint.latitude!, lastGpsPoint.longitude!, data.latitude, data.longitude)
        : 1;
      if (distFromLastKm > 0.1) {
        buffer.points.push({
          timestamp:   now,
          speed:       0,
          power:       null,
          soc:         data.soc ?? null,
          latitude:    data.latitude,
          longitude:   data.longitude,
          elevationM:  null,
          interpolated: false,
        });
      }
    }

    // Determine actual endTime.
    // Use 'now' (force-end trigger time) only when there's odometer evidence the car
    // drove through the gap (dead zone / tunnel). Otherwise use the last buffer point
    // timestamp so parked gap time does not inflate trip duration.
    // Signal that the car drove through the gap:
    //   • odometer fallback fired AND last buffer point had speed > 0  (car left at
    //     non-zero speed and odo jumped significantly during the gap)
    const lastPointTimestamp = buffer.points.length > 0
      ? buffer.points[buffer.points.length - 1].timestamp
      : null;
    const lastBufferSpeed = buffer.points.length > 0
      ? buffer.points[buffer.points.length - 1].speed
      : 0;
    // Do NOT use data.speed > 10 here: for SIGNAL_LOSS force-ends (large gap),
    // data.speed is from the NEXT trip's first telemetry point (car starting to drive
    // again after parking). Using it would set endTime = now (e.g. 1:47pm) even though
    // the car was parked since 11:28am, inflating the trip duration by hours and causing
    // the reconciler to merge this trip with the next one via the ~90s cooldown gap.
    // Only use the odometer evidence: if the odo jumped during the gap AND the last
    // buffer point was moving, the car genuinely drove through a dead zone.
    const carStillMovingAtForceEnd =
      (usedOdometerFallback && lastBufferSpeed > 0);
    const actualEndTime = (carStillMovingAtForceEnd || lastPointTimestamp == null)
      ? now
      : lastPointTimestamp;

    const tripStartTs = buffer.points.length > 0 ? buffer.points[0].timestamp : actualEndTime;
    const rollbackDurationMs = actualEndTime.getTime() - tripStartTs.getTime();
    const durationHrs = rollbackDurationMs / 3_600_000;
    const impliedAvgKmh = durationHrs > 0 ? distanceKm / durationHrs : Infinity;

    // Physically impossible trip: GPS teleport or timestamp corruption.
    // Even the fastest production cars peak at ~300 km/h; an average > 300 km/h
    // across the whole trip is impossible and indicates bad GPS or clock data.
    if (impliedAvgKmh > 300) {
      await this.prisma.tripPoint.deleteMany({ where: { tripId } });
      await this.prisma.trip.delete({ where: { id: tripId } });
      await this.redis.del(`trip:id:${vehicleId}`);
      this.logger.warn(
        `[Trip] Deleted impossible trip ${tripId}: ${impliedAvgKmh.toFixed(0)} km/h avg (${distanceKm.toFixed(2)} km / ${Math.round(rollbackDurationMs / 60000)} min)`,
      );
      return;
    }

    // GPS drift while parked with ignition/climate running.
    // A Tesla averaging < 5 km/h over a < 2 km "trip" is almost certainly
    // coordinates drifting while the car sits with HVAC on, not real driving.
    if (impliedAvgKmh < 5 && distanceKm < 2) {
      await this.prisma.tripPoint.deleteMany({ where: { tripId } });
      await this.prisma.trip.delete({ where: { id: tripId } });
      await this.redis.del(`trip:id:${vehicleId}`);
      this.logger.warn(
        `[Trip] Deleted GPS-drift trip ${tripId}: ${impliedAvgKmh.toFixed(1)} km/h avg, ${distanceKm.toFixed(2)} km`,
      );
      return;
    }

    // Rollback: too short to be a real trip.
    // Two criteria:
    //   1. distance < 500 m → parking maneuver / false-start (raised from 300 m)
    //   2. distance < 1 km AND duration < 2 min → ghost trip from false start
    //      (car briefly shifts D/R in driveway, gets 0.5-0.9 km before stopping —
    //       too short to be any real errand, regardless of whether the 500 m bar cleared)
    const isFalseStart = distanceKm < 1.0 && rollbackDurationMs < 120_000;
    if (distanceKm < 0.5 || isFalseStart) {
      await this.prisma.tripPoint.deleteMany({ where: { tripId } });
      await this.prisma.trip.delete({ where: { id: tripId } });
      await this.redis.del(`trip:id:${vehicleId}`);
      this.logger.debug(
        `[Trip] Rolled back ${tripId} (dist=${distanceKm.toFixed(2)} km, dur=${Math.round(rollbackDurationMs / 1000)}s, falseStart=${isFalseStart})`,
      );
      return;
    }

    // ── Energy ────────────────────────────────────────────────────────────
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) return;

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId }, include: { vehicleSpec: true },
    });
    const usableKwh =
      (vehicle as any)?.batteryCapacityDetected ??
      vehicle?.vehicleSpec?.batteryUsableKwh ??
      (vehicle as any)?.batteryCapacityUsable ??
      75;

    const endSoc = data.soc ?? null;
    const socDrop = (trip.startSoc ?? 0) - (endSoc ?? trip.startSoc ?? 0);
    const socEnergy = socDrop > 1
      ? Math.round((socDrop / 100) * usableKwh * 100) / 100
      : 0;
    const integEnergy = buffer.energyKwh > 0
      ? Math.round(buffer.energyKwh * 100) / 100
      : 0;

    // Continuous energy blend:
    //   distanceFactor = clamp(distanceKm / 10, 0, 1)
    //   0 km  → 100% power integral (SOC quantization too coarse at short distances)
    //   10 km → 70% SOC + 30% power integral (SOC more reliable at longer scale)
    //   Smooth ramp avoids sharp discontinuities that cause efficiency spikes at 3 km.
    const distanceFactor = Math.min(1, distanceKm / 10);
    let energyUsedKwh: number | null;
    if (socEnergy > 0 && integEnergy > 0) {
      const socWeight = 0.7 * distanceFactor;
      const integWeight = 1 - socWeight;
      energyUsedKwh = Math.round((socWeight * socEnergy + integWeight * integEnergy) * 100) / 100;
    } else if (integEnergy > 0) {
      energyUsedKwh = integEnergy;
    } else if (socEnergy > 0) {
      energyUsedKwh = socEnergy;
    } else {
      energyUsedKwh = null;
    }

    const rawEff = distanceKm > 0 && energyUsedKwh != null && energyUsedKwh > 0
      ? Math.round((energyUsedKwh * 1000 / distanceKm) * 10) / 10
      : null;

    // ── Elevation gain + net elevation change ─────────────────────────────
    let elevationGain = 0;
    for (let i = 1; i < buffer.points.length; i++) {
      const e0 = buffer.points[i - 1].elevationM;
      const e1 = buffer.points[i].elevationM;
      if (e0 != null && e1 != null && e1 > e0) elevationGain += e1 - e0;
    }

    // Elevation-corrected efficiency: remove net potential energy from energy consumption.
    // Potential energy = mass × g × Δh / 3,600,000 (kWh per meter for vehicle mass).
    // Tesla Model Y mass ≈ 2200 kg → ~0.006 kWh per meter of net elevation change.
    // Positive netElev (uphill trip) → car spent extra energy → subtract to get flat-equivalent.
    // Negative netElev (downhill trip) → car recovered energy via regen → add back.
    const firstElev = buffer.points.find(p => p.elevationM != null)?.elevationM ?? null;
    const lastElev = [...buffer.points].reverse().find(p => p.elevationM != null)?.elevationM ?? null;
    const netElevationM = firstElev != null && lastElev != null ? lastElev - firstElev : null;
    const VEHICLE_MASS_KG = 2200;
    const elevationEnergyKwh = netElevationM != null
      ? +(VEHICLE_MASS_KG * 9.81 * netElevationM / 3_600_000).toFixed(4) // signed kWh
      : null;

    // Prefer elevation-corrected efficiency when we have elevation data
    let efficiencyWhkm = rawEff != null && rawEff > 0 && rawEff <= 600 ? rawEff : null;
    if (energyUsedKwh != null && elevationEnergyKwh != null && distanceKm > 0) {
      const flatEnergyKwh = Math.max(0.01, energyUsedKwh - elevationEnergyKwh);
      const correctedEff = Math.round((flatEnergyKwh * 1000 / distanceKm) * 10) / 10;
      if (correctedEff > 0 && correctedEff <= 600) {
        efficiencyWhkm = correctedEff; // terrain-normalized efficiency
      }
    }

    // Last real GPS point for endLat/endLon.
    // When odometer fallback is used, the force-end data point's GPS is more accurate
    // (the car is physically there), so prefer it over the last buffer point.
    const lastGps = (usedOdometerFallback && data.latitude != null && data.longitude != null)
      ? { latitude: data.latitude, longitude: data.longitude }
      : [...buffer.points].reverse().find(p => p.latitude != null && p.longitude != null);

    // Sparse-trip interpolation: when the buffer has ≤4 real GPS points spanning
    // >5 minutes, linearly interpolate at 60-second intervals between each pair.
    // This avoids a 2-dot "teleport" map and gives the frontend a denser polyline,
    // even though points follow straight lines (roads not snapped).
    const realGpsPoints = buffer.points.filter(p => p.latitude != null && p.longitude != null && !p.interpolated);
    const tripSpanMs = buffer.points.length > 1
      ? buffer.points[buffer.points.length - 1].timestamp.getTime() - buffer.points[0].timestamp.getTime()
      : 0;
    if (realGpsPoints.length >= 2 && realGpsPoints.length <= 4 && tripSpanMs > 5 * 60_000) {
      const enriched: BufferedPoint[] = [];
      for (let i = 0; i < buffer.points.length; i++) {
        enriched.push(buffer.points[i]);
        const next = buffer.points[i + 1];
        if (next && buffer.points[i].latitude != null && next.latitude != null) {
          const gapMs = next.timestamp.getTime() - buffer.points[i].timestamp.getTime();
          if (gapMs > 60_000) {
            enriched.push(...interpolatePoints(buffer.points[i], next, 60_000));
          }
        }
      }
      buffer.points = enriched;
    }

    const polyline = encodePolyline(buffer.points);
    const quality = this.tripBuilder.computeQuality(buffer);

    // ── Trip stats (pre-computed for driving score) ───────────────────────
    const speeds = buffer.points
      .filter(p => !p.interpolated)
      .map(p => p.speed)
      .filter(s => s > 0);
    const avgSpeed = speeds.length ? speeds.reduce((a, b) => a + b) / speeds.length : null;
    const maxSpeed = speeds.length ? Math.max(...speeds) : null;
    const totalMs = buffer.stoppedMs + buffer.movingMs;
    const trafficStopRatio = totalMs > 0
      ? Math.round((buffer.stoppedMs / totalMs) * 1000) / 1000
      : null;

    // ── Anomaly detection ─────────────────────────────────────────────────
    const anomalyFlags: string[] = [];
    if (efficiencyWhkm != null && efficiencyWhkm > 400) {
      anomalyFlags.push('HIGH_EFFICIENCY');
    }
    // Preconditioning detection: short trip (< 20 km, < 12 min) with unusually high
    // consumption (> 220 Wh/km). Typical signature: Tesla heating the battery pack
    // before a Supercharger stop — energy draw appears inside the driving trip.
    // Shown in the UI as an informational badge, not an error.
    const tripDurationMs = buffer.points.length >= 2
      ? buffer.points[buffer.points.length - 1].timestamp.getTime() - buffer.points[0].timestamp.getTime()
      : 0;
    if (
      efficiencyWhkm != null && efficiencyWhkm > 220 && efficiencyWhkm <= 400 &&
      distanceKm < 20 && tripDurationMs < 12 * 60_000
    ) {
      anomalyFlags.push('PRECONDITIONING_LIKELY');
    }
    // GPS jump detection:
    //   Criterion A: implied speed between consecutive points > 200 km/h
    //   Criterion B: distance > 300 m in < 5 s (teleport at any speed range)
    // Only check short inter-point gaps (< 3 min) to avoid flagging telemetry outages.
    for (let i = 1; i < buffer.points.length; i++) {
      const p0 = buffer.points[i - 1];
      const p1 = buffer.points[i];
      const dtMs = p1.timestamp.getTime() - p0.timestamp.getTime();
      const dtHrs = dtMs / 3_600_000;
      if (dtMs <= 0 || dtMs > 180_000) continue; // skip gaps > 3 min
      const distKm = haversineKm(p0.latitude, p0.longitude, p1.latitude, p1.longitude);
      const impliedSpeedKmh = distKm / dtHrs;
      const isTeleport = distKm > 0.3 && dtMs < 5_000; // > 300 m in < 5 s
      if (impliedSpeedKmh > 200 || isTeleport) {
        anomalyFlags.push('GPS_JUMP');
        break;
      }
    }

    // ── Driving score (0–100) ─────────────────────────────────────────────
    // Efficiency component (40 pts): scale 150–400 Wh/km → 40–0
    const effScore = efficiencyWhkm != null
      ? Math.max(0, Math.min(40, Math.round(40 * (1 - (efficiencyWhkm - 150) / 250))))
      : 20; // neutral if unknown

    // Smoothness (30 pts): penalise large speed-to-speed deltas (> 30 km/h/s = harsh)
    const movingPts = buffer.points.filter(p => !p.interpolated);
    let harshEvents = 0;
    for (let i = 1; i < movingPts.length; i++) {
      const dtSec = (movingPts[i].timestamp.getTime() - movingPts[i - 1].timestamp.getTime()) / 1000;
      if (dtSec > 0 && dtSec < 10) {
        const accel = Math.abs(movingPts[i].speed - movingPts[i - 1].speed) / dtSec;
        if (accel > 4) harshEvents++; // >4 km/h/s
      }
    }
    const smoothScore = Math.max(0, 30 - harshEvents * 3);

    // Traffic stop ratio (30 pts): more stops → less efficient city driving
    const stopScore = trafficStopRatio != null
      ? Math.max(0, Math.round(30 * (1 - trafficStopRatio)))
      : 20;

    const drivingScore = Math.min(100, effScore + smoothScore + stopScore);

    // ── Cost per trip ─────────────────────────────────────────────────────
    // Delegated to TariffResolverService (purpose: 'actual_cost') -- this is
    // the cost of energy the trip consumed, not a charging session, so no
    // chargerType/location is passed (none exists in this code path); the
    // resolver's home-settings tier is the only one ever reached. See
    // docs/calculations/tariff-resolver.md and tariff-current-behavior-trip-paths.spec.ts
    // for the two accepted divergences from the pre-migration literal logic:
    // settings.chargingCost is no longer a fallback, and the hardcoded 0.25
    // default is now the shared canonicalDefaultRate (0.35).
    let costTotal: number | null = null;
    if (energyUsedKwh != null) {
      if (!this.tariffResolver) {
        throw new Error(`TripDetectorService: TariffResolverService not available (trip ${tripId})`);
      }
      const resolution = await this.tariffResolver.resolve({ purpose: 'actual_cost', vehicleId });
      costTotal = Math.round(energyUsedKwh * resolution.rate * 100) / 100;
    }

    // P1 phase-1 draft: schedule delayed reconciliation (2–10 min) for post-processor pass
    const reconcileAt = TripDetectorService.scheduleTripReconcileAt();

    // ── Update trip record ────────────────────────────────────────────────
    await this.prisma.trip.update({
      where: { id: tripId },
      data: {
        endTime: actualEndTime,
        endSoc,
        endLocation: null,
        distanceKm: Math.round(distanceKm * 10) / 10,
        energyUsedKwh: energyUsedKwh ?? null,
        efficiencyWhkm,
        endLat: lastGps?.latitude ?? null,
        endLon: lastGps?.longitude ?? null,
        polyline: polyline || null,
        qualityScore: quality.score,
        anomalyFlags: anomalyFlags.length ? JSON.stringify(anomalyFlags) : null,
        drivingScore,
        costTotal,
        reconcileAt,
      },
    });

    this.logger.log(
      `[Trip] Finalized ${tripId} — ${distanceKm.toFixed(1)} km | ` +
      `energy=${energyUsedKwh?.toFixed(2) ?? '?'} kWh ` +
      `(∫power=${integEnergy} / SOC Δ${socDrop.toFixed(0)}%) | ` +
      `${efficiencyWhkm ?? '?'} Wh/km | quality=${this.tripBuilder.computeQuality(buffer).score}`,
    );

    // ── Emit finalized trip to frontend ───────────────────────────────────
    this.telemetryGateway?.emitTripEnded(vehicleId, {
      id: tripId, vehicleId,
      startTime: trip.startTime,
      endTime: actualEndTime,
      startSoc: trip.startSoc,
      endSoc,
      distanceKm: Math.round(distanceKm * 10) / 10,
      energyUsedKwh: energyUsedKwh ?? null,
      efficiencyWhkm,
    });

    // ── Billing-ready event (immutable, idempotent) ────────────────────────
    const durationMin = actualEndTime
      ? Math.round((actualEndTime.getTime() - trip.startTime.getTime()) / 60_000)
      : undefined;
    this.eventStore?.emitTripEnded(vehicleId, {
      tripId,
      startTime:       trip.startTime.toISOString(),
      endTime:         actualEndTime.toISOString(),
      distanceKm:      Math.round(distanceKm * 10) / 10,
      energyUsedKwh:   energyUsedKwh ?? null,
      efficiencyWhkm:  efficiencyWhkm ?? null,
      startSoc:        trip.startSoc,
      endSoc:          endSoc ?? null,
      durationMin,
      qualityScore:    quality.score,
    });

    // Clear shared trip ID — TripEngineV2 falls back to live-{ts} after this
    await this.redis.del(`trip:id:${vehicleId}`);

    // ── Geocode end location (background) ────────────────────────────────
    if (data.latitude != null && data.longitude != null) {
      this.geocoding.reverseShort(data.latitude, data.longitude)
        .then(addr => addr
          ? this.prisma.trip.update({ where: { id: tripId }, data: { endLocation: addr } })
          : null,
        )
        .catch(() => null);
    }

    // ── Regen energy from buffered points ────────────────────────────────
    let regenKwhFinal = 0;
    for (let i = 1; i < buffer.points.length; i++) {
      const p0 = buffer.points[i - 1];
      const p1 = buffer.points[i];
      const pwr = p0.power ?? 0;
      const dtH = (p1.timestamp.getTime() - p0.timestamp.getTime()) / 3_600_000;
      if (pwr < -10 && (p0.speed ?? 0) > 5 && dtH > 0 && dtH < 0.1) regenKwhFinal += Math.abs(pwr) * dtH;
    }
    regenKwhFinal = Math.round(regenKwhFinal * 100) / 100;

    // ── Trip stats upsert ─────────────────────────────────────────────────
    const drivingStyle = drivingScore >= 75 ? 'eco' : drivingScore >= 50 ? 'normal' : 'aggressive';
    await this.prisma.tripStats.upsert({
      where: { tripId },
      create: { tripId, avgSpeed, maxSpeed, trafficStopRatio, elevationGain, drivingStyle, regenEnergyKwh: regenKwhFinal || null },
      update: { avgSpeed, maxSpeed, trafficStopRatio, elevationGain, drivingStyle, regenEnergyKwh: regenKwhFinal || null },
    });

    // ── ML Feature extraction (non-blocking) ─────────────────────────────
    if (this.featureBuilder) {
      this.featureBuilder.buildForTrip(tripId).catch((e: Error) =>
        this.logger.debug(`Feature builder skipped for ${tripId}: ${e.message}`),
      );
    }

    // ── Downstream analytics ──────────────────────────────────────────────
    if (socDrop > 5 && energyUsedKwh != null && this.batteryAnalytics) {
      this.batteryAnalytics.updateBatteryMetrics(vehicleId).catch((e: Error) =>
        this.logger.warn(`Battery analytics failed for ${vehicleId}: ${e.message}`),
      );
      // Track cumulative energy throughput for cycle counting
      if (energyUsedKwh > 0) {
        this.batteryAnalytics.trackCycles(vehicleId, energyUsedKwh).catch(() => undefined);
      }
    }
    if (this.energyAnalytics && trip) {
      this.energyAnalytics.updateDailyEnergy(vehicleId, trip.startTime).catch((e: Error) =>
        this.logger.warn(`Daily energy update failed for ${vehicleId}: ${e.message}`),
      );
    }
  }

  /**
   * Recovery fallback: no in-memory buffer (server restarted mid-trip).
   * Reads points from DB and computes metrics the old way.
   */
  private async finalizeTripFromDb(
    vehicleId: string,
    tripId: string,
    data: { soc?: number; latitude?: number; longitude?: number; odometer?: number },
    now: Date,
  ): Promise<void> {
    this.logger.warn(`[Trip] Recovery finalize for ${tripId} (no in-memory buffer)`);

    const points = await this.prisma.tripPoint.findMany({
      where: { tripId }, orderBy: { timestamp: 'asc' },
    });

    let distanceKm = 0;
    let elevationGain = 0;
    for (let i = 1; i < points.length; i++) {
      distanceKm += haversineKm(
        points[i - 1].latitude, points[i - 1].longitude,
        points[i].latitude, points[i].longitude,
      );
      const e0 = (points[i - 1] as any).elevationM as number | null;
      const e1 = (points[i] as any).elevationM as number | null;
      if (e0 != null && e1 != null && e1 > e0) elevationGain += e1 - e0;
    }

    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) return;

    const recDurationMs = points.length >= 2
      ? points[points.length - 1].timestamp.getTime() - points[0].timestamp.getTime()
      : 0;
    const recDurationHrs = recDurationMs / 3_600_000;
    const recAvgKmh = recDurationHrs > 0 ? distanceKm / recDurationHrs : Infinity;
    const recFalseStart = distanceKm < 1.0 && recDurationMs < 120_000;
    if (recAvgKmh > 300 || (recAvgKmh < 5 && distanceKm < 2) || distanceKm < 0.5 || recFalseStart) {
      await this.prisma.tripPoint.deleteMany({ where: { tripId } });
      await this.prisma.trip.delete({ where: { id: tripId } });
      return;
    }

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId }, include: { vehicleSpec: true },
    });
    const usableKwh =
      (vehicle as any)?.batteryCapacityDetected ??
      vehicle?.vehicleSpec?.batteryUsableKwh ??
      75;

    const endSoc = data.soc ?? null;
    const socDrop = (trip.startSoc ?? 0) - (endSoc ?? trip.startSoc ?? 0);
    const socEnergy = socDrop > 1
      ? Math.round((socDrop / 100) * usableKwh * 100) / 100
      : 0;
    const energyUsedKwh = socEnergy > 0 ? socEnergy : null;
    const rawEff = distanceKm > 0 && energyUsedKwh != null
      ? Math.round((energyUsedKwh * 1000 / distanceKm) * 10) / 10
      : null;
    const efficiencyWhkm = rawEff != null && rawEff > 0 && rawEff <= 600 ? rawEff : null;

    // Compute endLat/endLon from last GPS point in DB
    const lastGpsPoint = [...points].reverse().find(
      p => (p as any).latitude != null && (p as any).longitude != null,
    );
    const endLat = data.latitude ?? (lastGpsPoint as any)?.latitude ?? null;
    const endLon = data.longitude ?? (lastGpsPoint as any)?.longitude ?? null;

    await this.prisma.trip.update({
      where: { id: tripId },
      data: {
        endTime: now, endSoc,
        distanceKm: Math.round(distanceKm * 10) / 10,
        energyUsedKwh, efficiencyWhkm,
        ...(endLat != null ? { endLat } : {}),
        ...(endLon != null ? { endLon } : {}),
        reconcileAt: TripDetectorService.scheduleTripReconcileAt(),
      },
    });

    // Background geocoding for end location
    if (endLat != null && endLon != null) {
      this.geocoding.reverseShort(endLat, endLon)
        .then(addr => addr
          ? this.prisma.trip.update({ where: { id: tripId }, data: { endLocation: addr } })
          : null,
        )
        .catch(() => null);
    }

    this.telemetryGateway?.emitTripEnded(vehicleId, {
      id: tripId, vehicleId, startTime: trip.startTime, endTime: now,
      startSoc: trip.startSoc, endSoc,
      distanceKm: Math.round(distanceKm * 10) / 10,
      energyUsedKwh, efficiencyWhkm,
    });
  }

  // ─────────────────────── Live WebSocket emit ──────────────────────────────

  private emitLive(
    vehicleId: string,
    speed: number,
    soc: number | undefined,
    lat?: number | null,
    lng?: number | null,
  ) {
    if (!this.telemetryGateway) return;
    const stats = this.tripBuilder.getLiveStats(vehicleId);
    if (!stats) return;

    const buf = this.tripBuilder.getBuffer(vehicleId);

    // Emit a lightweight GPS point for real-time polyline drawing on the frontend
    if (lat != null && lng != null && buf?.dbTripId) {
      this.telemetryGateway.emitTripPoint(vehicleId, buf.dbTripId, lat, lng, speed);
    }

    // Simple range prediction: if we know current efficiency and SOC, estimate range
    const soc0 = buf?.startSoc ?? null;
    const currentSoc = soc ?? null;
    const socUsed = soc0 != null && currentSoc != null ? soc0 - currentSoc : null;
    const socRemaining = currentSoc ?? null;
    const effRate = stats.efficiencyWhkm;    // Wh/km
    const batteryKwh = this.batteryKwhByVehicle.get(vehicleId) ?? 75;
    const estimatedRange = socRemaining != null && effRate != null && effRate > 0 && effRate <= 600
      ? Math.round((socRemaining / 100) * batteryKwh * 1000 / effRate)
      : null;

    this.telemetryGateway.emitLiveTripUpdate(vehicleId, {
      tripId: buf?.dbTripId ?? '',
      tripState: TripState.DRIVING,
      speed,
      soc: currentSoc,
      lat: lat ?? null,
      lng: lng ?? null,
      liveStats: {
        distanceKm: stats.distanceKm,
        durationMin: stats.durationMin,
        energyKwh: stats.energyKwh,
        efficiencyWhkm: stats.efficiencyWhkm,
        avgSpeedKmh: stats.avgSpeedKmh,
      },
      prediction: {
        estimatedRangeKm: estimatedRange,
        socUsedPct: socUsed != null ? Math.round(socUsed * 10) / 10 : null,
      },
      quality: stats.quality,
    });
  }

  /** P1: random delay 2–10 min before second-phase trip reconciliation */
  static scheduleTripReconcileAt(): Date {
    const minMs = 2 * 60_000;
    const maxMs = 10 * 60_000;
    return new Date(Date.now() + minMs + Math.random() * (maxMs - minMs));
  }

  private numCfg(key: string, fallback: number): number {
    const raw = this.configService.get<string | number>(key as any);
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : fallback;
  }

  private async persistDetectorState(vehicleId: string): Promise<void> {
    const state = this.cache.get(vehicleId);
    if (!state) return;
    const payload = JSON.stringify({
      ...state,
      idleSince: state.idleSince?.toISOString() ?? null,
      lastTime: state.lastTime?.toISOString() ?? null,
      stoppingAttemptAt: state.stoppingAttemptAt?.toISOString() ?? null,
      stateChangedAt: state.stateChangedAt?.toISOString() ?? null,
      gapCooldownUntil: state.gapCooldownUntil?.toISOString() ?? null,
    });
    await (this.redis as any).set(`trip:detector:state:${vehicleId}`, payload, 'EX', 12 * 60 * 60).catch(() => {});
  }

  private async loadPersistedDetectorState(vehicleId: string): Promise<DetectorCache | null> {
    const raw = await (this.redis as any).get(`trip:detector:state:${vehicleId}`).catch(() => null);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      return {
        ...p,
        idleSince: p.idleSince ? new Date(p.idleSince) : null,
        lastTime: p.lastTime ? new Date(p.lastTime) : null,
        stoppingAttemptAt: p.stoppingAttemptAt ? new Date(p.stoppingAttemptAt) : null,
        stateChangedAt: p.stateChangedAt ? new Date(p.stateChangedAt) : new Date(),
        gapCooldownUntil: p.gapCooldownUntil ? new Date(p.gapCooldownUntil) : null,
      };
    } catch {
      return null;
    }
  }

  // ─────────────────────── Cache helpers ────────────────────────────────────

  /**
   * Public method for backfill/rebuild: clears all in-memory state for a vehicle
   * so the detector starts fresh (IDLE, no history) before replaying telemetry.
   */
  async resetVehicleState(vehicleId: string): Promise<void> {
    this.cache.delete(vehicleId);
    this.batteryKwhByVehicle.delete(vehicleId);
    this.tripBuilder.finalize(vehicleId); // discard any in-progress buffer
    // Clear Redis trip-id key so a rebuilt trip gets a fresh ID
    await this.redis.del(`trip:id:${vehicleId}`);
    this.logger.log(`[Rebuild] Reset detector state for vehicle ${vehicleId}`);
  }

  private resetCache(
    vehicleId: string,
    speed: number, power: number,
    lat: number | null, lon: number | null,
    shift: string | null, now: Date,
    state: TripState,
  ) {
    // Keep speed/power/soc history and rolling window across resets
    const existing = this.cache.get(vehicleId);
    this.cache.set(vehicleId, {
      tripState: state, speed, power, lat, lon, shiftState: shift,
      idleSince: null, socAtStop: null, stopLat: null, stopLon: null, lastTime: now,
      energyKwh: 0, consecutiveMoving: 0,
      startOdometer: null,
      recentSpeeds: existing?.recentSpeeds ?? [],
      speedHistory: existing?.speedHistory ?? [],
      powerHistory: existing?.powerHistory ?? [],
      socHistory: existing?.socHistory ?? [],
      intervalHistory: existing?.intervalHistory ?? [],  // preserve for dynamic gap threshold
      stoppingAttemptAt: null,
      lastConfidence: 1,
      stateChangedAt: now,
      gapAccumMs: 0,
      gapCooldownUntil: existing?.gapCooldownUntil ?? null,
      regenKwh: 0,
      prevChargeEnergyAdded: existing?.prevChargeEnergyAdded ?? null,
      emaPower: existing?.emaPower,  // preserve warm EMA across trip boundaries; undefined = cold start
    });
  }

  // ─────────────────────── Analytics queries ────────────────────────────────

  async getTripsForVehicle(vehicleId: string, limit = 30, from?: Date, to?: Date) {
    const trips = await this.prisma.trip.findMany({
      // Include active trips (endTime = null) so frontend can show live/in-progress entries.
      // Exclude ghost/phantom trips (< 300 m completed) from the API response — the cleanup
      // cron deletes them every 6 hours, but they should never be visible in the UI.
      where: {
        vehicleId,
        NOT: { distanceKm: { lt: 0.3 }, endTime: { not: null } },
        ...(from || to ? { startTime: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: { startTime: 'desc' },
      take: limit,
      include: { stats: true },
    });

    // ── Drive-session grouping ─────────────────────────────────────────────
    // Group consecutive trips that are close in time (gap < 10 min) and space
    // (start of next trip within 2 km of end of previous trip) into a session.
    // Sessions have a unique id = id of the first trip in the session.
    let sessionId: string | null = null;
    // Process oldest→newest (trips are DESC, reverse for grouping)
    const chronological = [...trips].reverse();
    const sessionMap = new Map<string, string>(); // tripId → sessionId

    for (let i = 0; i < chronological.length; i++) {
      const curr = chronological[i];
      const prev = chronological[i - 1];

      if (i === 0 || !prev) {
        sessionId = curr.id;
      } else {
        const gapMs = curr.startTime.getTime() - (prev.endTime ?? prev.startTime).getTime();
        const endLat = (prev as any).endLat as number | null;
        const endLon = (prev as any).endLon as number | null;
        const startLat = (curr as any).startLat as number | null;
        const startLon = (curr as any).startLon as number | null;
        const distKm = endLat != null && endLon != null && startLat != null && startLon != null
          ? haversineKm(endLat, endLon, startLat, startLon)
          : Infinity;

        const sameSession = gapMs < this.SESSION_MAX_GAP_MS && distKm < this.SESSION_MAX_DIST_KM;
        if (!sameSession) sessionId = curr.id;
      }

      sessionMap.set(curr.id, sessionId!);
    }

    // Return DESC order (as before) with sessionId attached
    return trips.map(t => ({
      ...t,
      sessionId: sessionMap.get(t.id) ?? t.id,
    }));
  }

  async getTripStats(vehicleId: string, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const trips = await this.prisma.trip.findMany({
      where: { vehicleId, startTime: { gte: since }, endTime: { not: null }, distanceKm: { gte: 0.3 } },
    });
    if (!trips.length) return null;

    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const sum = (key: 'distanceKm' | 'energyUsedKwh' | 'efficiencyWhkm') =>
      trips.reduce((a, t) => a + num((t as any)[key]), 0);

    return {
      totalTrips: trips.length,
      totalDistanceKm: sum('distanceKm'),
      avgDistanceKm: sum('distanceKm') / trips.length,
      totalEnergyKwh: sum('energyUsedKwh'),
      avgEfficiencyWhKm: sum('efficiencyWhkm') / trips.length,
      period: { since, until: new Date() },
    };
  }
}

// ─────────────────────── Types ────────────────────────────────────────────────

interface SpeedSample { speed: number; ts: number }

interface DetectorCache {
  tripState: TripState;
  speed: number;
  power: number;
  lat: number | null;
  lon: number | null;
  shiftState: string | null;
  idleSince: Date | null;
  socAtStop: number | null;
  /** Anchor coordinates captured when entering STOPPING (for pause-at-point splitting). */
  stopLat: number | null;
  stopLon: number | null;
  lastTime: Date | null;
  energyKwh: number;
  consecutiveMoving: number;
  startOdometer: number | null;
  /** Rolling speed history (last 5 min) for context-aware stop detection */
  recentSpeeds: SpeedSample[];
  /** When the current low-speed episode started (in DRIVING state) */
  stoppingAttemptAt: Date | null;
  /** Last N raw values for smoothing */
  speedHistory: number[];   // last 5 speed readings
  powerHistory: number[];   // last 5 power readings
  socHistory: number[];   // last 3 SOC readings
  /** Confidence in last state decision (0–1) */
  lastConfidence: number;
  /** Anti-flapping: when did we last change state (to enforce min 30 s dwell) */
  stateChangedAt: Date;
  /** Gap tracking: ms of signal loss accumulated since last valid point */
  gapAccumMs: number;
  /** Prevent starting a new trip for 90 s after a force-end (SIGNAL_LOSS) */
  gapCooldownUntil: Date | null;
  /** Accumulated regenerative braking energy this trip (kWh) */
  regenKwh: number;
  /** Last seen charge_energy_added from Tesla — for energy delta check */
  prevChargeEnergyAdded: number | null;
  /** EMA-smoothed power reading (kW) for energy integration. undefined = cold start (not yet seeded) */
  emaPower: number | undefined;
  /**
   * Rolling last-10 inter-arrival intervals (ms) between consecutive telemetry points.
   * Used to compute a dynamic gap threshold that adapts to the actual polling cadence
   * (Fleet Telemetry ~10 s, REST poll 90–300 s, MQTT variable).
   */
  intervalHistory: number[];
}

function makeEmptyCache(now: Date, tripState = TripState.IDLE): DetectorCache {
  return {
    tripState,
    speed: 0, power: 0, lat: null, lon: null, shiftState: null,
    idleSince: null, socAtStop: null, stopLat: null, stopLon: null, lastTime: now,
    energyKwh: 0, consecutiveMoving: 0, startOdometer: null,
    recentSpeeds: [], stoppingAttemptAt: null,
    speedHistory: [], powerHistory: [], socHistory: [],
    lastConfidence: 1,
    stateChangedAt: now,
    gapAccumMs: 0,
    gapCooldownUntil: null,
    regenKwh: 0,
    prevChargeEnergyAdded: null,
    emaPower: undefined,
    intervalHistory: [],
  };
}

/** Moving average of speed over the given window in ms */
function rollingAvgSpeed(samples: SpeedSample[], now: Date, windowMs: number): number {
  const cutoff = now.getTime() - windowMs;
  const relevant = samples.filter(s => s.ts >= cutoff);
  if (!relevant.length) return 0;
  return relevant.reduce((a, s) => a + s.speed, 0) / relevant.length;
}

/** Median of an array of numbers */
function median(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Moving average of last N values */
function movingAvg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Variance of an array of numbers (returns 0 for empty/single-element arrays) */
function variance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((a, b) => a + (b - avg) ** 2, 0) / arr.length;
}

/**
 * Confidence score (0–1) for whether the current telemetry point is reliable.
 *
 * Factors:
 *   - Speed consistency: how well current speed matches the rolling average
 *   - Signal availability: fraction of key signals that are non-null/non-zero
 *   - Gap penalty: recent telemetry gaps reduce trust
 */
function computeConfidence(
  speed: number,
  avgSpeedRecent: number,
  powerKnown: boolean,
  gpsOk: boolean,
  dtMs: number,
): number {
  // Speed consistency (0–1): penalise sudden large jumps vs recent history
  const refSpeed = Math.max(avgSpeedRecent, 5);
  const speedDelta = avgSpeedRecent > 0
    ? Math.min(1, Math.abs(speed - avgSpeedRecent) / refSpeed)
    : 0;
  const speedConsistency = 1 - speedDelta * 0.5; // max 50% penalty

  // Signal availability (0–1)
  const signalScore = ((powerKnown ? 1 : 0) + (gpsOk ? 1 : 0)) / 2;

  // Gap penalty
  const gapPenalty = dtMs > 60_000 ? 0.4 : dtMs > 30_000 ? 0.2 : dtMs > 15_000 ? 0.1 : 0;

  return Math.max(0, Math.min(1,
    speedConsistency * 0.5 + signalScore * 0.3 + 0.2 - gapPenalty,
  ));
}
