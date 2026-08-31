import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { RedisService } from '../redis/redis.service';
import { BatteryAnalyticsService } from '../battery/battery-analytics.service';
import { VampireDrainService } from '../telemetry/vampire-drain.service';

/**
 * Data quality levels derived from telemetry freshness.
 *
 *   REALTIME  < 30s   — live data, all UI enabled
 *   DELAYED   30–120s — slightly behind, show badge, all controls still active
 *   STALE     120–600s — old data, hide realtime fields (speed/power), show last-known SOC
 *   OFFLINE   > 600s / null — no recent data, hide all realtime UI, disable all controls
 *
 * Thresholds are calibrated for Tesla's actual REST polling cadence (2–5 min normal,
 * 30s while driving), so DELAYED is not triggered by a single missed poll.
 */
export type DataQuality = 'REALTIME' | 'DELAYED' | 'STALE' | 'OFFLINE';

export function getDataQuality(freshnessSec: number | null): DataQuality {
  if (freshnessSec === null || freshnessSec >= 600) return 'OFFLINE';
  if (freshnessSec < 30)  return 'REALTIME';
  if (freshnessSec < 120) return 'DELAYED';
  return 'STALE';
}

@Injectable()
export class VehicleAnalyticsService {
  private readonly logger = new Logger(VehicleAnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telemetryService: TelemetryService,
    private readonly redis: RedisService,
    @Optional() private readonly batteryAnalytics: BatteryAnalyticsService,
    @Optional() private readonly vampireDrain: VampireDrainService,
  ) {}

  private async cacheGet(key: string): Promise<string | null> {
    try { return await this.redis.get(key); } catch { return null; }
  }

  private async cacheSet(key: string, value: string, ttl: number): Promise<void> {
    try { await this.redis.set(key, value, 'EX', ttl); } catch { /* ignore */ }
  }

