import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { PrismaService } from '../prisma/prisma.service';
import { appendRepairTag } from '../trips/repair-tag.utils';

/**
 * High-level vehicle state derived from raw telemetry.
 *
 * DRIVING  — speed > 5 km/h (sustained)
 * CHARGING — charger power > 20 kW AND speed < 2 km/h
 * IDLE     — everything else (parked, preconditioning, sleeping)
 *
 * This is distinct from VehicleStateMachineService (which tracks REST API state
 * for polling-interval control). The TelemetryEventEngine operates on the
 * raw telemetry stream, resolving cross-domain races between the trip detector
 * and the charging detector.
 */
export enum TelemetryVehicleState {
  IDLE     = 'IDLE',
  DRIVING  = 'DRIVING',
  CHARGING = 'CHARGING',
}

interface StateRecord {
  state:           TelemetryVehicleState;
  since:           number; // ms epoch
  powerHistory:    number[];  // last N power readings for hysteresis
  speedHistory:    number[];
  lastHighSpeedMs: number;    // epoch of last speed > 50 km/h — highway-regen guard
}

const REDIS_KEY = (vehicleId: string) => `tel:state:${vehicleId}`;
const STATE_TTL = 24 * 60 * 60; // 1 day

/**
 * TelemetryEventEngine — unified cross-domain state machine
 *
 * Sits between the raw telemetry stream and the sub-detectors
 * (TripDetectorService, ChargingDetectorService). Classifies each telemetry
 * point into a high-level state and fires atomic transition handlers when the
 * state changes.
 *
 * Key invariants guaranteed by this engine:
 *
 *   DRIVING → CHARGING:  any open trip is force-closed BEFORE the charging
 *                        detector gets the point. Prevents ghost trips that
 *                        stay open through a Supercharger session.
 *
 *   CHARGING → DRIVING:  any open charging session is force-closed BEFORE the
 *                        trip detector gets the point. Prevents session-stuck
 *                        bug when telemetry drops at the charger.
 *
 * The sub-detectors continue to run after the transition handler and manage
 * their own fine-grained states (STOPPING debounce, pause grace period, etc.)
 *
 * Hysteresis:
 *   State is classified from a rolling 3-point median of speed + power,
 *   so a single noisy telemetry spike cannot flip the state.
 *
 * Persistence:
 *   State is stored in Redis (TTL 24h) so restarts don't lose it and we
 *   avoid spurious IDLE → DRIVING transitions on service boot.
 */
@Injectable()
export class TelemetryEventEngine {
  private readonly logger = new Logger(TelemetryEventEngine.name);

  // In-memory cache (Redis is authoritative on restart, this avoids Redis RTT on hot path)
  private readonly stateCache = new Map<string, StateRecord>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Classify the incoming telemetry point and fire transition handlers if
   * the high-level state changes.
   *
   * Returns the new state so callers can make routing decisions.
   * Does NOT call sub-detectors — the caller (TelemetryPipelineService) does
   * that immediately after this returns.
   */
  async process(
    vehicleId: string,
    point: {
      speed?:               number | null;
      power?:               number | null;
      soc?:                 number | null;
      charging_state?:      string | null;
      timestamp?:           string;
      charge_energy_added?: number | null;
    },
  ): Promise<TelemetryVehicleState> {
    const prev    = await this.loadState(vehicleId);
    const now     = point.timestamp ? new Date(point.timestamp) : new Date();

    // Track last time speed exceeded 50 km/h (highway driving).
    // Used to suppress false CHARGING flips when the speed field glitches to 0
    // mid-highway (Fleet Telemetry bug) while regen braking produces large
    // negative power — indistinguishable from Supercharging to the classifier.
    const currentSpeed    = point.speed ?? 0;
    const lastHighSpeedMs = currentSpeed > 50
      ? now.getTime()
      : (prev.lastHighSpeedMs ?? 0);

    let next = this.classify(point, prev);

    // Highway-regen guard: if the car was doing >50 km/h within the last 30 s,
    // suppress any CHARGING classification — it's almost certainly a regen spike
    // on a glitched-zero speed field, not a real plug-in event.
    if (next === TelemetryVehicleState.CHARGING && lastHighSpeedMs > 0) {
      const secSinceHighway = (now.getTime() - lastHighSpeedMs) / 1000;
      if (secSinceHighway < 30) {
        this.logger.debug(
          `[StateEngine] ${vehicleId}: suppressing CHARGING flip — highway speed ${secSinceHighway.toFixed(0)}s ago`,
        );
        next = TelemetryVehicleState.IDLE;
      }
    }

    if (prev.state !== next) {
      this.logger.log(
        `[StateEngine] ${vehicleId}: ${prev.state} → ${next} ` +
        `(speed=${point.speed?.toFixed(1) ?? '?'} km/h, power=${point.power?.toFixed(1) ?? '?'} kW)`,
      );
      await this.handleTransition(vehicleId, prev.state, next, point, now, point.charge_energy_added ?? null);
    }

    // Update rolling history and persist
    const newRecord: StateRecord = {
      state:           next,
      since:           prev.state !== next ? now.getTime() : prev.since,
      powerHistory:    [...prev.powerHistory.slice(-4), point.power ?? 0],
      speedHistory:    [...prev.speedHistory.slice(-4), point.speed ?? 0],
      lastHighSpeedMs,
    };
    this.stateCache.set(vehicleId, newRecord);
    await (this.redis as any)
      .set(REDIS_KEY(vehicleId), JSON.stringify(newRecord), 'EX', STATE_TTL)
      .catch(() => {});

    return next;
  }

