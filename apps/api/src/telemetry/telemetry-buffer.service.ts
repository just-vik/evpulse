import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { SpanStatusCode } from '@opentelemetry/api';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { TelemetryPipelineService } from './telemetry-pipeline.service';
import { CreateTelemetryPointDto } from './dto/telemetry.dto';
import { tracer } from '../otel';

interface BufferedPoint extends CreateTelemetryPointDto {
  vehicleId: string;
}

/**
 * TelemetryBufferService
 *
 * Буферизует телеметрию в Redis Stream (XADD) и периодически сбрасывает
 * батчами через TelemetryPipeline → TimescaleDB + детекторы поездок/зарядки.
 *
 * Схема: Tesla API / MQTT → addPoint() → XADD telemetry:stream
 *        → (каждые 10s) flush → XREADGROUP → Pipeline → DB + WebSocket → XACK
 *
 * Преимущества Redis Streams перед List:
 *   - Гарантированная доставка (pending messages recovery при рестарте)
 *   - Consumer groups для горизонтального масштабирования
 *   - Ограничение размера через MAXLEN (нет риска переполнения памяти)
 *   - Replay: можно перечитать историю при сбое
 */
@Injectable()
export class TelemetryBufferService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelemetryBufferService.name);

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;

  private readonly FLUSH_INTERVAL_MS = 10_000;
  private readonly MAX_BATCH_SIZE    = 500;
  private readonly STREAM_KEY        = 'telemetry:stream';
  private readonly GROUP_NAME        = 'api-workers';
  private readonly CONSUMER_NAME     = `worker-${process.pid}`;
  // Cap stream at ~10 min of data (500 pts/flush × 60 flushes = 30 000)
  private readonly STREAM_MAXLEN     = 30_000;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly telemetryPipeline: TelemetryPipelineService,
  ) {}

  async onModuleInit() {
    // Create consumer group (idempotent — ignore "already exists" error)
    await this.redis
      .xgroup('CREATE', this.STREAM_KEY, this.GROUP_NAME, '$', 'MKSTREAM')
      .catch((err: Error) => {
        if (!err.message.includes('BUSYGROUP')) throw err;
      });

    // Recover any pending messages that were not ACKed before last restart
    await this.recoverPending();

    this.flushTimer = setInterval(() => {
      if (!this.isFlushing) {
        this.isFlushing = true;
        this.flush()
          .catch((err: Error) => this.logger.error(`Flush failed: ${err.message}`))
          .finally(() => { this.isFlushing = false; });
      }
    }, this.FLUSH_INTERVAL_MS);

    this.logger.log(
      `Telemetry stream started (interval=${this.FLUSH_INTERVAL_MS}ms, maxBatch=${this.MAX_BATCH_SIZE}, stream=${this.STREAM_KEY})`,
    );
  }

  async onModuleDestroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush().catch(() => undefined);
  }

  /**
   * Добавить точку в поток (вызывается TelemetryFetcherService и TelemetryStreamWorker).
   */
  async addPoint(vehicleId: string, dto: CreateTelemetryPointDto): Promise<void> {
    const payload: BufferedPoint = { vehicleId, ...dto };
    await this.redis.xadd(
      this.STREAM_KEY,
      'MAXLEN', '~', String(this.STREAM_MAXLEN),
      '*',                       // auto-generated stream ID
      'data', JSON.stringify(payload),
    );
  }

  /**
   * Читает и обрабатывает непрочитанные сообщения из consumer group.
   * После успешной обработки ACK-ит их (удаляет из pending list).
   */
  async flush(): Promise<void> {
    const { points, ids } = await this.readBatch('>');  // '>' = новые, не прочитанные этим consumer
    if (!points.length) return;

    await tracer.startActiveSpan('telemetry.flush', { attributes: { 'batch.size': points.length, 'stream.first_offset': ids[0] ?? '', 'stream.last_offset': ids[ids.length - 1] ?? '' } }, async (span) => {
      try {
        await this.processBatch(points);
        await this.ackMessages(ids);
        span.end();
      } catch (e: any) {
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
        span.end();
        throw e;
      }
    });
  }

  /**
   * Повторно обрабатывает pending сообщения (не ACKнутые до рестарта).
   * Читает с ID '0' — все pending для этого consumer.
   */
  private async recoverPending(): Promise<void> {
    const { points, ids } = await this.readBatch('0');
    if (!points.length) return;

    this.logger.warn(`Recovering ${points.length} pending messages from before restart`);
    await this.processBatch(points);
    await this.ackMessages(ids);
  }

  private async readBatch(id: '>' | '0'): Promise<{ points: BufferedPoint[]; ids: string[] }> {
    // ioredis xreadgroup: XREADGROUP GROUP group consumer [COUNT count] STREAMS key id
    const result = await this.redis.xreadgroup(
      'GROUP', this.GROUP_NAME, this.CONSUMER_NAME,
      'COUNT', String(this.MAX_BATCH_SIZE),
      'STREAMS', this.STREAM_KEY,
      id,
    ) as Array<[string, Array<[string, string[]]>]> | null;

    const points: BufferedPoint[] = [];
    const ids: string[] = [];

    if (!result) return { points, ids };

    for (const [, messages] of result) {
      for (const [msgId, fields] of messages) {
        // fields = ['data', '{json}']
        const dataIdx = fields.indexOf('data');
        if (dataIdx === -1 || dataIdx + 1 >= fields.length) continue;
        try {
          points.push(JSON.parse(fields[dataIdx + 1]) as BufferedPoint);
          ids.push(msgId);
        } catch {
          ids.push(msgId); // ACK malformed message so it doesn't block the group
        }
      }
    }

    return { points, ids };
  }

  private async ackMessages(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.redis.xack(this.STREAM_KEY, this.GROUP_NAME, ...ids);
  }

  private async processBatch(points: BufferedPoint[]): Promise<void> {
    const byVehicle = new Map<string, CreateTelemetryPointDto[]>();
    for (const p of points) {
      const { vehicleId, ...dto } = p;
      if (!byVehicle.has(vehicleId)) byVehicle.set(vehicleId, []);
      byVehicle.get(vehicleId)!.push(dto);
    }

    for (const [vehicleId, dtos] of byVehicle.entries()) {
      await this.telemetryPipeline.processBatch(vehicleId, dtos);
    }

    this.logger.debug(
      `Flushed ${points.length} point(s) for ${byVehicle.size} vehicle(s)`,
    );
  }
}