  /**
   * Lightweight aggregation for current vehicle status.
   * Uses latest telemetry point only – no heavy scans.
   */
  async getVehicleStatus(vehicleId: string) {
    const cacheKey = `vehicle:status:${vehicleId}`;
    const cached = await this.cacheGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const [latest, dbState, activeChargingSession] = await Promise.all([
      this.telemetryService.getLatestPoint(vehicleId),
      this.prisma.vehicleState.findUnique({ where: { vehicleId } }),
      // Check for an open charging session — if one exists the car IS charging regardless
      // of what the stale REST-poll chargingState says.
      this.prisma.chargingSession.findFirst({
        where: { vehicleId, endTime: null },
        orderBy: { startTime: 'desc' },
        select: { id: true },
      }),
    ]);

    // Fleet telemetry sends different fields at different rates — the absolute latest point
    // often has null soc/range (only PackVoltage/PackCurrent). Fall back to last known values.
    const [lastSocPoint, lastRangePoint, lastOdoPoint, lastInsideTempPoint, lastOutsideTempPoint, lastPackVoltagePoint] = await Promise.all([
      latest?.soc == null
        ? this.prisma.telemetryPoint.findFirst({
            where: { vehicleId, soc: { not: null } },
            orderBy: { timestamp: 'desc' },
            select: { soc: true },
          })
        : null,
      (latest as any)?.batteryRangeKm == null
        ? this.prisma.$queryRaw<{ batteryRangeKm: number }[]>`
            SELECT "batteryRangeKm" FROM telemetry_points
            WHERE "vehicleId" = ${vehicleId} AND "batteryRangeKm" IS NOT NULL
            ORDER BY timestamp DESC LIMIT 1`
        : null,
      latest?.odometer == null
        ? this.prisma.telemetryPoint.findFirst({
            where: { vehicleId, odometer: { not: null } },
            orderBy: { timestamp: 'desc' },
            select: { odometer: true },
          })
        : null,
      (latest as any)?.insideTemp == null
        ? this.prisma.telemetryPoint.findFirst({
            where: { vehicleId, insideTemp: { not: null } },
            orderBy: { timestamp: 'desc' },
            select: { insideTemp: true },
          })
        : null,
      latest?.outsideTemp == null
        ? this.prisma.telemetryPoint.findFirst({
            where: { vehicleId, outsideTemp: { not: null } },
            orderBy: { timestamp: 'desc' },
            select: { outsideTemp: true },
          })
        : null,
      // HV pack voltage fallback: voltage >= 300 V to exclude stale AC charger readings (AC ~230V).
      // Only look back 48h so the diagnostics card doesn't show weeks-old data.
      (latest as any)?.voltage == null
        ? this.prisma.telemetryPoint.findFirst({
            where: {
              vehicleId,
              voltage: { gte: 300 },
              timestamp: { gte: new Date(Date.now() - 48 * 3_600_000) },
            },
            orderBy: { timestamp: 'desc' },
            select: { voltage: true },
          })
        : null,
    ]);

    if (!latest) {
      const empty = {
        vehicleId,
        soc: null,
        batteryRangeKm: null,
        speed: null,
        power: null,
        batteryTemp: null,
        outsideTemp: null,
        insideTemp: null,
        odometer: null,
        lastUpdate: null,
        vehicleState: dbState?.state ?? 'Offline',
        chargingState: null,
        drivingState: null,
        locked: null,
        isOnline: false,
        dataFreshnessSec: null,
        dataQuality: 'OFFLINE' as DataQuality,
      };
      await this.cacheSet(cacheKey, JSON.stringify(empty), 5);
      return empty;
    }

    const latestTsMs = latest.timestamp ? new Date(latest.timestamp as any).getTime() : NaN;
    const stateTsMs = dbState?.lastUpdate ? new Date(dbState.lastUpdate as any).getTime() : NaN;
    const effectiveTsMs = Math.max(
      Number.isFinite(latestTsMs) ? latestTsMs : -Infinity,
      Number.isFinite(stateTsMs) ? stateTsMs : -Infinity,
    );
    const lastUpdateTs =
      Number.isFinite(effectiveTsMs) && effectiveTsMs > 0
        ? new Date(effectiveTsMs).toISOString()
        : null;
    const freshnessSec = lastUpdateTs
      ? Math.floor((Date.now() - new Date(lastUpdateTs).getTime()) / 1000)
      : null;
    const dataQualityVal = getDataQuality(freshnessSec);

    // ── Vehicle state inference ────────────────────────────────────────────
    // Rule 1: If DB state is "sleeping/offline/waking" but fresh telemetry just
    //         arrived, derive the real state from speed/power (REST poll returned
    //         actual driving/charging data the state machine hasn't processed yet).
    // Rule 2: If data is STALE or OFFLINE and state is "driving", demote it —
    //         a vehicle cannot be confirmed driving without fresh telemetry.
    //         "driving" for >120s without data ⟹ show as "parked" (STALE) or
    //         "offline" (OFFLINE) so the UI doesn't permanently show "Едет".
    const PASSIVE_STATES = new Set(['offline', 'Offline', 'sleeping', 'Sleeping', 'waking', 'Waking']);
    const ACTIVE_STATES  = new Set(['driving', 'Driving', 'charging', 'Charging']);
    const telemetryAgeSec = freshnessSec ?? Infinity;
    const telemetryFresh  = telemetryAgeSec < 180; // 3 minutes

    let vehicleState: string =
      PASSIVE_STATES.has(dbState?.state ?? '') && telemetryFresh
        ? this.resolveState(latest.speed, latest.power)
        : (dbState?.state ?? this.resolveState(latest.speed, latest.power));

    // Demote active states when we can't confirm them (data too old)
    if (ACTIVE_STATES.has(vehicleState) &&
        (dataQualityVal === 'STALE' || dataQualityVal === 'OFFLINE')) {
      vehicleState = dataQualityVal === 'OFFLINE' ? 'offline' : 'parked';
    }

    // Active charging session is ground-truth: if an open session exists in DB,
    // the car IS charging regardless of stale REST-poll data.
    // Override vehicleState + chargingState so the dashboard/insights see "Charging".
    if (activeChargingSession) {
      vehicleState = 'charging';
    }

    // ── Build result ───────────────────────────────────────────────────────
    // Speed and power are only meaningful when data is fresh enough.
    // Showing stale speed (e.g. 119 km/h) when the car is actually parked
    // is misleading — null them out so the UI renders '—'.
    const isDataFresh = dataQualityVal === 'REALTIME' || dataQualityVal === 'DELAYED';
    const chargingState =
      activeChargingSession
        ? 'Charging'
        : isDataFresh || dataQualityVal === 'STALE'
          ? (dbState?.chargingState ?? null)
          : null;

    const result = {
      vehicleId,
      soc: latest.soc ?? lastSocPoint?.soc ?? null,
      batteryRangeKm: (latest as any).batteryRangeKm ?? lastRangePoint?.[0]?.batteryRangeKm ?? null,
      speed:       isDataFresh ? (latest.speed ?? null)  : null,
      power:       isDataFresh ? (latest.power ?? null)  : null,
      batteryTemp: latest.batteryTemp ?? null,
      voltage:     (latest as any).voltage ?? lastPackVoltagePoint?.voltage ?? null,
      outsideTemp: latest.outsideTemp ?? lastOutsideTempPoint?.outsideTemp ?? null,
      insideTemp:  (latest as any).insideTemp ?? (lastInsideTempPoint as any)?.insideTemp ?? null,
      odometer:    latest.odometer ?? lastOdoPoint?.odometer ?? null,
      lastUpdate:  lastUpdateTs,
      vehicleState,
      chargingState,
      drivingState:  null,
      locked:        dbState?.locked ?? null,
      // Data freshness — frontend uses these to show quality-based UI
      isOnline:        freshnessSec !== null && freshnessSec < 30,
      dataFreshnessSec: freshnessSec,
      dataQuality:     dataQualityVal,
    };

    await this.cacheSet(cacheKey, JSON.stringify(result), 5);
    return result;
  }

