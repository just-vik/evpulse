import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { PrismaService } from '../prisma/prisma.service';
import { AiService, InsightContext } from './ai.service';
import { isWorkerRole } from '../runtime/runtime-role';

/** Redis TTL for nightly pre-computed insights — 26 h so they survive until the next run. */
const NIGHTLY_TTL = 26 * 3600;

@Injectable()
export class InsightsBatchService {
  private readonly logger = new Logger(InsightsBatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly ai: AiService,
  ) {}

  /**
   * Nightly at 08:00 UTC — pre-compute AI insights for every active vehicle.
   *
   * Results are cached in Redis under `ai:nightly:{vehicleId}` (26 h TTL).
   * The AI insights controller checks this key before calling Groq in real time,
   * so dashboard loads feel instant and Groq quota is consumed during off-peak hours.
   */
  @Cron('0 8 * * *')
  async runNightly(): Promise<void> {
    if (!isWorkerRole()) return;

    const vehicles = await this.prisma.vehicle.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        userId: true,
        user: { select: { userSettings: { select: { language: true } } } },
      },
    });

    this.logger.log(`[InsightsBatch] Starting nightly run for ${vehicles.length} vehicle(s)`);
    let ok = 0;
    let fail = 0;

    for (const vehicle of vehicles) {
      try {
        const partial = await this.ai.buildContextForVehicle(vehicle.id);
        const language = (vehicle.user as any)?.userSettings?.language ?? 'en';

        const context: InsightContext = {
          vehicleId: vehicle.id,
          userId: vehicle.userId,
          language,
          // Spread built context — nulls are fine, generateInsights handles them
          soc: partial.soc ?? null,
          chargingState: partial.chargingState ?? null,
          vehicleState: partial.vehicleState ?? null,
          outsideTemp: partial.outsideTemp ?? null,
          batteryRangeKm: partial.batteryRangeKm ?? null,
          sohPercent: partial.sohPercent ?? null,
          degradationPercent: partial.degradationPercent ?? null,
          estimatedCapacityKwh: partial.estimatedCapacityKwh ?? null,
          nominalCapacityKwh: partial.nominalCapacityKwh ?? null,
          tripCount: partial.tripCount ?? 0,
          distanceKm: partial.distanceKm ?? 0,
          energyKwh: partial.energyKwh ?? 0,
          efficiencyWhKm: partial.efficiencyWhKm ?? null,
          chargingSessions: partial.chargingSessions ?? 0,
          chargingEnergyKwh: partial.chargingEnergyKwh ?? 0,
          totalCost: partial.totalCost ?? null,
          costPerKm: partial.costPerKm ?? null,
          vampireDrainPct: partial.vampireDrainPct ?? null,
          vampireDrainPerHr: partial.vampireDrainPerHr ?? null,
          avgEfficiency7d: partial.avgEfficiency7d ?? null,
          drainTrend3d: partial.drainTrend3d ?? null,
          dataQuality: 'DELAYED',
        };

        const insights = await this.ai.generateInsights(context);

        await this.redis.set(
          `ai:nightly:${vehicle.id}`,
          JSON.stringify({ insights, generatedAt: new Date().toISOString() }),
          'EX',
          NIGHTLY_TTL,
        );
        ok++;
      } catch (e: any) {
        this.logger.error(`[InsightsBatch] Failed for vehicle ${vehicle.id}: ${e.message}`);
        fail++;
      }
    }

    this.logger.log(`[InsightsBatch] Done — ok=${ok}, fail=${fail}`);
  }

  /** Called by AiController to serve pre-computed insights when available. */
  async getNightlyInsights(vehicleId: string): Promise<{ insights: any[]; generatedAt: string } | null> {
    try {
      const raw = await this.redis.get(`ai:nightly:${vehicleId}`);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