  // ── State classification ──────────────────────────────────────────────────

  /**
   * Classify vehicle state from a single telemetry point + rolling history.
   *
   * Thresholds:
   *   CHARGING: median power > 20 kW (rules out HVAC/preconditioning max ~8 kW)
   *             AND speed < 2 km/h (not rolling into a stall)
   *   DRIVING:  median speed > 5 km/h (filters GPS drift / slight roll)
   *   IDLE:     everything else
   *
   * Explicit charging_state 'Charging' always wins — we trust Tesla BMS.
   */
  classify(
    point: { speed?: number | null; power?: number | null; charging_state?: string | null; charge_energy_added?: number | null },
    prev: StateRecord,
  ): TelemetryVehicleState {
    const speed = point.speed ?? 0;
    const power = Math.abs(point.power ?? 0);
    const hasChargeEnergy = point.charge_energy_added != null && point.charge_energy_added > 0;

    const speedHist = [...prev.speedHistory.slice(-2), speed];
    const powerHist = [...prev.powerHistory.slice(-2), power];
    const medSpeed  = median3(speedHist);
    const medPower  = median3(powerHist);

    // Terminal charging states: Tesla BMS explicitly said the session is over.
    // These MUST take priority over any power-based heuristics — if the charger
    // reports "Disconnected" we cannot keep classifying as CHARGING just because
    // we still see residual power (e.g. preconditioning after unplug).
    const TERMINAL_STATES = ['Disconnected', 'NoPower', 'Stopped', 'Complete'];
    if (point.charging_state && TERMINAL_STATES.includes(point.charging_state)) {
      // If currently driving, keep DRIVING; otherwise drop to IDLE.
      return prev.state === TelemetryVehicleState.DRIVING
        ? TelemetryVehicleState.DRIVING
        : TelemetryVehicleState.IDLE;
    }

    // Explicit BMS signal — but only when stopped AND actual power is flowing.
    // Fleet Telemetry sends partial batches (e.g. ChargeState without Speed), so
    // we must use medSpeed (rolling median) here — not the raw current speed.
    // Raw speed defaults to 0 when absent, which would wrongly trigger CHARGING
    // while the vehicle is driving.  Also require power > 1 kW to reject stale
    // buffer-replay of a prior charging_state='Charging' after disconnect.
    // Extra guard: if the current state is DRIVING, require the median speed to
    // have actually dropped — never flip DRIVING → CHARGING on a single noisy point.
    const effectiveSpeedOk = medSpeed < 2 && (prev.state !== TelemetryVehicleState.DRIVING || speed < 2);
    if (point.charging_state === 'Charging' && effectiveSpeedOk && power > 1) return TelemetryVehicleState.CHARGING;

    // Some fleet telemetry emits charge energy without an explicit charging_state.
    // Use that as a secondary signal when the car is stopped and power is present.
    if (!point.charging_state && hasChargeEnergy && medPower > 1.5 && medSpeed < 2 && prev.state !== TelemetryVehicleState.DRIVING) {
      return TelemetryVehicleState.CHARGING;
    }

    // Supercharger / DCFC — only reaches > 20 kW when the HV contactor is closed
    if (medPower > 20 && medSpeed < 2)  return TelemetryVehicleState.CHARGING;

    // AC charging (home / destination): > 2 kW + stopped
    // Only flip into CHARGING from IDLE (not from DRIVING — avoids regen misclassification)
    if (prev.state !== TelemetryVehicleState.DRIVING && medPower > 2 && medSpeed < 1) {
      return TelemetryVehicleState.CHARGING;
    }

    if (medSpeed > 5) return TelemetryVehicleState.DRIVING;

    return TelemetryVehicleState.IDLE;
  }