  /**
   * Trips summary for "today".
   *
   * Accepts an optional `dayStart` ISO timestamp representing local midnight in the
   * user's timezone (e.g. "2026-03-25T21:00:00.000Z" for UTC+3).
   * Falls back to UTC midnight when omitted.
   *
   * Only counts COMPLETED trips (endTime != null).
   * Efficiency is weighted by distance and only uses trips with both distance AND energy.
   */
  async getTripsToday(vehicleId: string, dayStartIso?: string) {
    const startOfDay = dayStartIso ? new Date(dayStartIso) : (() => {
      const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d;
    })();
    const endOfDay = new Date(startOfDay.getTime() + 86_400_000);

    const cacheKey = `trips:today:${vehicleId}:${startOfDay.toISOString()}`;
    const cached = await this.cacheGet(cacheKey);
    if (cached) return JSON.parse(cached);

    const trips = await this.prisma.trip.findMany({
      where: {
        vehicleId,
        startTime: { gte: startOfDay, lt: endOfDay },
        endTime:   { not: null }, // only completed trips
      },
      select: {
        distanceKm:    true,
        energyUsedKwh: true,
      },
    });

    if (!trips.length) {
      const empty = { vehicleId, tripCount: 0, distanceKm: 0, energyKwh: 0, efficiencyWhKm: null };
      await this.cacheSet(cacheKey, JSON.stringify(empty), 60);
      return empty;
    }

    const totalDistance = trips.reduce((s, t) => s + (t.distanceKm ?? 0), 0);
    const totalEnergy   = trips.reduce((s, t) => s + (t.energyUsedKwh ?? 0), 0);

    // Efficiency: totalEnergy / totalDistance keeps the ratio consistent with
    // the two numbers displayed on the card (dividing them gives the same value)
    const efficiencyWhKm = totalDistance > 0 && totalEnergy > 0
      ? (totalEnergy * 1000) / totalDistance
      : null;

    const result = {
      vehicleId,
      tripCount:      trips.length,
      distanceKm:     totalDistance,
      energyKwh:      totalEnergy,
      efficiencyWhKm,
    };
    await this.cacheSet(cacheKey, JSON.stringify(result), 60);
    return result;
  }

