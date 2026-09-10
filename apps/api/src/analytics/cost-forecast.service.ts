import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TariffResolverService } from '../charging/tariff-resolver.service';
import { TariffSource } from '../charging/tariff-resolution.types';

// Preserves CostForecastService's pre-resolver `source` vocabulary
// ('sessions' | 'settings' | 'default') at the resolveRate()/forecastForVehicle()
// API boundary -- apps/web/src/lib/api.ts types `rateSource` against exactly
// these values and CostForecastCard.tsx does `rateSource === 'default'`.
// 'override' never reaches here: forecastForVehicle() short-circuits resolveRate()
// entirely when a caller-supplied rateOverride is present, same bypass treatment
// as manualCost elsewhere in the tariff migration.
function toLegacyRateSource(source: TariffSource): string {
  if (source === 'historical_sessions') return 'sessions';
  if (source === 'default') return 'default';
  // No chargerType is ever passed to resolve() below (this consumer has no
  // per-charger-type branching -- unlike ChargingCostService/VehicleAnalyticsService),
  // so resolveVehicleSettings() can only return 'vehicle_settings.home' in
  // practice. The other branches are unreachable here; mapped to 'settings'
  // for exhaustiveness rather than left to throw.
  return 'settings';
}

/**
 * CostForecastService
 *
 * Тариф: делегирован TariffResolverService (purpose: 'forecast') -- см.
 * docs/calculations/tariff-resolver.md. Иерархия (canonical, resolver-owned):
 *   1. historical_sessions: SUM(costTotal)/SUM(energyAddedKwh) по сессиям
 *      с известной стоимостью, если их ≥3 (иначе нет доверия к данным)
 *   2. vehicle_settings.home: homeChargingRate из VehicleSettings (0 = не задано)
 *   3. canonicalDefaultRate (resolver config)
 *
 * Данные об энергии (иерархия, не изменено миграцией):
 *   1. daily_energy (если есть записи за период)
 *   2. Агрегат из trips.energyUsedKwh по дням (fallback)
 */
@Injectable()
export class CostForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffResolver?: TariffResolverService,
  ) {}

  /**
   * Вычислить эффективный тариф для машины.
   * Возвращает тариф и источник (для отладки/отображения, legacy vocabulary).
   */
  async resolveRate(vehicleId: string): Promise<{ rate: number; source: string }> {
    if (!this.tariffResolver) {
      throw new Error('CostForecastService: TariffResolverService not provided');
    }
    const resolution = await this.tariffResolver.resolve({ purpose: 'forecast', vehicleId });
    return { rate: resolution.rate, source: toLegacyRateSource(resolution.source) };
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
