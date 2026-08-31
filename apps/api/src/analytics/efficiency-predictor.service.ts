import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * EfficiencyPredictorService
 *
 * Прогноз основан на реальной эффективности из поездок (efficiencyWhkm),
 * скорректированной на текущую температуру.
 *
 * Модель температурной поправки (EV research):
 *   - baseline 20°C → множитель 1.0
 *   - ниже 20°C: +1.0% за каждый градус (батарея греется, HVAC)
 *   - выше 30°C: +0.5% за каждый градус (кондиционер)
 *   - пример: 6°C → +14% → множитель 1.14
 */
@Injectable()
export class EfficiencyPredictorService {
  private readonly TEMP_BASELINE = 20; // °C
  private readonly COLD_PENALTY_PER_DEG = 0.01;  // 1%/°C below baseline
  private readonly HOT_PENALTY_PER_DEG  = 0.005; // 0.5%/°C above 30°C
  private readonly MIN_TRIP_KM = 2;    // filter out micro-trips
  private readonly TRIPS_LOOKBACK = 20;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Коэффициент температурной поправки.
   * 20°C → 1.0, 0°C → 1.20, -10°C → 1.30, 35°C → 1.025
   */
  tempFactor(outsideTemp: number): number {
    if (outsideTemp < this.TEMP_BASELINE) {
      return 1 + (this.TEMP_BASELINE - outsideTemp) * this.COLD_PENALTY_PER_DEG;
    }
    if (outsideTemp > 30) {
      return 1 + (outsideTemp - 30) * this.HOT_PENALTY_PER_DEG;
    }
    return 1.0;
  }

  predictRangeKm(effWhKm: number, usableKwh: number): number {
    if (!effWhKm || effWhKm <= 0 || !usableKwh) return 0;
    return (usableKwh * 1000) / effWhKm;
  }

  async predictForVehicle(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { vehicleSpec: true },
    });
    if (!vehicle) return null;

    const usableKwh =
      (vehicle as any).batteryCapacityDetected ??
      vehicle.vehicleSpec?.batteryUsableKwh ??
      vehicle.batteryCapacityUsable;

    // ── Реальная эффективность из последних поездок ───────────────────────
    const trips = await this.prisma.trip.findMany({
      where: {
        vehicleId,
        efficiencyWhkm: { not: null },
        distanceKm: { gte: this.MIN_TRIP_KM },
      },
      orderBy: { startTime: 'desc' },
      take: this.TRIPS_LOOKBACK,
      select: {
        distanceKm: true,
        efficiencyWhkm: true,
        startTime: true,
        endTime: true,
      },
    });

    // Взвешенное среднее по расстоянию (длинные поездки важнее)
    let baseWhKm: number;
    let avgSpeed: number;

    if (trips.length > 0) {
      const totalDist = trips.reduce((s, t) => s + (t.distanceKm ?? 0), 0);
      baseWhKm =
        totalDist > 0
          ? trips.reduce(
              (s, t) => s + (t.efficiencyWhkm ?? 0) * (t.distanceKm ?? 0),
              0,
            ) / totalDist
          : 150;

      // Средняя скорость из distance / duration по каждой поездке
      const speeds = trips
        .map((t) => {
          const durationH =
            (t.endTime?.getTime() ?? t.startTime.getTime()) -
            t.startTime.getTime();
          if (durationH <= 0 || !t.distanceKm) return null;
          return (t.distanceKm / durationH) * 3_600_000;
        })
        .filter((s): s is number => s !== null && isFinite(s) && s > 0 && s < 200);

      avgSpeed =
        speeds.length > 0
          ? speeds.reduce((a, b) => a + b, 0) / speeds.length
          : 50;
    } else {
      // Нет поездок → консервативные defaults
      baseWhKm = 160;
      avgSpeed = 50;
    }

    // ── Текущая температура из последней телеметрии ───────────────────────
    const latestPoint = await this.prisma.telemetryPoint.findFirst({
      where: { vehicleId, outsideTemp: { not: null } },
      orderBy: { timestamp: 'desc' },
      select: { outsideTemp: true },
    });
    const currentTemp = latestPoint?.outsideTemp ?? this.TEMP_BASELINE;

    // ── Применяем поправку на температуру ────────────────────────────────
    const factor = this.tempFactor(currentTemp);
    const predictedWhKm = Math.max(80, Math.min(baseWhKm * factor, 350));
    const rangeKm = this.predictRangeKm(predictedWhKm, usableKwh);

    return {
      vehicleId,
      predictedWhKm: Math.round(predictedWhKm),
      predictedRangeKm: Math.round(rangeKm),
      assumptions: {
        avgSpeed: Math.round(avgSpeed),
        outsideTemp: Math.round(currentTemp * 10) / 10,
        usableKwh,
        tripCount: trips.length,
        baseWhKm: Math.round(baseWhKm),
        tempFactor: +factor.toFixed(2),
      },
    };
  }
}