  /**
   * Charging summary for last 30 days.
   */
  async getChargingSummary(vehicleId: string) {
    const cacheKey = `charging:summary:${vehicleId}`;
    const cached = await this.cacheGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const sessions = await this.prisma.chargingSession.findMany({
      where: {
        vehicleId,
        startTime: { gte: thirtyDaysAgo },
      },
      select: {
        energyAddedKwh: true,
      },
    });

    if (!sessions.length) {
      const empty = {
        vehicleId,
        sessions: 0,
        energyKwh: 0,
        avgSessionKwh: null,
      };
      await this.cacheSet(cacheKey, JSON.stringify(empty), 300);
      return empty;
    }

    const energy = sessions.reduce(
      (sum, s) => sum + (s.energyAddedKwh ?? 0),
      0,
    );

    const result = {
      vehicleId,
      sessions: sessions.length,
      energyKwh: energy,
      avgSessionKwh: energy / sessions.length,
    };
    await this.cacheSet(cacheKey, JSON.stringify(result), 300);
    return result;
  }

  /**
   * Cost analytics for last 30 days.
   * Wraps existing energy/charging stats with a simple cost model.
   */
  async getCostSummary(vehicleId: string, pricePerKwh = 0.25) {
    const cacheKey = `cost:summary:${vehicleId}:${pricePerKwh}`;
    const cached = await this.cacheGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [settings, sessions, distanceAgg] = await Promise.all([
      this.prisma.vehicleSettings.findUnique({
        where: { vehicleId },
        select: { chargingCost: true, homeChargingRate: true },
      }),
      this.prisma.chargingSession.findMany({
        where: {
          vehicleId,
          startTime: { gte: thirtyDaysAgo },
          endTime: { not: null },
        },
        select: {
          energyAddedKwh: true,
          cost:           true,
          costTotal:      true,   // actual persisted cost (from tariff or tesla_api)
          chargerType:    true,
        },
      }),
      this.prisma.trip.aggregate({
        where: {
          vehicleId,
          startTime: { gte: thirtyDaysAgo },
        },
        _sum: { distanceKm: true },
      }),
    ]);

    const homeRate =
      (settings?.homeChargingRate ?? 0) > 0 ? settings!.homeChargingRate! :
      (settings?.chargingCost    ?? 0) > 0 ? settings!.chargingCost!    :
      pricePerKwh;

    let energyKwh = 0;
    let totalCost = 0;

    for (const s of sessions) {
      const e = s.energyAddedKwh ?? 0;
      energyKwh += e;

      // Priority: costTotal (from tariff/tesla_api) > cost (legacy) > fallback formula
      const sessionCost = (s as any).costTotal ?? s.cost ?? null;
      if (sessionCost != null && sessionCost > 0) {
        totalCost += sessionCost;
      } else {
        const type = (s.chargerType ?? '').toLowerCase();
        const isHomeOrAc =
          type.includes('wall') ||
          type.includes('home') ||
          type.includes('ac') ||
          type.includes('slow');
        const effectiveRate = isHomeOrAc ? homeRate : pricePerKwh;
        totalCost += e * effectiveRate;
      }
    }

    const distanceKm = distanceAgg._sum.distanceKm ?? 0;

    const result = {
      vehicleId,
      period: { startDate: thirtyDaysAgo, endDate: new Date() },
      energyKwh,
      totalCost,
      costPerKm: distanceKm > 0 ? totalCost / distanceKm : null,
      sessions: sessions.length,
      pricePerKwh,
    };
    await this.cacheSet(cacheKey, JSON.stringify(result), 300);
    return result;
  }

