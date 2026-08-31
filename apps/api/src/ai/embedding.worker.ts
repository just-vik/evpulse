import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bull';
import Groq from 'groq-sdk';
import { PrismaService } from '../prisma/prisma.service';

export const EMBEDDING_QUEUE = 'embedding-generation';
export const EMBEDDING_JOB_WEEKLY = 'generate-weekly-summary';

export interface EmbeddingJobPayload {
  vehicleId: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
}

@Processor(EMBEDDING_QUEUE)
export class EmbeddingWorker {
  private readonly logger = new Logger(EmbeddingWorker.name);
  private readonly groq: Groq | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const key = config.get<string>('GROQ_API_KEY');
    this.groq = key ? new Groq({ apiKey: key }) : null;
  }

  @Process(EMBEDDING_JOB_WEEKLY)
  async generateWeeklySummary(job: Job<EmbeddingJobPayload>): Promise<void> {
    const { vehicleId, userId, periodStart, periodEnd } = job.data;

    if (!this.groq) {
      this.logger.warn('GROQ_API_KEY not set — skipping embedding');
      return;
    }

    // Dedup: skip if already generated for this period
    const existing = await this.prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM "user_context_embeddings"
      WHERE "vehicleId" = ${vehicleId}
        AND "periodType" = 'weekly'
        AND "periodStart" = ${new Date(periodStart)}
      LIMIT 1
    `;
    if (existing.length > 0) return;

    const content = await this.buildSummary(vehicleId, new Date(periodStart), new Date(periodEnd));
    if (!content) return;

    const embedding = await this.embed(content);
    if (!embedding) return;

    const vectorLiteral = `[${embedding.join(',')}]`;
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "user_context_embeddings"
         ("userId", "vehicleId", "periodType", "periodStart", "periodEnd", "insightType", "content", "embedding", "metadata")
       VALUES ($1, $2, 'weekly', $3, $4, 'driving_summary', $5, $6::vector(768), $7)`,
      userId,
      vehicleId,
      new Date(periodStart),
      new Date(periodEnd),
      content,
      vectorLiteral,
      JSON.stringify({ version: 1 }),
    );

    this.logger.log(`Embedding stored: ${vehicleId} w/${new Date(periodStart).toISOString().slice(0, 10)}`);
  }

  private async buildSummary(vehicleId: string, from: Date, to: Date): Promise<string | null> {
    const [trips, charges, drainLogs] = await Promise.all([
      this.prisma.trip.findMany({
        where: { vehicleId, startTime: { gte: from, lt: to }, endTime: { not: null } },
        select: { distanceKm: true, energyUsedKwh: true, efficiencyWhkm: true },
      }),
      this.prisma.chargingSession.findMany({
        where: { vehicleId, startTime: { gte: from, lt: to } },
        select: { energyAddedKwh: true, cost: true },
      }),
      this.prisma.vampireDrainLog.findMany({
        where: { vehicleId, date: { gte: from, lt: to } },
        select: { drainPerHr: true },
      }),
    ]);

    if (trips.length === 0 && charges.length === 0) return null;

    const totalKm    = trips.reduce((s, t) => s + (t.distanceKm ?? 0), 0);
    const totalKwh   = trips.reduce((s, t) => s + (t.energyUsedKwh ?? 0), 0);
    const effTrips   = trips.filter(t => t.efficiencyWhkm != null);
    const avgEff     = effTrips.length > 0
      ? effTrips.reduce((s, t) => s + t.efficiencyWhkm!, 0) / effTrips.length
      : null;
    const chargeKwh  = charges.reduce((s, c) => s + (c.energyAddedKwh ?? 0), 0);
    const chargeCost = charges.reduce((s, c) => s + (c.cost ?? 0), 0);
    const avgDrain   = drainLogs.length > 0
      ? drainLogs.reduce((s, d) => s + d.drainPerHr, 0) / drainLogs.length
      : null;

    return [
      `Неделя ${from.toISOString().slice(0, 10)}:`,
      `Поездки: ${trips.length} (${totalKm.toFixed(1)} км, ${totalKwh.toFixed(2)} кВт·ч).`,
      avgEff != null ? `Эффективность: ${Math.round(avgEff)} Вт/км.` : null,
      charges.length > 0
        ? `Зарядки: ${charges.length} (${chargeKwh.toFixed(1)} кВт·ч${chargeCost > 0 ? ', ' + chargeCost.toFixed(2) + ' EUR' : ''}).`
        : null,
      avgDrain != null ? `Разряд в покое: ${avgDrain.toFixed(3)}%/ч.` : null,
    ].filter(Boolean).join(' ');
  }

  private async embed(text: string): Promise<number[] | null> {
    try {
      const res = await this.groq!.embeddings.create({
        model: 'nomic-embed-text-v1.5',
        input: text,
      });
      return (res.data[0]?.embedding as number[] | undefined) ?? null;
    } catch (err: any) {
      this.logger.error('Groq embedding error:', err?.message);
      return null;
    }
  }
}
