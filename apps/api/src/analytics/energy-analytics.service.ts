import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { isWorkerRole } from '../runtime/runtime-role';

/**
 * EnergyAnalyticsService - Energy consumption and efficiency tracking
 */
@Injectable()
export class EnergyAnalyticsService {
  private readonly logger = new Logger(EnergyAnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Calculate or update daily energy stats.
   * Includes regen energy aggregated from trip_stats.regenEnergyKwh.
   */
  async updateDailyEnergy(vehicleId: string, date: Date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const [trips, chargingSessions, regenAgg] = await Promise.all([
      this.prisma.trip.findMany({
        where: { vehicleId, startTime: { gte: startOfDay, lte: endOfDay }, endTime: { not: null } },
      }),
      this.prisma.chargingSession.findMany({
        where: { vehicleId, startTime: { gte: startOfDay, lte: endOfDay }, endTime: { not: null } },
      }),
      // Aggregate regen from trip_stats for trips that started this day
      this.prisma.tripStats.aggregate({
        where: { trip: { vehicleId, startTime: { gte: startOfDay, lte: endOfDay }, endTime: { not: null } } },
        _sum: { regenEnergyKwh: true },
      }),
    ]);

    const totalDistance    = trips.reduce((s, t) => s + (t.distanceKm || 0), 0);
    const totalEnergyUsed  = trips.reduce((s, t) => s + (t.energyUsedKwh || 0), 0);
    const totalEnergyAdded = chargingSessions.reduce((s, c) => s + (c.energyAddedKwh || 0), 0);
    const totalRegenKwh    = Math.round((regenAgg._sum.regenEnergyKwh ?? 0) * 1000) / 1000;
    const efficiency       = totalDistance > 0 ? (totalEnergyUsed * 1000) / totalDistance : null;

    return this.prisma.dailyEnergy.upsert({
      where: { vehicleId_date: { vehicleId, date: startOfDay } },
      update: {
        distanceKm:    totalDistance,
        energyUsedKwh: totalEnergyUsed,
        energyAddedKwh: totalEnergyAdded,
        regenEnergyKwh: totalRegenKwh,
        efficiencyWhkm: efficiency ? Math.round(efficiency) : null,
      },
      create: {
        vehicleId,
        date:           startOfDay,
        distanceKm:    totalDistance,
        energyUsedKwh: totalEnergyUsed,
        energyAddedKwh: totalEnergyAdded,
        regenEnergyKwh: totalRegenKwh,
        efficiencyWhkm: efficiency ? Math.round(efficiency) : null,
      },
    });
  }

  /**
   * Calculate or update monthly energy stats.
   * Includes regen energy aggregated from trip_stats.regenEnergyKwh.
   */
  async updateMonthlyEnergy(vehicleId: string, date: Date) {
    const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    const endOfMonth   = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);

    const [trips, chargingSessions, regenAgg] = await Promise.all([
      this.prisma.trip.findMany({
        where: { vehicleId, startTime: { gte: startOfMonth, lte: endOfMonth }, endTime: { not: null } },
      }),
      this.prisma.chargingSession.findMany({
        where: { vehicleId, startTime: { gte: startOfMonth, lte: endOfMonth }, endTime: { not: null } },
      }),
      this.prisma.tripStats.aggregate({
        where: { trip: { vehicleId, startTime: { gte: startOfMonth, lte: endOfMonth }, endTime: { not: null } } },
        _sum: { regenEnergyKwh: true },
      }),
    ]);

    const totalDistance    = trips.reduce((s, t) => s + (t.distanceKm || 0), 0);
    const totalEnergyUsed  = trips.reduce((s, t) => s + (t.energyUsedKwh || 0), 0);
    const totalEnergyAdded = chargingSessions.reduce((s, c) => s + (c.energyAddedKwh || 0), 0);
    const totalRegenKwh    = Math.round((regenAgg._sum.regenEnergyKwh ?? 0) * 1000) / 1000;
    const efficiency       = totalDistance > 0 ? (totalEnergyUsed * 1000) / totalDistance : null;

    return this.prisma.monthlyEnergy.upsert({
      where: { vehicleId_month: { vehicleId, month: startOfMonth } },
      update: {
        distanceKm:    totalDistance,
        energyUsedKwh: totalEnergyUsed,
        energyAddedKwh: totalEnergyAdded,
        regenEnergyKwh: totalRegenKwh,
        efficiencyWhkm: efficiency ? Math.round(efficiency) : null,
      },
      create: {
        vehicleId,
        month:          startOfMonth,
        distanceKm:    totalDistance,
        energyUsedKwh: totalEnergyUsed,
        energyAddedKwh: totalEnergyAdded,
        regenEnergyKwh: totalRegenKwh,
        efficiencyWhkm: efficiency ? Math.round(efficiency) : null,
      },
    });
  }

  // ── Monthly backfill cron ──────────────────────────────────────────────────

