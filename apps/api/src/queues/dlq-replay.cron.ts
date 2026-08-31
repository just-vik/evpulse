import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { TelemetryPipelineService } from '../telemetry/telemetry-pipeline.service';
import { isWorkerRole } from '../runtime/runtime-role';

const DLQ_KEY       = 'dlq:jobs:telemetry';
const PERM_FAIL_KEY = 'dlq:permanent:telemetry';  // graveyard for unrecoverable jobs
const REPLAY_BATCH  = 20;   // max jobs per cycle
const MAX_RETRIES   = 5;    // after this → permanent failure

/**
 * DLQ entry schema (stored as JSON in Redis list).
 * Backwards-compatible: older entries without retryCount are treated as 0.
 */
interface DlqEntry {
  jobName:       string;
  jobId?:        string;
  traceId?:      string;
  data:          { vehicleId?: string; data?: any; [k: string]: any };
  error:         string;
  stack?:        string;
  attemptsMade?: number;
  failedAt?:     string;
  // Exponential backoff fields (added on first replay attempt)
  retryCount:    number;
  nextRetryAt:   number;  // epoch ms — skip this entry until now() > nextRetryAt
  firstFailedAt: number;  // epoch ms
}

/**
 * DlqReplayCronService — converts the Dead Letter Queue into a self-healing buffer.
 *
 * Every 2 minutes:
 *  1. Reads up to REPLAY_BATCH entries
 *  2. Skips entries whose nextRetryAt is in the future (respects backoff)
 *  3. Attempts re-processing via the full telemetry pipeline
 *  4. Success   → lrem (delete from DLQ)
 *  5. Failure   → increment retryCount, compute next delay: 2^retryCount minutes
 *                 replace in DLQ with updated metadata
 *  6. Too many  → after MAX_RETRIES, move to PERM_FAIL_KEY (permanent graveyard)
 *
 * Exponential delays:
 *   attempt 1 →  2 min
 *   attempt 2 →  4 min
 *   attempt 3 →  8 min
 *   attempt 4 → 16 min
 *   attempt 5 → permanent failure
 */
@Injectable()
export class DlqReplayCronService {
  private readonly logger = new Logger(DlqReplayCronService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Optional() private readonly pipeline?: TelemetryPipelineService,
  ) {}

  @Cron('*/2 * * * *')
  async replayDlq(): Promise<void> {
    if (!isWorkerRole()) return;
    if (!this.pipeline) return;

    let depth: number;
    try {
      depth = await this.redis.llen(DLQ_KEY);
    } catch {
      return;
    }

    if (depth === 0) return;

    const rawEntries = await this.redis.lrange(DLQ_KEY, 0, REPLAY_BATCH - 1);
    const now = Date.now();

    let replayed   = 0;
    let skipped    = 0;
    let failed     = 0;
    let permanent  = 0;

    for (const raw of rawEntries) {
      let entry: DlqEntry;

      try {
        const parsed = JSON.parse(raw);
        entry = {
          retryCount:    parsed.retryCount    ?? 0,
          nextRetryAt:   parsed.nextRetryAt   ?? 0,
          firstFailedAt: parsed.firstFailedAt ?? Date.now(),
          ...parsed,
        } as DlqEntry;
      } catch {
        // Corrupt/unparseable entry — move to permanent failure
        await this.redis.lrem(DLQ_KEY, 1, raw);
        await this.redis.lpush(PERM_FAIL_KEY, raw);
        await this.redis.ltrim(PERM_FAIL_KEY, 0, 499);
        permanent++;
        continue;
      }

      // Respect backoff window — skip until nextRetryAt
      if (entry.nextRetryAt > now) {
        skipped++;
        continue;
      }

      // Permanent failure after too many retries
      if (entry.retryCount >= MAX_RETRIES) {
        this.logger.error(
          `[DLQ] Permanent failure after ${entry.retryCount} retries: vehicleId=${entry.data?.vehicleId} error="${entry.error}"`,
        );
        await this.redis.lrem(DLQ_KEY, 1, raw);
        const permEntry = JSON.stringify({ ...entry, movedToPermanentAt: new Date().toISOString() });
        await this.redis.lpush(PERM_FAIL_KEY, permEntry);
        await this.redis.ltrim(PERM_FAIL_KEY, 0, 499);
        permanent++;
        continue;
      }

      // Attempt replay
      const vehicleId: string | undefined = entry?.data?.vehicleId;
      const data: any = entry?.data?.data;

      if (!vehicleId || !data) {
        // Unrecoverable — no vehicle/data to replay
        await this.redis.lrem(DLQ_KEY, 1, raw);
        permanent++;
        continue;
      }

      const traceId = `dlq-replay-${randomUUID()}`;

      try {
        const points: any[] = Array.isArray(data) ? data : [data];
        await this.pipeline.processBatch(vehicleId, points, 'fleet_telemetry', traceId);

        await this.redis.lrem(DLQ_KEY, 1, raw);
        this.logger.log(
          `[DLQ] Replayed vehicleId=${vehicleId} retryCount=${entry.retryCount} traceId=${traceId}`,
        );
        replayed++;
      } catch (e: any) {
        // Replay failed — apply exponential backoff and put back
        entry.retryCount++;
        const backoffMs = Math.pow(2, entry.retryCount) * 60_000; // 2^n minutes
        entry.nextRetryAt = now + backoffMs;
        entry.error = e.message;

        // Replace in DLQ: remove old, append updated
        await this.redis.lrem(DLQ_KEY, 1, raw);
        await this.redis.rpush(DLQ_KEY, JSON.stringify(entry));

        this.logger.debug(
          `[DLQ] Retry ${entry.retryCount}/${MAX_RETRIES} failed for vehicleId=${vehicleId}. ` +
          `Next attempt in ${Math.round(backoffMs / 60000)}min. Error: ${e.message}`,
        );
        failed++;
      }
    }

    if (replayed + failed + permanent > 0) {
      this.logger.log(
        `[DLQ] Cycle: replayed=${replayed} backed-off=${failed} permanent=${permanent} skipped=${skipped} remaining=${depth - replayed}`,
      );
    }
  }
}