  /**
   * Cost telemetry diagnostics for the dashboard.
   * Focuses on billing-source quality and retry pipeline health.
   */
  async getCostTelemetry(vehicleId: string) {
    const cacheKey = `cost:telemetry:${vehicleId}`;
    const cached = await this.cacheGet(cacheKey);
    if (cached) return JSON.parse(cached);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const now = new Date();
    const sessions = await this.prisma.chargingSession.findMany({
      where: {
        vehicleId,
        endTime: { not: null, gte: thirtyDaysAgo },
      },
      select: {
        costSource: true,
        costTotal: true,
        billingSyncAttempts: true,
        billingNextSyncAt: true,
      },
    });

    const totalSessions = sessions.length;
    const teslaApiSessions = sessions.filter(s => s.costSource === 'tesla_api').length;
    const scopeMissingSessions = sessions.filter(s => s.costSource === 'scope_missing').length;
    const manualSessions = sessions.filter(s => s.costSource === 'manual').length;

    const fallbackSessions = sessions.filter((s) =>
      s.costSource !== 'tesla_api' &&
      s.costSource !== 'scope_missing' &&
      s.costSource !== 'manual',
    ).length;

    const pendingRetry = sessions.filter((s) =>
      s.billingNextSyncAt != null &&
      s.billingNextSyncAt > now &&
      s.costSource !== 'tesla_api' &&
      s.costSource !== 'scope_missing',
    );

    const pendingRetrySessions = pendingRetry.length;
    const retryAttempts = pendingRetry.map((s) => s.billingSyncAttempts ?? 0);
    const avgRetryAttempts = retryAttempts.length
      ? retryAttempts.reduce((a, b) => a + b, 0) / retryAttempts.length
      : 0;
    const maxRetryAttempts = retryAttempts.length ? Math.max(...retryAttempts) : 0;
    const fallbackCostTotal = sessions
      .filter((s) => s.costSource !== 'tesla_api')
      .reduce((sum, s) => sum + (s.costTotal ?? 0), 0);

    const result = {
      vehicleId,
      period: { startDate: thirtyDaysAgo, endDate: now },
      totalSessions,
      teslaApiSessions,
      fallbackSessions,
      scopeMissingSessions,
      manualSessions,
      teslaCoveragePct: totalSessions > 0 ? (teslaApiSessions / totalSessions) * 100 : 0,
      pendingRetrySessions,
      avgRetryAttempts,
      maxRetryAttempts,
      fallbackCostTotal,
    };

    await this.cacheSet(cacheKey, JSON.stringify(result), 60);
    return result;
  }

  /**
   * Aggregated dashboard payload — one round-trip instead of four.
   */
  async getDashboardSummary(vehicleId: string, pricePerKwh = 0.25) {
    const [status, tripsToday, chargingSummary, costSummary] = await Promise.all([
      this.getVehicleStatus(vehicleId),
      this.getTripsToday(vehicleId),
      this.getChargingSummary(vehicleId),
      this.getCostSummary(vehicleId, pricePerKwh),
    ]);
    return { status, tripsToday, chargingSummary, costSummary };
  }

  /**
   * Full dashboard context — includes battery health + vampire drain.
   * Used by the AI engine and the aggregated /dashboard/full endpoint.
   */
  async getFullContext(vehicleId: string, pricePerKwh = 0.25) {
    const [status, tripsToday, chargingSummary, costSummary, batteryHealth, vampireDrain] =
      await Promise.all([
        this.getVehicleStatus(vehicleId),
        this.getTripsToday(vehicleId),
        this.getChargingSummary(vehicleId),
        this.getCostSummary(vehicleId, pricePerKwh),
        this.batteryAnalytics?.getBatteryHealth(vehicleId).catch(() => null) ?? Promise.resolve(null),
        this.vampireDrain?.getStats(vehicleId, 30).catch(() => null) ?? Promise.resolve(null),
      ]);

    return { status, tripsToday, chargingSummary, costSummary, batteryHealth, vampireDrain };
  }

  private resolveState(speed?: number | null, power?: number | null): string {
    // Use 2 km/h threshold (not 0) to filter GPS drift noise that produces tiny
    // non-zero speed values when the car is stationary.
    if (speed != null && speed > 2) return 'Driving';
    if (power != null && power > 1) return 'Charging';
    return 'Parked';
  }
}

