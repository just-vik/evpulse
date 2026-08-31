import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { isWorkerRole } from '../runtime/runtime-role';

/**
 * VampireDrainService — detects battery drain during parked periods.
 *
 * Algorithm: gap-based detection.
 *
 * Tesla stops sending telemetry when the car sleeps — so the sleep gap IS the
 * vampire drain period. We detect it by finding consecutive telemetry points
 * where:
 *   - Both points are parked (speed ≤ 5 km/h) and not charging
 *   - The gap between them is ≥ MIN_GAP_MINUTES
 *   - SOC at end ≤ SOC at start (drain occurred or stayed flat)
 *
 * This approach correctly handles sparse telemetry from sleeping cars.
 *
 * Cron: runs every 6 hours. Scans last 8 days to backfill any missed gaps.
 * Upsert by (vehicleId, date): one record per vehicle per calendar day (the
 * gap with the largest SOC loss wins; ties broken by duration).
 */
@Injectable()
export class VampireDrainService {
  private readonly logger = new Logger(VampireDrainService.name);

  private readonly ALERT_DRAIN_PCT = 8.0;
  /** Minimum gap to consider a sleep interval (minutes) */
  private readonly MIN_GAP_MINUTES = 30;
  /** Minimum gap duration to record (hours) */
  private readonly MIN_DURATION_HRS = 0.5;
  /** How many days back to scan on every cron run */
  private readonly SCAN_DAYS = 8;

  private readonly CHARGING_STATES = new Set([
    'Charging', 'Complete', 'Starting', 'ChargeStateCharging',
    'ChargeStateComplete', 'ChargeStateStarting',
  ]);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Cron: every 6 hours ──────────────────────────────────────────────────

  @Cron('0 0,6,12,18 * * *')
  async detectDrain() {
    if (!isWorkerRole()) return;
    this.logger.log('VampireDrain: starting scan');
    const vehicles = await this.prisma.vehicle.findMany({
      where: { status: 'active' },
      select: { id: true },
    });
    for (const v of vehicles) {
      try {
        const tz = await this.getVehicleTimezone(v.id);
        await this.analyzeVehicle(v.id, this.SCAN_DAYS, tz);
      } catch (e: any) {
        this.logger.warn(`VampireDrain: vehicle ${v.id} error: ${e.message}`);
      }
    }
  }

  // ─── Core analysis ────────────────────────────────────────────────────────

  async analyzeVehicle(vehicleId: string, days = 8, tz = 'UTC'): Promise<number> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const points = await this.prisma.telemetryPoint.findMany({
      where: {
        vehicleId,
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'asc' },
      select: { soc: true, timestamp: true, speed: true, chargingState: true, power: true },
    });

    if (points.length < 2) return 0;

    // Find sleep gaps: consecutive parked+not-charging pairs with gap ≥ MIN_GAP
    const minGapMs = this.MIN_GAP_MINUTES * 60_000;
    type Gap = {
      sleepAt: Date; wakeAt: Date; durationHrs: number;
      socAtSleep: number; socAtWake: number; socLost: number;
      drainPerHr: number; date: Date;
    };

