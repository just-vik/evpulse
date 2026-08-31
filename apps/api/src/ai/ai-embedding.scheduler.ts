import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../prisma/prisma.service';
import { isWorkerRole } from '../runtime/runtime-role';
import { EMBEDDING_QUEUE, EMBEDDING_JOB_WEEKLY } from './embedding.worker';

@Injectable()
export class AiEmbeddingScheduler {
  private readonly logger = new Logger(AiEmbeddingScheduler.name);

  constructor(
    @InjectQueue(EMBEDDING_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('0 2 * * *')
  async scheduleWeeklyEmbeddings(): Promise<void> {
    if (!isWorkerRole()) return;

    const periodEnd = new Date();
    periodEnd.setHours(0, 0, 0, 0);
    const periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - 7);

    const vehicles = await this.prisma.$queryRaw<Array<{ vehicleId: string; userId: string }>>`
      SELECT DISTINCT t."vehicleId", v."userId"
      FROM "telemetry_points" t
      JOIN "vehicles" v ON v.id = t."vehicleId"
      WHERE t.timestamp >= ${periodStart}
    `;

    let queued = 0;
    for (const { vehicleId, userId } of vehicles) {
      await this.queue.add(
        EMBEDDING_JOB_WEEKLY,
        { vehicleId, userId, periodStart, periodEnd },
        { attempts: 2, backoff: { type: 'fixed', delay: 60_000 }, removeOnComplete: 100, removeOnFail: 50 },
      );
      queued++;
    }

    this.logger.log(`Queued ${queued} weekly embedding job(s)`);
  }
}