  // ── Transition handler ────────────────────────────────────────────────────

  private async handleTransition(
    vehicleId:          string,
    prev:               TelemetryVehicleState,
    next:               TelemetryVehicleState,
    point:              { soc?: number | null; timestamp?: string },
    now:                Date,
    chargeEnergyAdded:  number | null = null,
  ): Promise<void> {
    // ── Any state → CHARGING ────────────────────────────────────────────────
    // If the car just plugged in, any in-progress trip must be closed BEFORE
    // the charging detector starts a new session. Without this, the trip stays
    // open through the entire charge (ghost trip).
    //
    // Must fire on ANY → CHARGING (not just DRIVING → CHARGING): when a car
    // decelerates into a Supercharger the engine transitions DRIVING → IDLE
    // before IDLE → CHARGING, so the prev=DRIVING guard was too narrow and
    // let the trip remain open through the entire charging session.
    if (next === TelemetryVehicleState.CHARGING) {
      await this.forceCloseOpenTrip(vehicleId, point.soc ?? null, now);
    }

    // ── CHARGING → DRIVING / IDLE ───────────────────────────────────────────
    // Car left the charger. Close any open charging session so the charging
    // detector can start fresh on the next plug-in. Without this, the session
    // stays open if telemetry dropped before the 'Disconnected' signal arrived.
    if (prev === TelemetryVehicleState.CHARGING &&
        next !== TelemetryVehicleState.CHARGING) {
      await this.forceCloseOpenSession(vehicleId, point.soc ?? null, now, chargeEnergyAdded);
    }
  }

  // ── Force-close helpers ───────────────────────────────────────────────────

  /**
   * Close any open trip for the vehicle at the given timestamp.
   * Called when transitioning INTO CHARGING — the trip ended when the car stopped.
   */
  async forceCloseOpenTrip(
    vehicleId: string,
    soc:       number | null,
    at:        Date,
  ): Promise<void> {
    const open = await this.prisma.trip.findFirst({
      where:   { vehicleId, endTime: null },
      orderBy: { startTime: 'desc' },
    });
    if (!open) return;

    // Merge repairReason (legacy) and populate structured repairTags (JSONB).
    // Never overwrite an existing origin tag — the full audit trail must be preserved.
    const existing = (open as any).repairReason as string | null | undefined;
    const existingTags = existing ? existing.split('|').filter(Boolean) : [];
    const mergedReason = existingTags.includes('force_closed_charging_transition')
      ? existing!
      : ['force_closed_charging_transition', ...existingTags].join('|');

    const repairTags = appendRepairTag(
      (open as any).repairTags as any,
      'force_closed_charging_transition',
      'engine',
    );

    await this.prisma.trip.update({
      where: { id: open.id },
      data:  {
        endTime:      at,
        endSoc:       soc ?? undefined,
        repairReason: mergedReason,
        repairTags:   repairTags as any,
      },
    });

    this.logger.warn(
      `[StateEngine] Force-closed trip ${open.id} for ${vehicleId} ` +
      `(DRIVING→CHARGING transition at ${at.toISOString()})`,
    );
  }

