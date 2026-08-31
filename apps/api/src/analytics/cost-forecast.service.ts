import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CostForecastService
 *
 * Тариф (иерархия):
 *   1. Эффективная цена из сессий зарядки: SUM(costTotal)/SUM(energyAddedKwh)
 *      — только если costTotal заполнен в ≥3 сессиях (иначе нет доверия к данным)
 *   2. homeChargingRate из VehicleSettings
 *   3. Дефолт 0.25 €/kWh
 *
 * Данные об энергии (иерархия):
 *   1. daily_energy (если есть записи за период)
 *   2. Агрегат из trips.energyUsedKwh по дням (fallback)
 */
@Injectable()
export class CostForecastService {
  private readonly DEFAULT_RATE = 0.25;
  private readonly MIN_SESSIONS_FOR_EFFECTIVE_RATE = 3;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Вычислить эффективный тариф для машины.
   * Возвращает тариф и источник (для отладки/отображения).
   */
  async resolveRate(vehicleId: string): Promise<{ rate: number; source: string }> {
    // 1. Эффективный тариф из сессий с известной стоимостью
    const sessions = await this.prisma.chargingSession.findMany({
      where: {
        vehicleId,
        costTotal:       { not: null, gt: 0 },
        energyAddedKwh: { not: null, gt: 0 },
      },
      select: { costTotal: true, energyAddedKwh: true },
    });

    if (sessions.length >= this.MIN_SESSIONS_FOR_EFFECTIVE_RATE) {
      const totalCost   = sessions.reduce((s, r) => s + (r.costTotal ?? 0), 0);
      const totalEnergy = sessions.reduce((s, r) => s + (r.energyAddedKwh ?? 0), 0);
      if (totalEnergy > 0) {
        return {
          rate: Math.round((totalCost / totalEnergy) * 1000) / 1000,
          source: 'sessions',
        };
      }
    }

    // 2. homeChargingRate из настроек
    const settings = await this.prisma.vehicleSettings.findUnique({
      where: { vehicleId },
      select: { homeChargingRate: true, chargingCost: true },
    });
    const configured = settings?.homeChargingRate ?? settings?.chargingCost;
    if (configured && configured > 0) {
      return { rate: configured, source: 'settings' };
    }

    // 3. Default
    return { rate: this.DEFAULT_RATE, source: 'default' };
  }

  async forecastForVehicle(vehicleId: string, rateOverride?: number) {
    const { rate: resolvedRate, source: rateSource } =
      rateOverride && rateOverride > 0
        ? { rate: rateOverride, source: 'override' }
        : await this.resolveRate(vehicleId);

    const since = new Date(Date.now() - 30 * 86_400_000);

    // ── Попытка 1: daily_energy ───────────────────────────────────────────
    const dailyRows = await this.prisma.dailyEnergy.findMany({
      where: { vehicleId, date: { gte: since } },
      select: { energyUsedKwh: true },
    });

    let avgEnergyPerDay: number;
    let dataSource: string;

    if (dailyRows.length > 0) {
      const total = dailyRows.reduce((s, r) => s + (r.energyUsedKwh ?? 0), 0);
      // Делим на 30 (период), а не на rows.length — иначе редкие активные дни
      // раздувают среднее (e.g. 3 дня из 30 → средний в 10 раз выше реального).
      avgEnergyPerDay = total / 30;
      dataSource = 'daily_energy';
    } else {
      // ── Fallback: агрегат из trips по дням ───────────────────────────────
      const tripRows = await this.prisma.trip.groupBy({
        by:      ['vehicleId'],
        where:   { vehicleId, startTime: { gte: since }, energyUsedKwh: { not: null } },
        _sum:    { energyUsedKwh: true },
      });

      const totalFromTrips = tripRows[0]?._sum?.energyUsedKwh ?? 0;
      avgEnergyPerDay = totalFromTrips / 30;
      dataSource = 'trips';
    }

    const weeklyCost  = avgEnergyPerDay * 7  * resolvedRate;
    const monthlyCost = avgEnergyPerDay * 30 * resolvedRate;

    return {
      weeklyCost:      Math.round(weeklyCost  * 100) / 100,
      monthlyCost:     Math.round(monthlyCost * 100) / 100,
      avgEnergyPerDay: Math.round(avgEnergyPerDay * 100) / 100,
      effectiveRate:   resolvedRate,
      rateSource,
      dataSource,
    };
  }
}
