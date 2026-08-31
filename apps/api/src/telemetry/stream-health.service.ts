import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { isWorkerRole } from '../runtime/runtime-role';

const STREAM_KEY      = 'telemetry:stream';
const LAG_WARN_THRESH = 1_000; // warn if either consumer group is > 1000 messages behind

export interface StreamGroupInfo {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
  lag: number;
}

export interface StreamHealthReport {
  streamLength: number;
  groups: StreamGroupInfo[];
  lagAlert: boolean;
  checkedAt: string;
}

/**
 * StreamHealthService
 *
 * Monitors Redis Stream consumer group lag every minute.
 * Logs a warning when lag exceeds LAG_WARN_THRESH — indicates the batch
 * or real-time pipeline is falling behind ingestion rate.
 *
 * Exposes getHealth() for the /telemetry/stream/health endpoint.
 */
@Injectable()
export class StreamHealthService {
  private readonly logger = new Logger(StreamHealthService.name);
  private lastReport: StreamHealthReport | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Cron('* * * * *') // every minute
  async checkLag() {
    if (!isWorkerRole()) return;
    try {
      this.lastReport = await this.fetchHealth();
      if (this.lastReport.lagAlert) {
        this.logger.warn(
          `Stream lag alert: ${this.lastReport.groups.map(g => `${g.name}=${g.lag}`).join(', ')}`,
        );
      }
    } catch (err: any) {
      this.logger.debug(`Stream health check skipped: ${err.message}`);
    }
  }

  async getHealth(): Promise<StreamHealthReport> {
    // Return cached report if fresh (< 30 s old), otherwise re-fetch
    if (this.lastReport) {
      const age = Date.now() - new Date(this.lastReport.checkedAt).getTime();
      if (age < 30_000) return this.lastReport;
    }
    this.lastReport = await this.fetchHealth();
    return this.lastReport;
  }

  private async fetchHealth(): Promise<StreamHealthReport> {
    // XLEN — total entries still in stream (after MAXLEN trimming)
    const streamLength = await this.redis.xlen(STREAM_KEY).catch(() => 0);

    // XINFO GROUPS returns a flat array: [field, value, field, value, ...][]
    const raw = await this.redis.xinfo('GROUPS', STREAM_KEY).catch(() => [] as any[]);

    const groups: StreamGroupInfo[] = [];
    for (const entry of raw as any[]) {
      // ioredis returns an array per group where even indices are field names
      const obj: Record<string, any> = {};
      for (let i = 0; i < entry.length - 1; i += 2) {
        obj[entry[i]] = entry[i + 1];
      }
      groups.push({
        name:            obj['name'] ?? '',
        consumers:       Number(obj['consumers'] ?? 0),
        pending:         Number(obj['pending'] ?? 0),
        lastDeliveredId: obj['last-delivered-id'] ?? '0',
        lag:             Number(obj['lag'] ?? 0),
      });
    }

    const lagAlert = groups.some(g => g.lag > LAG_WARN_THRESH);

    return {
      streamLength,
      groups,
      lagAlert,
      checkedAt: new Date().toISOString(),
    };
  }
}