  /**
   * Daily at 02:00 UTC: ensure every past month with daily_energy records has
   * an up-to-date monthly_energy row.  Idempotent — upsert overwrites stale data.
   * Covers up to 24 months of history to catch late-arriving charging sessions.
   */
  @Cron('0 2 * * *')
  async scheduledMonthlyEnergyBackfill(): Promise<void> {
    if (!isWorkerRole()) return;

    const vehicles = await this.prisma.vehicle.findMany({
      where: { status: 'active' },
      select: { id: true },
    });
    if (!vehicles.length) return;

    this.logger.log(`[Cron] Monthly energy backfill for ${vehicles.length} vehicle(s)`);
    for (const v of vehicles) {
      await this._backfillMonthlyEnergyForVehicle(v.id).catch((e: Error) =>
        this.logger.warn(`[Energy] Monthly backfill skipped for ${v.id}: ${e.message}`),
      );
    }
  }

  /**
   * Backfill monthly energy aggregates for a single vehicle.
   * Finds all distinct months with daily_energy data (up to 24 months back)
   * and upserts a monthly_energy row for each.
   */
  async backfillMonthlyEnergyForVehicle(vehicleId: string): Promise<{ months: number }> {
    return this._backfillMonthlyEnergyForVehicle(vehicleId);
  }

  private async _backfillMonthlyEnergyForVehicle(vehicleId: string): Promise<{ months: number }> {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 24);

    const rows = await this.prisma.$queryRaw<Array<{ month: Date }>>`
      SELECT DISTINCT DATE_TRUNC('month', date) AS month
      FROM "daily_energy"
      WHERE "vehicleId" = ${vehicleId}
        AND date >= ${cutoff}
      ORDER BY month DESC
    `;

    if (!rows.length) return { months: 0 };

    for (const { month } of rows) {
      await this.updateMonthlyEnergy(vehicleId, month).catch((e: Error) =>
        this.logger.warn(`[Energy] updateMonthlyEnergy failed ${vehicleId} ${month.toISOString().slice(0, 7)}: ${e.message}`),
      );
    }

    this.logger.log(`[Energy] Backfilled ${rows.length} month(s) for ${vehicleId}`);
    return { months: rows.length };
  }

  /**
   * Get energy history for dashboard.
   *
   * Regen is now stored in daily_energy.regenEnergyKwh — no JOIN needed.
   * Summary includes regenRatioPct = recovered / gross consumption.
   * Neither Tessie nor TezLab expose regen as a daily KPI.
   */
  async getEnergyHistory(vehicleId: string, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const endDate = new Date();

    const dailyStats = await this.prisma.dailyEnergy.findMany({
      where: { vehicleId, date: { gte: startDate } },
      orderBy: { date: 'asc' },
    });

    const totalDistance    = dailyStats.reduce((s, d) => s + d.distanceKm, 0);
    const totalEnergyUsed  = dailyStats.reduce((s, d) => s + d.energyUsedKwh, 0);
    const totalEnergyAdded = dailyStats.reduce((s, d) => s + d.energyAddedKwh, 0);
    const totalRegenKwh    = dailyStats.reduce((s, d) => s + ((d as any).regenEnergyKwh ?? 0), 0);

    const daysWithUsage     = dailyStats.length || 1;
    const efficiencySamples = dailyStats.filter(d => d.efficiencyWhkm !== null);
    const avgEfficiency     = efficiencySamples.length > 0
      ? efficiencySamples.reduce((s, d) => s + (d.efficiencyWhkm ?? 0), 0) / efficiencySamples.length
      : null;

    const grossEnergyKwh = totalEnergyUsed + totalRegenKwh;
    const regenRatioPct  = grossEnergyKwh > 0
      ? Math.round((totalRegenKwh / grossEnergyKwh) * 1000) / 10
      : null;

    return {
      vehicleId,
      period: { startDate, endDate, days },
      dailyStats,
      summary: {
        totalDistance,
        totalEnergyUsed,
        totalEnergyAdded,
        totalRegenKwh:       Math.round(totalRegenKwh * 100) / 100,
        regenRatioPct,
        averageEnergyPerDay: totalEnergyUsed / daysWithUsage,
        averageEfficiency:   avgEfficiency,
      },
    };
  }

  /**
   * Calculate cost estimates based on energy usage
   */
  async getChargingCosts(vehicleId: string, electricityRate = 0.13) {
    // USD per kWh
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const chargingSessions = await this.prisma.chargingSession.findMany({
      where: {
        vehicleId,
        startTime: { gte: thirtyDaysAgo },
        endTime: { not: null },
      },
    });

    const energyAdded = chargingSessions.reduce(
      (sum, s) => sum + (s.energyAddedKwh || 0),
      0,
    );
    const totalCost = energyAdded * electricityRate;

    // Get visits by charger type
    const chargerBreakdown: { [key: string]: { count: number; energy: number } } = {};

    chargingSessions.forEach((session) => {
      const chargerType = session.chargerType || 'unknown';
      if (!chargerBreakdown[chargerType]) {
        chargerBreakdown[chargerType] = { count: 0, energy: 0 };
      }
      chargerBreakdown[chargerType].count++;
      chargerBreakdown[chargerType].energy += session.energyAddedKwh || 0;
    });

    return {
      vehicleId,
      period: { startDate: thirtyDaysAgo, endDate: new Date() },
      electricityRate,
      totalEnergyAdded: Math.round(energyAdded * 100) / 100,
      estimatedCost: Math.round(totalCost * 100) / 100,
      costPerKwh: electricityRate,
      chargerBreakdown,
      sessions: chargingSessions.length,
    };
  }
}