    const gaps: Gap[] = [];

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];

      const gapMs = curr.timestamp.getTime() - prev.timestamp.getTime();
      if (gapMs < minGapMs) continue;

      const prevParked = (prev.speed ?? 0) <= 5 && !this.CHARGING_STATES.has(prev.chargingState ?? '');
      const currParked = (curr.speed ?? 0) <= 5 && !this.CHARGING_STATES.has(curr.chargingState ?? '');
      if (!prevParked || !currParked) continue;

      // Exclude gaps where cabin climate was likely active (HVAC, pre-conditioning,
      // cabin overheat protection).  climate_state fields are not stored in
      // telemetry_points, so power > 2 kW while parked + not charging is a reliable
      // proxy — HVAC draws 2–5 kW, vampire drain is typically < 1 kW.
      const prevClimate = (prev.power ?? 0) > 2;
      const currClimate = (curr.power ?? 0) > 2;
      if (prevClimate || currClimate) continue;

      if (prev.soc == null || curr.soc == null) continue;

      // SOC could stay the same (0% drain = healthy) — record it too
      // Skip only if SOC increased (charging happened in the gap without telemetry)
      const socLost = prev.soc - curr.soc;
      if (socLost < 0) continue; // SOC went up — charging in the gap

      const durationHrs = gapMs / 3_600_000;
      if (durationHrs < this.MIN_DURATION_HRS) continue;

      const drainPerHr = durationHrs > 0 ? socLost / durationHrs : 0;

      // Assign to the local calendar day of sleep start (timezone-aware).
      // en-CA locale formats as YYYY-MM-DD which Date() parses as UTC midnight.
      const localDateStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(prev.timestamp);
      const date = new Date(localDateStr + 'T00:00:00Z');

      gaps.push({
        sleepAt: prev.timestamp,
        wakeAt: curr.timestamp,
        durationHrs,
        socAtSleep: prev.soc,
        socAtWake: curr.soc,
        socLost,
        drainPerHr,
        date,
      });
    }

    if (gaps.length === 0) return 0;

    // Group by day — keep the gap with the most SOC lost (ties: longest duration)
    const byDay = new Map<string, Gap>();
    for (const gap of gaps) {
      const key = gap.date.toISOString().slice(0, 10);
      const existing = byDay.get(key);
      if (
        !existing ||
        gap.socLost > existing.socLost ||
        (gap.socLost === existing.socLost && gap.durationHrs > existing.durationHrs)
      ) {
        byDay.set(key, gap);
      }
    }

    let recorded = 0;
    for (const [, gap] of byDay) {
      await this.prisma.vampireDrainLog.upsert({
        where: { vehicleId_date: { vehicleId, date: gap.date } },
        update: {
          startSoc: gap.socAtSleep,
          endSoc: gap.socAtWake,
          drainPct: gap.socLost,
          durationHrs: gap.durationHrs,
          drainPerHr: gap.drainPerHr,
          checkedAt: new Date(),
        },
        create: {
          vehicleId,
          date: gap.date,
          startSoc: gap.socAtSleep,
          endSoc: gap.socAtWake,
          drainPct: gap.socLost,
          durationHrs: gap.durationHrs,
          drainPerHr: gap.drainPerHr,
          parkedAt: gap.sleepAt,
          checkedAt: new Date(),
        },
      });

      this.logger.debug(
        `VampireDrain ${vehicleId} ${gap.date.toISOString().slice(0, 10)}: ` +
          `${gap.socLost.toFixed(1)}% in ${gap.durationHrs.toFixed(1)}h ` +
          `= ${gap.drainPerHr.toFixed(3)}%/h`,
      );

      if (gap.socLost >= this.ALERT_DRAIN_PCT) {
        await this.notifyHighDrain(vehicleId, gap.socLost, gap.durationHrs);
      }

      recorded++;
    }

    if (recorded > 0) {
      this.logger.log(`VampireDrain: recorded ${recorded} day(s) for ${vehicleId}`);
    }

    return recorded;
  }

  private async notifyHighDrain(
    vehicleId: string,
    drainPct: number,
    hours: number,
  ): Promise<void> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { userId: true },
    });
    if (!vehicle) return;

    // Avoid duplicate notifications: check if we already sent one for this drain event
    const existing = await this.prisma.notification.findFirst({
      where: {
        vehicleId,
        type: 'vampire_drain',
        createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
      },
    });
    if (existing) return;

    await this.prisma.notification.create({
      data: {
        userId: vehicle.userId,
        vehicleId,
        type: 'vampire_drain',
        title: `Разряд в покое — ${drainPct.toFixed(1)}%`,
        message: `Аккумулятор потерял ${drainPct.toFixed(1)}% за ${hours.toFixed(0)}ч в режиме парковки.`,
        body: `Аккумулятор потерял ${drainPct.toFixed(1)}% за ${hours.toFixed(0)}ч в режиме парковки.`,
        channels: ['in_app'],
        status: 'unread',
        read: false,
      },
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Returns the IANA timezone for the vehicle (from VehicleSettings), or 'UTC'. */
  private async getVehicleTimezone(vehicleId: string): Promise<string> {
    const settings = await this.prisma.vehicleSettings.findUnique({
      where: { vehicleId },
      select: { timezone: true },
    });
    return settings?.timezone ?? 'UTC';
  }

  /**
   * Classify a parking start timestamp into a period using the vehicle's local timezone.
   * Uses Intl.DateTimeFormat so DST transitions are handled automatically.
   *
   * Night:       22:00–06:00 local — sleep period
   * Parked-work: 06:00–17:00 local weekdays — office parking
   * Day:         all other slots
   */
  private classifyPeriod(d: Date, tz: string): 'night' | 'parked_work' | 'day' {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      weekday: 'short',
      hour12: false,
    }).formatToParts(d);

    const h  = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10) % 24;
    const wd = parts.find(p => p.type === 'weekday')?.value ?? '';
    const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd);

    if (h >= 22 || h < 6)              return 'night';
    if (isWeekday && h >= 6 && h < 17) return 'parked_work';
    return 'day';
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async getStats(vehicleId: string, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [logs, vehicle, tz] = await Promise.all([
      this.prisma.vampireDrainLog.findMany({
        where: { vehicleId, date: { gte: since } },
        orderBy: { date: 'desc' },
      }),
      this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: { batteryCapacityUsable: true },
      }),
      this.getVehicleTimezone(vehicleId),
    ]);

    if (!logs.length) {
      return {
        avgPerHr: 0, avgDrainPct: 0, avgDurationHrs: 0,
        maxDrain: 0, logs: [], avgIdlePowerKw: null,
        nightAvgPerHr: null, dayAvgPerHr: null,
      };
    }

    // Weighted average by duration (not a simple mean — a 1-hour gap is less
    // representative than a 10-hour overnight gap)
    const totalHrs = logs.reduce((s, l) => s + l.durationHrs, 0);
    const weightedRate = totalHrs > 0
      ? logs.reduce((s, l) => s + l.drainPerHr * l.durationHrs, 0) / totalHrs
      : 0;

    // Power derived from drain rate × battery capacity — avoids the survivorship
    // bias of averaging telemetry-point power (Tesla only sends data while awake)
    const batteryKwh = vehicle?.batteryCapacityUsable ?? 72;
    const avgIdlePowerKw = weightedRate > 0
      ? +(weightedRate / 100 * batteryKwh).toFixed(3)
      : null;

    const avgDrainPct = logs.reduce((s, l) => s + l.drainPct, 0) / logs.length;
    const avgDurationHrs = totalHrs / logs.length;
    const maxDrain = Math.max(...logs.map(l => l.drainPct));

    const nightLogs       = logs.filter(l => this.classifyPeriod(l.parkedAt, tz) === 'night');
    const parkedWorkLogs  = logs.filter(l => this.classifyPeriod(l.parkedAt, tz) === 'parked_work');
    const dayLogs         = logs.filter(l => this.classifyPeriod(l.parkedAt, tz) === 'day');

    const weightedAvgPerHr = (subset: typeof logs): number | null => {
      if (!subset.length) return null;
      const hrs = subset.reduce((s, l) => s + l.durationHrs, 0);
      return hrs > 0
        ? +(subset.reduce((s, l) => s + l.drainPerHr * l.durationHrs, 0) / hrs).toFixed(3)
        : null;
    };

    return {
      avgPerHr:           +weightedRate.toFixed(3),
      avgDrainPct:        +avgDrainPct.toFixed(1),
      avgDurationHrs:     +avgDurationHrs.toFixed(1),
      maxDrain:           +maxDrain.toFixed(1),
      nightAvgPerHr:      weightedAvgPerHr(nightLogs),
      parkedWorkAvgPerHr: weightedAvgPerHr(parkedWorkLogs),
      dayAvgPerHr:        weightedAvgPerHr(dayLogs),
      logs,
      avgIdlePowerKw,
    };
  }

  /** Backfill: recompute from historical telemetry (up to N days). */
  async runBackfill(vehicleId: string, days = 60): Promise<{ recorded: number }> {
    this.logger.log(`VampireDrain: backfill ${days}d for ${vehicleId}`);
    const tz = await this.getVehicleTimezone(vehicleId);
    const recorded = await this.analyzeVehicle(vehicleId, days, tz);
    return { recorded };
  }

  /** Manual trigger for all active vehicles (admin use). */
  async runNow(): Promise<{ processed: number }> {
    this.logger.log('VampireDrain: manual trigger');
    const vehicles = await this.prisma.vehicle.findMany({
      where: { status: 'active' },
      select: { id: true },
    });
    let processed = 0;
    for (const v of vehicles) {
      try {
        const tz = await this.getVehicleTimezone(v.id);
        await this.analyzeVehicle(v.id, this.SCAN_DAYS, tz);
        processed++;
      } catch (e: any) {
        this.logger.warn(`VampireDrain.runNow ${v.id}: ${e.message}`);
      }
    }
    return { processed };
  }
}
