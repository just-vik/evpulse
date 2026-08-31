import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BatteryAnalyticsService } from '../battery/battery-analytics.service';
import { ChargingCostService } from './charging-cost.service';
import { EnergyAnalyticsService } from '../analytics/energy-analytics.service';
import { ChargingSyncService } from '../tesla-fleet/charging-sync.service';
import { EventStoreService } from '../events/event-store.service';

/**
 * ChargingDetectorService — State-machine charging detection
 *
 * Start conditions (both required):
 *   - charger_power  > 1.0 kW      (filters balancing / BMS noise)
 *   - charging_state == 'Charging' OR charger_current > 3 A
 *
 * Pause vs End:
 *   Power drops < 0.5 kW for < 3 min → PAUSED (session stays open)
 *   Power drops < 0.5 kW for > 3 min OR state == Complete/Disconnected → END
 *
 * Energy tracking:
 *   Integrated from power×Δt (kWh) rather than SOC delta — more accurate.
 *
 * Charger type auto-detection from peak power:
 *   < 3 kW → ac_slow | 3–11 kW → ac_home | 11–22 kW → ac_fast | > 22 kW → dc_fast
 */
@Injectable()
export class ChargingDetectorService {
  private readonly logger = new Logger(ChargingDetectorService.name);

  private readonly MIN_CHARGE_POWER_KW    = 1.0;  // below this = not charging
  private readonly PAUSE_THRESHOLD_KW     = 0.5;  // power floor during a pause
  private readonly PAUSE_GRACE_MS         = 3 * 60 * 1000; // 3 min pause tolerance