  /**
   * Close any open charging session for the vehicle at the given timestamp.
   * Called when transitioning OUT OF CHARGING.
   *
   * Computes energyAddedKwh from the stored chargingPoint power integral so
   * that sessions force-closed by a state-transition (rather than a graceful
   * Disconnected signal in ChargingDetectorService) still have correct energy.
   */
  async forceCloseOpenSession(
    vehicleId:          string,
    soc:                number | null,
    at:                 Date,
    chargeEnergyAdded:  number | null = null,
  ): Promise<void> {
    const open = await this.prisma.chargingSession.findFirst({
      where:   { vehicleId, endTime: null },
      orderBy: { startTime: 'desc' },
    });
    if (!open) return;

    // ── Compute energy from stored charging points ─────────────────────────
    const pts = await this.prisma.chargingPoint.findMany({
      where:   { sessionId: open.id },
      orderBy: { timestamp: 'asc' },
    });

    const powers   = pts.map(p => p.powerKw ?? 0).filter(p => p > 0);
    const maxPower = powers.length ? Math.max(...powers) : null;

    // Power × Δt integral (capped at 6-min gaps — same logic as ChargingDetector)
    let integratedKwh = 0;
    for (let i = 1; i < pts.length; i++) {
      const dtH = (pts[i].timestamp.getTime() - pts[i - 1].timestamp.getTime()) / 3_600_000;
      if (dtH > 0 && dtH < 0.1) {
        integratedKwh += (pts[i - 1].powerKw ?? 0) * dtH;
      }
    }

    // Prefer Tesla's cumulative charger-side reading when plausible
    // (it includes AC→DC losses and is more accurate than power integral)
    let finalEnergy: number | null = null;
    if (chargeEnergyAdded != null && chargeEnergyAdded > integratedKwh * 0.5) {
      finalEnergy = chargeEnergyAdded;
    } else if (integratedKwh > 0.01) {
      finalEnergy = Math.round(integratedKwh * 1000) / 1000;
    } else if (soc != null) {
      // Last-resort: SoC-delta × detected capacity from vehicle record
      const vehicle = await this.prisma.vehicle.findUnique({
        where:  { id: vehicleId },
        select: { batteryCapacityDetected: true, batteryCapacityUsable: true },
      });
      const cap = vehicle?.batteryCapacityDetected ?? vehicle?.batteryCapacityUsable ?? 72;
      const delta = soc - open.startSoc;
      if (delta > 1) finalEnergy = Math.round(delta / 100 * cap * 100) / 100;
    }

    // ── Ghost session guard ───────────────────────────────────────────────
    // Discard sessions that triggered on a false positive (regen, BMS flicker,
    // buffer-replay of stale charging_state). Criteria: very short duration,
    // negligible energy, and SoC didn't actually increase.
    const durationMs = at.getTime() - open.startTime.getTime();
    const socDelta   = soc != null ? soc - open.startSoc : 0;
    const isGhost    =
      (durationMs  < 5 * 60_000  &&   // < 5 minutes
       socDelta     < 0.5         &&   // SoC didn't rise
       (finalEnergy ?? 0) < 0.1)  ||   // < 100 Wh added
      (socDelta < -1 && (finalEnergy ?? 0) < 5); // SOC dropped → not charging (highway regen ghost)
    if (isGhost) {
      await this.prisma.chargingSession.delete({ where: { id: open.id } });
      this.logger.warn(
        `[StateEngine] Deleted ghost charging session ${open.id} for ${vehicleId} ` +
        `(${Math.round(durationMs / 1000)}s, SoC Δ${socDelta.toFixed(1)}%, ${(finalEnergy ?? 0).toFixed(3)} kWh)`,
      );
      return;
    }

    await this.prisma.chargingSession.update({
      where: { id: open.id },
      data:  {
        endTime:        at,
        endSoc:         soc ?? undefined,
        energyAddedKwh: finalEnergy ?? undefined,
        maxPowerKw:     maxPower    ?? undefined,
      },
    });

    this.logger.warn(
      `[StateEngine] Force-closed charging session ${open.id} for ${vehicleId} ` +
      `— ${finalEnergy?.toFixed(2) ?? '?'} kWh, maxPower=${maxPower?.toFixed(1) ?? '?'} kW ` +
      `(CHARGING→${TelemetryVehicleState.IDLE} transition at ${at.toISOString()})`,
    );
  }

  // ── State persistence ─────────────────────────────────────────────────────

  private async loadState(vehicleId: string): Promise<StateRecord> {
    // Hot path: in-memory cache
    const cached = this.stateCache.get(vehicleId);
    if (cached) return cached;

    // Cold start: restore from Redis
    try {
      const raw = await (this.redis as any).get(REDIS_KEY(vehicleId));
      if (raw) {
        const parsed = JSON.parse(raw) as StateRecord;
        this.stateCache.set(vehicleId, parsed);
        return parsed;
      }
    } catch { /* ignore */ }

    // Bootstrap — unknown state, assume IDLE
    const fresh: StateRecord = {
      state:           TelemetryVehicleState.IDLE,
      since:           Date.now(),
      powerHistory:    [],
      speedHistory:    [],
      lastHighSpeedMs: 0,
    };
    this.stateCache.set(vehicleId, fresh);
    return fresh;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function median3(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
