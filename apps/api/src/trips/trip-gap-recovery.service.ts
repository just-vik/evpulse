import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodingService } from '../geocoding/geocoding.service';
import { isWorkerRole } from '../runtime/runtime-role';
import { TariffResolverService } from '../charging/tariff-resolver.service';

/**
 * TripGapRecoveryService
 *
 * Detects trips that were completely missed because the car was "sleeping"
 * (no telemetry streaming) and REST polling happened too infrequently.
 *
 * Strategy: scan consecutive parked telemetry pairs where:
 *   - Both points show speed = 0
 *   - Odometer delta >= 0.5 km (real movement happened in the gap)
 *   - GPS location changed significantly (>= 0.3 km)
 *   - Time gap <= 4 hours (longer gaps → car may have been on a trailer/ferry)
 *   - No existing trip already covers that time window
 *
 * Creates an estimated trip marked reliability='LOW', repair_reason='gap_recovery'.
 * These are clearly labeled in the UI as "estimated from odometer".
 */
@Injectable()
export class TripGapRecoveryService {
  private readonly logger = new Logger(TripGapRecoveryService.name);
  private isRunning = false; // prevents cron overlap if a run takes longer than 15 min

  // Minimum odometer delta to create a recovered trip
  private readonly MIN_DISTANCE_KM = 0.5;
  // Maximum gap to recover (longer = likely parked intentionally far)
  private readonly MAX_GAP_MS = 4 * 60 * 60_000;
  // Minimum GPS displacement to confirm movement (not just GPS drift)
  private readonly MIN_GPS_DISPLACEMENT_KM = 0.3;
  // SOC-up filter: if SOC increases over the candidate gap, it is likely charging noise.
  private readonly MAX_SOC_UP_PCT = 0.5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocoding: GeocodingService,
    private readonly tariffResolver?: TariffResolverService,
  ) {}

  // Auto-recovery is now scheduled by SystemMaintenanceCronService (every 15 min).
  async autoRecover(): Promise<void> {
    if (!isWorkerRole()) return;
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const since = new Date(Date.now() - 6 * 60 * 60_000);
      const { recovered } = await this._recover({ since });
      if (recovered > 0) {
        this.logger.log(`[GapRecovery] Auto-recovered ${recovered} missing trip(s)`);
      }
    } finally {
      this.isRunning = false;
    }
  }

  /** Manual trigger — looks back up to `days` days */
  async runManual(vehicleId?: string, days = 3): Promise<{ recovered: number }> {
    const since = new Date(Date.now() - days * 86_400_000);
    return this._recover({ vehicleId, since });
  }

  // ───────────────────────────────────────────────────────────────────────────

  private async _recover(opts: {
    vehicleId?: string;
    since: Date;
  }): Promise<{ recovered: number }> {
    // Extend lookback by MAX_GAP_MS so that point `a` (the pre-trip parked point)
    // can be found even when the car was parked overnight and `a` is older than `since`.
    // Without this extension, pairs where `a` is just outside the window are silently missed.
    const extendedSince = new Date(opts.since.getTime() - this.MAX_GAP_MS);
    // Fetch consecutive parked telemetry pairs in the window
    const points = await this.prisma.telemetryPoint.findMany({
      where: {
        ...(opts.vehicleId ? { vehicleId: opts.vehicleId } : {}),
        timestamp: { gte: extendedSince },
        speed: { lte: 2 },          // parked / very slow
        odometer: { not: null },
      },
      orderBy: [{ vehicleId: 'asc' }, { timestamp: 'asc' }],
      select: {
        vehicleId: true,
        timestamp:  true,
        latitude:   true,
        longitude:  true,
        soc:        true,
        odometer:   true,
      },
    });

    // Get battery capacities for all affected vehicles
    const vehicleIds = [...new Set(points.map(p => p.vehicleId))];
    const vehicles = await Promise.all(
      vehicleIds.map(id =>
        this.prisma.vehicle.findUnique({
          where: { id },
          include: { vehicleSpec: true },
        }),
      ),
    );
    const capacityByVehicle = new Map<string, number>();
    for (const v of vehicles) {
      if (!v) continue;
      const kwh =
        (v as any).batteryCapacityDetected ??
        v.vehicleSpec?.batteryUsableKwh ??
        75;
      capacityByVehicle.set(v.id, kwh);
    }

    let recovered = 0;

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];

      if (a.vehicleId !== b.vehicleId) continue;

      // Only process pairs where point b (arrival after trip) is within the original
      // since window. Point a may be older (extended lookback for overnight parking).
      if (b.timestamp < opts.since) continue;

      const gapMs = b.timestamp.getTime() - a.timestamp.getTime();
      if (gapMs <= 0 || gapMs > this.MAX_GAP_MS) continue;

      // Check odometer delta
      if (a.odometer == null || b.odometer == null) continue;
      const odoDistKm = b.odometer - a.odometer;
      if (odoDistKm < this.MIN_DISTANCE_KM) continue;

      // Check GPS displacement (avoid creating trips for odometer noise)
      if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) continue;
      const gpsDisplacement = haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
      if (gpsDisplacement < this.MIN_GPS_DISPLACEMENT_KM) continue;

      // Hard filter for SOC-up anomalies inside candidate "trip":
      // if SOC rises across the gap, this is charging transition/noise, not a drive trip.
      if (a.soc != null && b.soc != null && (b.soc - a.soc) > this.MAX_SOC_UP_PCT) {
        continue;
      }

      // Ensure no existing trip already covers this window.
      // IMPORTANT: also exclude in-progress trips (endTime = null).
      // In SQL, NULL > timestamp is always false, so the plain { gt: a.timestamp }
      // check would silently miss a trip that the TripDetector is currently building.
      // This caused GapRecovery to create trips for parked-point pairs that are
      // actually inside an active trip (e.g. traffic-light stops mid-journey).
      const existing = await this.prisma.trip.findFirst({
        where: {
          vehicleId: a.vehicleId,
          startTime: { lte: b.timestamp }, // start at or before gap-end
          OR: [
            { endTime: null },               // in-progress trip — always skip
            { endTime: { gte: a.timestamp } }, // completed trip overlapping this window
          ],
        },
      });
      if (existing) continue;

      // Ensure no charging session overlaps this window.
      // A gap that includes charging is not a missed trip — it is a drive-to-charger
      // segment followed by a charging session. Creating a trip spanning both would
      // produce a corrupted record with SoC going UP during the "trip".
      const overlappingSession = await this.prisma.chargingSession.findFirst({
        where: {
          vehicleId: a.vehicleId,
          startTime: { lt: b.timestamp },
          endTime:   { gt: a.timestamp },
        },
      });
      if (overlappingSession) continue;

      // Calculate energy from SOC delta
      const usableKwh = capacityByVehicle.get(a.vehicleId) ?? 75;
      const socDrop = (a.soc ?? 0) - (b.soc ?? a.soc ?? 0);
      const energyUsedKwh = socDrop > 1
        ? Math.round((socDrop / 100) * usableKwh * 100) / 100
        : null;
      const efficiencyWhkm = energyUsedKwh != null && odoDistKm > 0
        ? Math.round((energyUsedKwh * 1000 / odoDistKm) * 10) / 10
        : null;

      // Cost -- delegated to TariffResolverService (purpose: 'actual_cost'), same
      // treatment as TripDetectorService's trip-finalize cost block: this is the
      // cost of energy consumed while driving, not a charging session, so no
      // chargerType/location is passed (none exists here either). Two accepted
      // divergences from the pre-migration literal logic (see
      // tariff-current-behavior-trip-paths.spec.ts): a homeChargingRate of
      // exactly 0 is now treated as unconfigured (falls through to the default
      // tier) instead of being used as-is, and the fallback-when-unset literal
      // changes from the old hardcoded 0.35 to the shared canonicalDefaultRate
      // (also 0.35 today, so currently a no-op numerically).
      let costTotal: number | null = null;
      if (energyUsedKwh != null) {
        if (!this.tariffResolver) {
          throw new Error(`TripGapRecoveryService: TariffResolverService not available (vehicle ${a.vehicleId})`);
        }
        const resolution = await this.tariffResolver.resolve({ purpose: 'actual_cost', vehicleId: a.vehicleId });
        costTotal = Math.round(energyUsedKwh * resolution.rate * 100) / 100;
      }

      // Create recovered trip
      const trip = await this.prisma.trip.create({
        data: {
          vehicleId:      a.vehicleId,
          startTime:      a.timestamp,
          endTime:        b.timestamp,
          startSoc:       a.soc ?? 0,
          endSoc:         b.soc ?? null,
          startLat:       a.latitude,
          startLon:       a.longitude,
          endLat:         b.latitude,
          endLon:         b.longitude,
          distanceKm:     Math.round(odoDistKm * 10) / 10,
          energyUsedKwh,
          efficiencyWhkm: efficiencyWhkm != null && efficiencyWhkm <= 600 ? efficiencyWhkm : null,
          costTotal,
          qualityScore:   30,  // low — no GPS track
          drivingScore:   null,
          reliability:    'LOW',
          repairReason:   'gap_recovery',
        } as any,
      });

      // Reverse-geocode start/end asynchronously
      this.geocoding.reverseShort(a.latitude!, a.longitude!)
        .then(addr => addr
          ? this.prisma.trip.update({ where: { id: trip.id }, data: { startLocation: addr } })
          : null,
        )
        .catch(() => null);

      this.geocoding.reverseShort(b.latitude!, b.longitude!)
        .then(addr => addr
          ? this.prisma.trip.update({ where: { id: trip.id }, data: { endLocation: addr } })
          : null,
        )
        .catch(() => null);

      this.logger.log(
        `[GapRecovery] Created estimated trip ${trip.id}: ` +
        `${a.vehicleId} gap ${Math.round(gapMs / 60000)}min, ` +
        `odo ${odoDistKm.toFixed(1)}km, SOC ${a.soc}→${b.soc}`,
      );

      recovered++;
    }

    return { recovered };
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