  // Per-vehicle transient state
  private readonly cache = new Map<string, {
    isCharging:              boolean;
    powerLowAt:              Date | null;  // when power first dropped below threshold
    lastPowerKw:             number;
    lastTime:                Date;
    energyKwh:               number;       // integrated energy (fallback)
    chargeEnergyAdded:       number | null; // Tesla charge_state.charge_energy_added (charger-side, preferred)
    chargeEnergyAddedAtStart: number | null; // baseline at session start — delta avoids carryover across sessions
    speedHistory:            number[];     // rolling last-3 speeds for null-safe vehicle-stopped check
    // Pending charging: ChargingState='Charging' arrived before power confirmed.
    // Captures the true pre-ramp SOC so it becomes the session startSoc.
    pendingChargingAt:       Date | null;
    pendingChargingSoc:      number | null;
  }>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly batteryAnalytics?: BatteryAnalyticsService,
    @Optional() private readonly chargingCost?: ChargingCostService,
    @Optional() private readonly energyAnalytics?: EnergyAnalyticsService,
    @Optional() @Inject(forwardRef(() => ChargingSyncService)) private readonly chargingSync?: ChargingSyncService,
    @Optional() private readonly eventStore?: EventStoreService,
  ) {}

  // ─────────────────────── Public entry point ───────────────────────────────

  async checkChargingState(
    vehicleId: string,
    data: {
      charging_state?:      string;
      power?:               number;
      current?:             number;
      voltage?:             number;
      soc?:                 number;
      lat?:                 number | null;
      lng?:                 number | null;
      speed?:               number | null;
      charger_type?:        string;
      fast_charger_type?:   string | null;
      fast_charger_brand?:  string | null;
      /** Tesla charge_state.charge_energy_added — cumulative kWh from charger this session */
      charge_energy_added?: number | null;
      timestamp?:           string;
    },
  ): Promise<void> {
    const now             = data.timestamp ? new Date(data.timestamp) : new Date();
    const rawPower        = data.power ?? 0;
    const powerKw         = Math.abs(rawPower); // power is negative when charging in some APIs
    const isNegativePower = rawPower < -1;
    const currentA        = data.current ?? 0;
    const state           = data.charging_state ?? '';

    // Restore cache from DB on cold start (prevents duplicate sessions after API restart).
    // If the in-memory cache is empty but an open session exists in DB, seed isCharging=true.
    if (!this.cache.has(vehicleId)) {
      const openSession = await this.prisma.chargingSession.findFirst({
        where: { vehicleId, endTime: null },
      });
      if (openSession) {
        this.cache.set(vehicleId, {
          isCharging: true, powerLowAt: null, lastPowerKw: powerKw, lastTime: now,
          energyKwh: openSession.energyAddedKwh ?? 0,
          chargeEnergyAdded: data.charge_energy_added ?? null,
          // Seed baseline from DB so the power-integral accumulates on top of already-recorded
          // energy rather than from zero (prevents undercount after a mid-session restart).
          chargeEnergyAddedAtStart: data.charge_energy_added != null && (openSession.energyAddedKwh ?? 0) > 0
            ? data.charge_energy_added - (openSession.energyAddedKwh ?? 0)
            : null,
          speedHistory: [data.speed ?? 0],
          pendingChargingAt: null, pendingChargingSoc: null,
        });
        this.logger.debug(`[Charging] Cache restored from DB for ${vehicleId} (session ${openSession.id})`);
      }
    }

    const prev = this.cache.get(vehicleId) ?? {
      isCharging: false, powerLowAt: null, lastPowerKw: 0, lastTime: now, energyKwh: 0,
      chargeEnergyAdded: null, chargeEnergyAddedAtStart: null,
      speedHistory: [] as number[],
      pendingChargingAt: null as Date | null, pendingChargingSoc: null as number | null,
    };
    // Track latest charge_energy_added from Tesla (always update, even before session starts)
    const latestChargeEnergy = data.charge_energy_added != null && data.charge_energy_added > 0
      ? data.charge_energy_added
      : prev.chargeEnergyAdded;

    const terminalStates = ['Complete', 'Disconnected', 'NoPower', 'Stopped'];
    const isTerminal     = terminalStates.includes(state);
    const meetsThreshold =
      powerKw > this.MIN_CHARGE_POWER_KW ||
      currentA > 3 ||
      isNegativePower;
    // Energy delta check (4.3): prefer Tesla's cumulative energy signal over power reading.
    // This filters preconditioning noise — only true charging increases charge_energy_added.
    const energyDelta = data.charge_energy_added != null && prev.chargeEnergyAdded != null
      ? data.charge_energy_added - prev.chargeEnergyAdded : null;
    const energyGrowing = energyDelta !== null && energyDelta > 0;

    // Rolling median speed — Fleet Telemetry sends partial batches (e.g. ChargeState without Speed),
    // so data.speed can be null while the vehicle is actually moving.  Using the median of the last
    // 3 known speeds avoids 0-speed false positives from null-defaulted missing fields.
    const speed = data.speed ?? 0;
    const newSpeedHist = [...(prev.speedHistory ?? []).slice(-2), speed];
    const medSpeed = medianOfArr(newSpeedHist);

    // Fleet telemetry may send power without ChargeState in the same batch.
    // Infer charging from unambiguously high DC power + stopped vehicle.
    // IMPORTANT: require isNegativePower (rawPower < -1) — Tesla reports power as
    // negative when charging (energy flowing INTO battery).  Battery preconditioning
    // (heating pack before a Supercharger stop) draws 20-30 kW FROM the battery
    // (positive rawPower) and must NOT be mistaken for charging.
    const inferredCharging = !isTerminal &&
      isNegativePower &&           // power must flow INTO battery (negative = charging)
      powerKw > 20 && medSpeed < 2 &&  // use median — null speed defaults to 0
      state !== 'Disconnected' && state !== 'NoPower' && state !== 'Stopped';

    // Session start requires the vehicle to be genuinely stopped (median speed < 5 km/h).
    // This prevents a single telemetry batch without a speed field from triggering charging
    // detection while the vehicle is actually driving.
    const vehicleStopped = medSpeed < 5;
    const activeChargingState =
      state === 'Charging' ||
      (state === 'Complete' && (energyGrowing || meetsThreshold || isNegativePower));
    const isActiveState = vehicleStopped && (activeChargingState || inferredCharging) && (energyGrowing || meetsThreshold);

    // ── PENDING CHARGING: ChargingState='Charging' arrived before power confirmed ──
    // BMS negotiation can take 30-120s on slow home chargers. Fleet Telemetry sends
    // ChargingState='Charging' in one batch, then ACChargingPower in a later batch.
    // The carry-forward window (CARRY_MAX_AGE_MS) may expire between those batches,
    // leaving subsequent power batches with no ChargingState → isActiveState=false.
    // By saving the SOC at the first 'Charging' signal, we preserve the true start SOC
    // and use it when power eventually arrives to confirm the session.
    const hasPendingCharging = prev.pendingChargingAt !== null;
    const pendingWithinWindow = hasPendingCharging &&
      (now.getTime() - prev.pendingChargingAt!.getTime()) < 5 * 60_000;

    if (state === 'Charging' && vehicleStopped && !prev.isCharging && !(energyGrowing || meetsThreshold)) {
      if (!hasPendingCharging) {
        this.logger.debug(
          `[Charging] Pending charging for ${vehicleId} @ SOC ${data.soc ?? 'n/a'}% — awaiting power confirmation`,
        );
      }
      this.cache.set(vehicleId, {
        ...prev,
        lastTime: now,
        speedHistory: newSpeedHist,
        pendingChargingAt:  prev.pendingChargingAt  ?? now,
        pendingChargingSoc: prev.pendingChargingSoc ?? (data.soc ?? null),
      });
      return;
    }

    // ── Integrate energy over elapsed time ────────────────────────────────
    const dtHours = (now.getTime() - prev.lastTime.getTime()) / 3_600_000;
    const deltaKwh = prev.isCharging && dtHours > 0 && dtHours < 0.1 // cap at 6 min gap
      ? prev.lastPowerKw * dtHours : 0;
    const sessionEnergy = prev.energyKwh + deltaKwh;

    // ── SESSION START ──────────────────────────────────────────────────────
    if (!prev.isCharging && isActiveState) {
      // Use pending SOC/time if ChargingState arrived before power — preserves the true start SOC.
      const sessionStartTime = pendingWithinWindow ? prev.pendingChargingAt! : now;
      const sessionStartSoc  = pendingWithinWindow
        ? (prev.pendingChargingSoc ?? data.soc ?? 0)
        : (data.soc ?? 0);

      if (pendingWithinWindow) {
        this.logger.log(
          `[Charging] Session started for vehicle ${vehicleId} @ ${powerKw.toFixed(1)} kW — ` +
          `restoring SOC ${sessionStartSoc}% from ${Math.round((now.getTime() - sessionStartTime.getTime()) / 1000)}s ago`,
        );
      } else {
        this.logger.log(`[Charging] Session started for vehicle ${vehicleId} @ ${powerKw.toFixed(1)} kW (charger: ${data.fast_charger_type ?? 'AC'})`);
      }

      // Note: cross-domain trip close is handled upstream by TelemetryEventEngine
      // (DRIVING→CHARGING transition fires forceCloseOpenTrip before this point is processed).
      // GPS only recorded when median speed < 5 km/h — avoids saving coords while rolling.
      await this.startSession(vehicleId, {
        ...data,
        soc:                sessionStartSoc,
        fast_charger_type:  data.fast_charger_type,
        fast_charger_brand: data.fast_charger_brand,
        lat:                medSpeed < 5 ? (data.lat  ?? null) : null,
        lng:                medSpeed < 5 ? (data.lng  ?? null) : null,
      }, sessionStartTime);
      this.cache.set(vehicleId, {
        isCharging: true, powerLowAt: null,
        lastPowerKw: powerKw, lastTime: now, energyKwh: 0,
        chargeEnergyAdded: latestChargeEnergy,
        chargeEnergyAddedAtStart: latestChargeEnergy, // capture baseline at session start
        speedHistory: newSpeedHist,
        pendingChargingAt: null, pendingChargingSoc: null,
      });
      return;
    }

    // ── ACTIVE CHARGING ────────────────────────────────────────────────────
    if (prev.isCharging) {
      const powerDipped = powerKw < this.PAUSE_THRESHOLD_KW;

      if (!powerDipped && !isTerminal) {
        // Normal charging — record point, update energy (write live energy so watchdog has data)
        await this.recordPoint(vehicleId, data, now, sessionEnergy).catch(() => {});
        this.cache.set(vehicleId, {
          isCharging: true, powerLowAt: null,
          lastPowerKw: powerKw, lastTime: now, energyKwh: sessionEnergy,
          chargeEnergyAdded: latestChargeEnergy,
          chargeEnergyAddedAtStart: prev.chargeEnergyAddedAtStart,
          speedHistory: newSpeedHist,
          pendingChargingAt: null, pendingChargingSoc: null,
        });
        return;
      }

      if (powerDipped && !isTerminal) {
        // Possible pause — wait for grace period before ending
        const pausedAt = prev.powerLowAt ?? now;
        const pauseMs  = now.getTime() - pausedAt.getTime();

        if (pauseMs < this.PAUSE_GRACE_MS) {
          this.logger.debug(`[Charging] Power dip for ${vehicleId} — grace ${Math.round(pauseMs/1000)}s`);
          this.cache.set(vehicleId, {
            isCharging: true, powerLowAt: pausedAt,
            lastPowerKw: powerKw, lastTime: now, energyKwh: sessionEnergy,
            chargeEnergyAdded: latestChargeEnergy,
            chargeEnergyAddedAtStart: prev.chargeEnergyAddedAtStart,
            speedHistory: newSpeedHist,
            pendingChargingAt: null, pendingChargingSoc: null,
          });
          return;
        }
        // API still reports active charging or energy is increasing — do not end the session.
        // Sparse REST/MQTT often drops power for minutes while the car keeps charging (TezLab-style continuity).
        if (state === 'Charging' || energyGrowing) {
          await this.recordPoint(vehicleId, data, now, sessionEnergy).catch(() => {});
          const holdPower = Math.max(
            powerKw,
            prev.lastPowerKw,
            this.MIN_CHARGE_POWER_KW * 0.55,
          );
          this.cache.set(vehicleId, {
            isCharging: true,
            powerLowAt: null,
            lastPowerKw: holdPower,
            lastTime: now,
            energyKwh: sessionEnergy,
            chargeEnergyAdded: latestChargeEnergy,
            chargeEnergyAddedAtStart: prev.chargeEnergyAddedAtStart,
            speedHistory: newSpeedHist,
            pendingChargingAt: null, pendingChargingSoc: null,
          });
          this.logger.debug(
            `[Charging] Power gap beyond grace but still charging (state=${state || 'n/a'}) — holding session ${vehicleId}`,
          );
          return;
        }
      }

      // End session: prefer charge_energy_added delta (charger-side, most accurate) over power integral.
      // Using delta (current − baseline) prevents carryover when charger stays physically connected
      // across sessions (charge_energy_added is cumulative from last physical plug-in).
      const chargeEnergyDelta =
        latestChargeEnergy != null && prev.chargeEnergyAddedAtStart != null
          ? latestChargeEnergy - prev.chargeEnergyAddedAtStart
          : null;
      const finalEnergy = chargeEnergyDelta != null && chargeEnergyDelta > 0 && chargeEnergyDelta > sessionEnergy * 0.5
        ? chargeEnergyDelta    // Tesla charger-side delta (includes AC→DC losses, ~10% higher than battery)
        : sessionEnergy;       // fallback: integrated power×dt
      this.logger.log(
        `[Charging] Session ended for vehicle ${vehicleId} — ` +
        `${finalEnergy.toFixed(2)} kWh ` +
        `(source: ${chargeEnergyDelta != null && chargeEnergyDelta > 0 ? 'tesla_api_delta' : 'power_integral'})`,
      );
      const endedSession = await this.endSession(vehicleId, data, finalEnergy, now);
      this.cache.set(vehicleId, {
        isCharging: false, powerLowAt: null,
        lastPowerKw: 0, lastTime: now, energyKwh: 0,
        chargeEnergyAdded: null, chargeEnergyAddedAtStart: null,
        speedHistory: newSpeedHist,
        pendingChargingAt: null, pendingChargingSoc: null,
      });

      // Calculate cost for ended session (static tariff fallback — runs immediately)
      if (endedSession && this.chargingCost) {
        this.chargingCost.calculateSessionCost(endedSession.id).catch((e: Error) =>
          this.logger.warn(`Cost calculation failed for session ${endedSession.id}: ${e.message}`),
        );
      }

      // For Supercharger sessions: trigger delayed Tesla billing sync (5 min after end).
      // Tesla's billing API finalizes the real cost 5–15 min after disconnect.
      // This overwrites the static tariff set above with the authoritative Tesla price.
      // Using syncSessionAfterEnd (setTimeout 5 min) rather than waiting for the 15-min cron.
      if (endedSession) {
        const isSc = endedSession.chargerType === 'tesla_sc' || endedSession.chargerType === 'supercharger';
        if (isSc) {
          this.chargingSync?.syncSessionAfterEnd(endedSession.id);
        }
      }

      // Auto-calibrate battery capacity when charging to ≥95% (BMS fully recalibrated)
      if (endedSession) {
        this.calibrateCapacity(vehicleId, endedSession.id).catch((e: Error) =>
          this.logger.warn(`Capacity calibration failed for ${vehicleId}: ${e.message}`),
        );
      }

      // Trigger battery SOH recalculation after charging session (best data source)
      if (this.batteryAnalytics) {
        this.batteryAnalytics.updateBatteryMetrics(vehicleId).catch((e: Error) =>
          this.logger.warn(`Battery analytics update failed for ${vehicleId}: ${e.message}`),
        );

        // Track charge-side cycle accumulation (independent from drive-side tracking)
        if (finalEnergy > 0) {
          this.batteryAnalytics.trackCycles(vehicleId, finalEnergy, 'charge').catch(() => undefined);
        }
      }

      // Update daily energy aggregates for cost forecast
      if (this.energyAnalytics) {
        this.energyAnalytics.updateDailyEnergy(vehicleId, now).catch((e: Error) =>
          this.logger.warn(`Daily energy update failed for ${vehicleId}: ${e.message}`),
        );
      }
      return;
    }

    // Not charging — just update cache
    this.cache.set(vehicleId, {
      isCharging: false, powerLowAt: null,
      lastPowerKw: powerKw, lastTime: now, energyKwh: 0,
      chargeEnergyAdded: null, chargeEnergyAddedAtStart: null,
      speedHistory: newSpeedHist,
      pendingChargingAt: null, pendingChargingSoc: null,
    });
  }

  // ─────────────────────── Session lifecycle ────────────────────────────────

  private async startSession(
    vehicleId: string,
    data:      { soc?: number; charger_type?: string; power?: number; fast_charger_type?: string | null; fast_charger_brand?: string | null; lat?: number | null; lng?: number | null },
    now:       Date,
  ) {
    // Hard guard against duplicate starts from parallel pipelines/processes.
    // If an open session already exists, do not create another one.
    const existing = await this.prisma.chargingSession.findFirst({
      where: { vehicleId, endTime: null },
      orderBy: { startTime: 'desc' },
      select: { id: true },
    });
    if (existing) return;

    const chargerType = data.charger_type
      ?? await this.detectChargerType(Math.abs(data.power ?? 0), data.fast_charger_type, data.fast_charger_brand, vehicleId, data.lat ?? null, data.lng ?? null);

    const session = await this.prisma.chargingSession.create({
      data: {
        vehicleId,
        startTime:   now,
        startSoc:    data.soc ?? 0,
        chargerType,
        startLat:    data.lat  ?? null,
        startLng:    data.lng  ?? null,
      } as any,
    });

    this.eventStore?.emitChargingStarted(vehicleId, {
      sessionId:   session.id,
      startTime:   now.toISOString(),
      startSoc:    data.soc ?? 0,
      chargerType: chargerType ?? null,
      startLat:    data.lat ?? null,
      startLng:    data.lng ?? null,
    });
  }

  private async recordPoint(
    vehicleId:    string,
    data:         { power?: number; current?: number; voltage?: number; soc?: number },
    now:          Date,
    liveEnergy?:  number,  // running kWh total from the detector cache
  ) {
    const session = await this.prisma.chargingSession.findFirst({
      where: { vehicleId, endTime: null },
      orderBy: { startTime: 'desc' },
      select: { id: true, maxPowerKw: true },
    });
    if (!session) return;

    const powerKw = Math.abs(data.power ?? 0);

    await this.prisma.chargingPoint.create({
      data: {
        sessionId: session.id,
        timestamp: now,
        powerKw,
        current:   data.current ?? null,
        voltage:   data.voltage ?? null,
        soc:       data.soc     ?? null,
      },
    });

    // Write live energy and peak power using GREATEST to be race-safe.
    // If two workers call recordPoint concurrently (e.g. DLQ replay + live stream),
    // a plain UPDATE would let a stale worker overwrite a fresher accumulated value.
    // GREATEST(COALESCE(col, 0), new) guarantees the column only ever increases.
    const roundedEnergy = liveEnergy != null && liveEnergy > 0
      ? Math.round(liveEnergy * 100) / 100 : null;

    // updatedAt = NOW() is explicit here because $executeRaw bypasses Prisma's
    // @updatedAt auto-management.  Keeping it current lets ops queries detect
    // "stuck" sessions (open sessions whose updatedAt is stale by > N hours).
    (roundedEnergy != null
      ? this.prisma.$executeRaw`
          UPDATE charging_sessions
          SET "maxPowerKw"     = GREATEST(COALESCE("maxPowerKw",     0), ${powerKw}::numeric),
              "energyAddedKwh" = GREATEST(COALESCE("energyAddedKwh", 0), ${roundedEnergy}::numeric),
              "updatedAt"      = NOW()
          WHERE id = ${session.id}
        `
      : this.prisma.$executeRaw`
          UPDATE charging_sessions
          SET "maxPowerKw" = GREATEST(COALESCE("maxPowerKw", 0), ${powerKw}::numeric),
              "updatedAt"  = NOW()
          WHERE id = ${session.id}
        `
    ).catch(() => { /* non-blocking — best effort */ });
  }

  private async endSession(
    vehicleId:    string,
    data:         { soc?: number },
    energyKwh:    number,
    now:          Date,
  ): Promise<{ id: string; chargerType: string | null } | null> {
    const [session, vehicle] = await Promise.all([
      this.prisma.chargingSession.findFirst({
        where: { vehicleId, endTime: null },
        orderBy: { startTime: 'desc' },
      }),
      this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: { batteryCapacityDetected: true, batteryCapacityUsable: true },
      }),
    ]);
    if (!session) return null;

    // Peak power from recorded points
    const points   = await this.prisma.chargingPoint.findMany({ where: { sessionId: session.id } });
    const powers   = points.map(p => p.powerKw ?? 0).filter(p => p > 0);
    const maxPower = powers.length ? Math.max(...powers) : null;

    const endSoc = data.soc ?? null;
    const roundedEnergy = Math.round(energyKwh * 1000) / 1000;

    // ── Ghost session guard ──────────────────────────────────────────────────
    // Discard false-positive sessions: regen spikes, BMS flickers, stale
    // buffer-replay of charging_state, brief preconditioning bleed-through.
    //
    // Rule A — trivially tiny energy: < 50 Wh regardless of duration/SOC.
    //   Catches any residual ghost that slipped past inferredCharging fix.
    // Rule B — short + no real SOC rise: < 5 min AND SOC didn't move.
    //   Catches 1–2 min 'Charging' blips that produced a non-trivial power
    //   reading but never actually charged the battery cells.
    const durationMs = now.getTime() - session.startTime.getTime();
    const socDelta   = endSoc != null ? endSoc - session.startSoc : 0;
    const isGhost    =
      roundedEnergy < 0.05 ||                              // Rule A: < 50 Wh — never real
      (durationMs < 5 * 60_000 && socDelta < 0.5 && roundedEnergy < 0.1) || // Rule B
      (socDelta < -1 && roundedEnergy < 5);                // Rule C: SOC dropped → not charging (regen/drive ghost)
    if (isGhost) {
      this.logger.warn(
        `[Charging] Ghost session discarded for ${vehicleId} ` +
        `(${Math.round(durationMs / 1000)}s, SoC Δ${socDelta.toFixed(1)}%, ${roundedEnergy.toFixed(3)} kWh)`,
      );
      await this.prisma.chargingSession.delete({ where: { id: session.id } });
      return null;
    }

    // ── Charging efficiency ──────────────────────────────────────────────────
    // efficiency = energyAdded / theoreticalBatteryGain
    // theoreticalGain = (ΔSOC / 100) × usableCapacity
    // < 1.0 means conversion losses (heat, DC/AC losses). Typical:
    //   AC home 0.90–0.96, DC fast 0.85–0.93 (higher peak power = more loss).
    let chargingEfficiency: number | null = null;
    const deltaSoc = endSoc != null ? endSoc - session.startSoc : null;
    const detectedCap = vehicle?.batteryCapacityDetected ?? vehicle?.batteryCapacityUsable ?? 72;
    if (deltaSoc != null && deltaSoc >= 2 && roundedEnergy > 0 && detectedCap > 0) {
      const expectedKwh = (deltaSoc / 100) * detectedCap;
      const raw = roundedEnergy / expectedKwh;
      // Clamp to [0.70, 1.25] — values > 1.0 are normal for AC home charging where
      // charge_energy_added is charger-side (includes AC→DC conversion losses ~5–15%).
      // Values outside [0.70, 1.25] indicate bad SOC data or sensor noise.
      if (raw >= 0.70 && raw <= 1.25) {
        chargingEfficiency = Math.round(raw * 1000) / 1000;
      }
    }

    await this.prisma.chargingSession.update({
      where: { id: session.id },
      data: {
        endTime:            now,
        endSoc,
        energyAddedKwh:     roundedEnergy,
        maxPowerKw:         maxPower,
        chargingEfficiency,
      },
    });

    if (chargingEfficiency != null) {
      this.logger.debug(
        `[Charging] ${vehicleId}: efficiency ${(chargingEfficiency * 100).toFixed(1)}% ` +
        `(${roundedEnergy} kWh in, SOC +${deltaSoc?.toFixed(0)}%, cap=${detectedCap} kWh)`,
      );
    }

    // ── Billing-ready event ───────────────────────────────────────────────────
    const durationMin = Math.round((now.getTime() - session.startTime.getTime()) / 60_000);
    this.eventStore?.emitChargingEnded(vehicleId, {
      sessionId:       session.id,
      startTime:       session.startTime.toISOString(),
      endTime:         now.toISOString(),
      energyAddedKwh:  roundedEnergy,
      maxPowerKw:      maxPower ?? null,
      startSoc:        session.startSoc,
      endSoc:          endSoc ?? null,
      chargerType:     session.chargerType ?? null,
      durationMin,
    });

    return { id: session.id, chargerType: session.chargerType ?? null };
  }

  // ─────────────────────── Capacity calibration ────────────────────────────

  /**
   * When a session ends at ≥95% SOC, the BMS is fully recalibrated — ideal
   * moment to derive real usable capacity from billing/measured energy.
   * Efficiency factors account for conversion losses before the battery cells.
   */
  private async calibrateCapacity(vehicleId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.chargingSession.findUnique({ where: { id: sessionId } });
    if (!session || !session.endSoc || session.endSoc < 95) return;
    if (!session.energyAddedKwh || session.energyAddedKwh <= 0) return;

    const socDelta = (session.endSoc - session.startSoc) / 100;
    if (socDelta <= 0.1) return; // need at least 10% SOC change for a reliable estimate

    const isDc = session.chargerType === 'supercharger' || session.chargerType === 'tesla_sc' || session.chargerType === 'dc_fast' || session.chargerType === 'dc_third';
    const efficiency = isDc ? 0.94 : 0.90;
    const detectedCapacity = (session.energyAddedKwh * efficiency) / socDelta;

    // Sanity check: accept only physically plausible values for a Tesla
    if (detectedCapacity < 50 || detectedCapacity > 110) return;

    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { batteryCapacityDetected: Math.round(detectedCapacity * 100) / 100 },
    });

    this.logger.log(
      `Battery capacity calibrated for ${vehicleId}: ${detectedCapacity.toFixed(2)} kWh ` +
      `(${session.energyAddedKwh} kWh added, SOC ${session.startSoc}→${session.endSoc}%, eff=${efficiency})`,
    );
  }

  // ─────────────────────── Helpers ──────────────────────────────────────────

  private async detectChargerType(
    powerKw:          number,
    fastChargerType?: string | null,
    fastChargerBrand?: string | null,
    vehicleId?:       string,
    lat?:             number | null,
    lng?:             number | null,
  ): Promise<string> {
    // Tesla Supercharger: explicit signal OR power >= 50 kW (V2 shared = 50 kW, V3/V4 = 250/350 kW).
    // Using >= 50 (not > 50) so a V2 at exactly 50 kW is correctly typed as tesla_sc.
    const TESLA_SC_CHARGER_TYPES = new Set(['Tesla', 'NACS', 'TeslaNACS', 'Tesla,CCS']);
    if (
      TESLA_SC_CHARGER_TYPES.has(fastChargerType ?? '') ||
      fastChargerBrand === 'Tesla' ||
      powerKw >= 50
    ) return 'tesla_sc';

    // 3rd-party DC fast (Ionity, Allego, EnBW …): 22–50 kW
    if (powerKw > 22) return 'dc_third';

    // Public AC city charger (up to 22 kW)
    if (powerKw > 11) return 'ac_city';

    // Slow home socket ≤ 2 kW (8 A × 230 V ≈ 1.84 kW)
    if (powerKw <= 2) return 'home_slow';

    // 2–11 kW: check if vehicle is at registered home location
    if (vehicleId && lat != null && lng != null) {
      const isHome = await this.isAtHomeLocation(vehicleId, lat, lng);
      if (isHome) return 'home_wall';
    }

    // Default: assume home wall-box (most common for this power range)
    return 'home_wall';
  }

  private async isAtHomeLocation(vehicleId: string, lat: number, lng: number): Promise<boolean> {
    const settings = await this.prisma.vehicleSettings.findUnique({
      where:  { vehicleId },
      select: { homeLatitude: true, homeLongitude: true },
    });
    if (!settings?.homeLatitude || !settings?.homeLongitude) return false;
    return this.haversineM(lat, lng, settings.homeLatitude, settings.homeLongitude) < 200;
  }

  private haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R    = 6_371_000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ─────────────────────── Analytics queries ────────────────────────────────

  async getChargingSessions(vehicleId: string, limit = 30, from?: Date, to?: Date) {
    const rows = await this.prisma.chargingSession.findMany({
      where:   { vehicleId, ...(from || to ? { startTime: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) },
      orderBy: { startTime: 'desc' },
      take:    limit,
      include: { points: { take: 100 } },
    });
    const openStarts = new Set(
      rows
        .filter((s) => s.endTime == null)
        .map((s) => s.startTime.getTime()),
    );
    const openSession = rows.find((s) => s.endTime == null) ?? null;
    const isGhostClosed = (s: typeof rows[number]): boolean => {
      if (!s.endTime) return false;
      const durationMs = s.endTime.getTime() - s.startTime.getTime();
      const energy = s.energyAddedKwh ?? 0;
      const socDropOrFlat = s.startSoc != null && s.endSoc != null && s.endSoc <= s.startSoc;
      return durationMs <= 2 * 60_000 && energy < 0.05 && socDropOrFlat;
    };
    return rows.filter((s) => {
      // Hide stale ghost duplicates when an open session with the same start exists.
      if (s.endTime == null) return true;
      if (isGhostClosed(s)) return false;
      const energy = s.energyAddedKwh ?? 0;
      const socDropGhost = s.startSoc != null && s.endSoc != null && s.endSoc < s.startSoc;
      const sameStartAsOpen = openStarts.has(s.startTime.getTime());
      if (sameStartAsOpen && energy < 0.05 && socDropGhost) return false;
      // Hide contiguous split of the same in-progress charge:
      // if a closed session ends right before an open one starts, treat it as one session.
      if (openSession && s.endTime) {
        const gapMs = openSession.startTime.getTime() - s.endTime.getTime();
        const contiguous = gapMs >= 0 && gapMs <= 2 * 60_000;
        const sameCharger = (s.chargerType ?? null) === (openSession.chargerType ?? null);
        if (contiguous && sameCharger) return false;
      }
      return true;
    });
  }

  async getChargingStats(vehicleId: string, days = 30) {
    const since    = new Date(Date.now() - days * 86_400_000);
    const sessions = await this.prisma.chargingSession.findMany({
      where: { vehicleId, startTime: { gte: since }, endTime: { not: null } },
    });
    if (!sessions.length) return null;

    const energies = sessions.map(s => s.energyAddedKwh ?? 0);
    const total    = energies.reduce((a, b) => a + b, 0);

    return {
      totalSessions:          sessions.length,
      totalEnergyKwh:         Math.round(total * 10) / 10,
      avgEnergyPerSessionKwh: Math.round((total / sessions.length) * 10) / 10,
      mostUsedCharger:        this.getMostUsedCharger(sessions),
      period:                 { since, until: new Date() },
    };
  }

  private getMostUsedCharger(sessions: { chargerType?: string | null }[]): string {
    const counts: Record<string, number> = {};
    for (const s of sessions) {
      const t = s.chargerType ?? 'unknown';
      counts[t] = (counts[t] ?? 0) + 1;
    }
    return Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b, 'unknown');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function medianOfArr(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
