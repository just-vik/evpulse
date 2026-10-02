import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryPipelineService } from '../telemetry/telemetry-pipeline.service';
import { normalizeTeslaPayload } from '../utils/normalizeTeslaTelemetry';
import { CreateTelemetryPointDto } from '../telemetry/dto/telemetry.dto';
import { buildTelemetryPointDto } from '../telemetry/raw-telemetry-payload';
import { isWorkerRole } from '../runtime/runtime-role';
import { ApiUsageService } from '../billing/api-usage.service';

@Injectable()
export class FleetTelemetryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetTelemetryWorker.name);
  private readonly STREAM_KEY = 'fleet:telemetry';
  private readonly GROUP_NAME = 'fleet-workers';
  private running = false;
  private readonly consumerId = `worker-${Math.random().toString(16).slice(2)}`;
  private readonly vehicleCache = new Map<string, string>();
  /** How long to wait for processBatch before considering it hung (ms) */
  private readonly PROCESS_TIMEOUT_MS = 180_000;
  private readonly DLQ_KEY = 'dlq:jobs:telemetry';
  private readonly DLQ_MAX_RETRIES = 3;
  /**
   * In-flight guard: tracks the underlying processBatch promise per vehicleId.
   * If a timeout fires the underlying call continues running in background;
   * the guard prevents a second concurrent call for the same vehicle until the
   * first one actually resolves/rejects.
   */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Reclaim pending messages from dead consumers every N loop iterations */
  private loopTick = 0;
  /**
   * Dedicated connection for blocking XREADGROUP calls.
   * A single shared Redis connection cannot mix blocking commands (which tie up
   * the connection until the server responds) with non-blocking commands — all
   * other callers would queue behind the block timeout (up to 5 s each).
   * Using a separate connection for the worker's blocking reads keeps the
   * shared connection free for fast non-blocking operations.
   */
  private blockingRedis!: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly telemetryPipeline: TelemetryPipelineService,
    private readonly configService: ConfigService,
    private readonly apiUsage: ApiUsageService,
  ) {}

  async onModuleInit() {
    if (!isWorkerRole()) {
      this.logger.log('Skipping FleetTelemetryWorker init (APP_ROLE=api)');
      return;
    }
    // Dedicated blocking connection — isolated from the shared non-blocking client
    this.blockingRedis = new Redis({
      host: this.configService.get('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get('REDIS_PASSWORD'),
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
    this.blockingRedis.on('error', (e) => this.logger.warn(`[BlockingRedis] ${e.message}`));

    // Создаём consumer group (идемпотентно)
    try {
      await this.redis.xgroup('CREATE', this.STREAM_KEY, this.GROUP_NAME, '$', 'MKSTREAM' as any);
      this.logger.log(`Redis stream group ${this.GROUP_NAME} created`);
    } catch (err: any) {
      if (!String(err?.message || err).includes('BUSYGROUP')) {
        this.logger.error(`Failed to create stream group: ${err.message}`);
        return;
      }
    }

    this.running = true;
    void this.loop();
    this.logger.log(`Fleet telemetry worker started (id=${this.consumerId})`);
  }

  async onModuleDestroy() {
    this.running = false;
    await this.blockingRedis?.quit().catch(() => {});
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        // BLOCK 5000 = ждём до 5s новых сообщений — не блокирует вечно
        // Uses the dedicated blockingRedis connection so the shared redis client
        // stays free for fast non-blocking operations during the block wait.
        const res = await this.blockingRedis.xreadgroup(
          'GROUP',
          this.GROUP_NAME,
          this.consumerId,
          'COUNT', '200',
          'BLOCK', '5000',
          'STREAMS',
          this.STREAM_KEY,
          '>',
        ) as any;

        if (!res || !Array.isArray(res) || !res.length) continue;

        const entries = res[0][1] as [string, string[]][];
        await this.processEntries(entries, 'stream');

        // Every 30 iterations (~2.5 min): reclaim pending messages from dead consumers
        this.loopTick++;
        if (this.loopTick % 30 === 0) {
          await this.reclaimStalePending().catch((e: any) =>
            this.logger.warn(`XAUTOCLAIM failed: ${e.message}`),
          );
        }
      } catch (error: any) {
        this.logger.error(`Fleet telemetry worker loop error: ${error.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /**
   * Reclaim messages that have been pending for > 5 minutes in dead consumers.
   * Reclaimed messages are re-processed and ACKed only after successful processing.
   */
  private async reclaimStalePending(): Promise<void> {
    const IDLE_THRESHOLD_MS = 5 * 60_000; // 5 minutes
    const res = await (this.redis as any).xautoclaim(
      this.STREAM_KEY,
      this.GROUP_NAME,
      this.consumerId,
      IDLE_THRESHOLD_MS,
      '0-0',
      'COUNT', '200',
    );
    const claimedEntries: [string, string[]][] = Array.isArray(res?.[1]) ? (res[1] as [string, string[]][]) : [];
    if (claimedEntries.length > 0) {
      this.logger.warn(`[AutoClaim] Reclaimed ${claimedEntries.length} stale pending message(s) — reprocessing`);
      await this.processEntries(claimedEntries, 'autoclaim');
    }
  }

  private async processEntries(entries: [string, string[]][], source: 'stream' | 'autoclaim'): Promise<void> {
    // rawEvents[i] is the exact Tesla Fleet Telemetry event that produced points[i] —
    // kept in lockstep so TelemetryRaw can persist the real event (see raw-telemetry-payload.ts)
    // instead of only the already-normalized DTO.
    const perVehicle = new Map<string, { points: CreateTelemetryPointDto[]; rawEvents: unknown[]; ids: string[] }>();

    for (const [id, fields] of entries) {
      const idx = fields.findIndex((f) => f === 'payload');
      const raw = idx >= 0 ? fields[idx + 1] : null;
      if (!raw) continue;

      try {
        const evt = JSON.parse(raw);
        const teslaVehicleId = this.extractTeslaVehicleId(evt);
        if (!teslaVehicleId) continue;

        const vehicleId = await this.resolveVehicleId(teslaVehicleId);
        if (!vehicleId) continue;

        const normalized = normalizeTeslaPayload(evt);

        // Cache last known location for window_control proximity checks
        if (normalized.latitude != null && normalized.longitude != null) {
          void this.redis.set(
            `vehicle:location:${vehicleId}`,
            JSON.stringify({ lat: normalized.latitude, lon: normalized.longitude }),
            'EX', 86_400,
          );
        }

        const dto = buildTelemetryPointDto(normalized);

        if (normalized.self_driving_km != null || normalized.odometer_km_since_reset != null) {
          try {
            const updateData: Record<string, number> = {};
            if (normalized.self_driving_km != null) updateData['selfDrivingKmTotal'] = normalized.self_driving_km;
            if (normalized.odometer_km_since_reset != null) updateData['odometerKmSinceReset'] = normalized.odometer_km_since_reset;
            await this.prisma.vehicle.update({ where: { id: vehicleId }, data: updateData });
          } catch { /* non-fatal */ }
        }

        if (!perVehicle.has(vehicleId)) perVehicle.set(vehicleId, { points: [], rawEvents: [], ids: [] });
        const bucket = perVehicle.get(vehicleId)!;
        bucket.points.push(dto);
        bucket.rawEvents.push(evt);
        bucket.ids.push(id);
      } catch (err: any) {
        this.logger.error(`Failed to process fleet entry ${id}: ${err.message}`);
      }
    }

    for (const [vehicleId, bucket] of perVehicle.entries()) {
      const { points, rawEvents, ids } = bucket;
      if (this.inFlight.has(vehicleId)) {
        this.logger.warn(`[FleetWorker] ${vehicleId} still processing — waiting for previous batch to finish`);
        try {
          await this.inFlight.get(vehicleId);
        } catch {
          // Previous batch failed/timed out — continue with current batch attempt.
        }
      }
      const traceId = randomUUID();
      const underlying = this.telemetryPipeline
        .processBatch(vehicleId, points, 'fleet_telemetry', traceId, rawEvents)
        .finally(() => this.inFlight.delete(vehicleId));
      this.inFlight.set(vehicleId, underlying);
      try {
        await Promise.race([
          underlying,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`processBatch timeout after ${this.PROCESS_TIMEOUT_MS}ms`)), this.PROCESS_TIMEOUT_MS),
          ),
        ]);
        if (ids.length) await this.redis.xack(this.STREAM_KEY, this.GROUP_NAME, ...ids);
        await Promise.all(
          ids.map((id) => (this.redis as any).del(`fleet:retry:${id}`).catch(() => {})),
        );
        void this.apiUsage.trackSignals(vehicleId, points.length).catch(() => {});
      } catch (err: any) {
        this.logger.error(`processBatch failed for ${vehicleId} (${source}): ${err.message}`);
        await this.handleBatchFailure(vehicleId, ids, points, source, err);
      }
    }

    if (perVehicle.size) {
      this.logger.debug(`Processed ${perVehicle.size} vehicle(s) from fleet telemetry ${source}`);
    }
  }

  private extractTeslaVehicleId(evt: any): string | undefined {
    // Fleet Telemetry webhook sends VIN as top-level field
    if (evt.vin) return String(evt.vin);
    if (evt.tesla_vehicle_id) return String(evt.tesla_vehicle_id);
    if (evt.vehicle_id) return String(evt.vehicle_id);
    if (evt.vehicleId) return String(evt.vehicleId);
    if (evt.vehicle?.id) return String(evt.vehicle.id);
    return undefined;
  }

  private async resolveVehicleId(teslaVehicleId: string): Promise<string | null> {
    const normalizedId = teslaVehicleId.trim().toUpperCase();
    if (this.vehicleCache.has(normalizedId)) {
      return this.vehicleCache.get(normalizedId)!;
    }

    let vehicleId: string | null = null;

    // VIN lookup: Fleet Telemetry webhook sends VIN (non-numeric) instead of numeric Tesla ID.
    // VINs are case-insensitive, so normalize to uppercase to avoid missed mappings.
    if (isNaN(Number(normalizedId))) {
      const vehicle = await this.prisma.vehicle.findFirst({
        where: { vin: normalizedId },
      });
      vehicleId = vehicle?.id ?? null;
    } else {
      // Numeric Tesla ID — look up via vehicle link table
      const link = await this.prisma.teslaVehicleLink.findUnique({
        where: { teslaVehicleId: normalizedId },
      });
      vehicleId = link?.vehicleId ?? null;
    }

    if (!vehicleId) return null;

    this.vehicleCache.set(normalizedId, vehicleId);
    if (this.vehicleCache.size > 1000) {
      const firstKey = this.vehicleCache.keys().next().value;
      this.vehicleCache.delete(firstKey);
    }

    return vehicleId;
  }

  private async handleBatchFailure(
    vehicleId: string,
    ids: string[],
    points: CreateTelemetryPointDto[],
    source: 'stream' | 'autoclaim',
    err: Error,
  ): Promise<void> {
    const escalatedIds: string[] = [];

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const retryKey = `fleet:retry:${id}`;
      const retryCount = await (this.redis as any).incr(retryKey).catch(() => 1);
      await (this.redis as any).expire(retryKey, 24 * 60 * 60).catch(() => {});

      if (retryCount < this.DLQ_MAX_RETRIES) continue;

      const entry = JSON.stringify({
        jobName: `fleet-worker:${source}`,
        traceId: id,
        data: { vehicleId, data: points[i] ?? null },
        error: err.message,
        attemptsMade: retryCount,
        failedAt: new Date().toISOString(),
      });
      await this.redis.lpush(this.DLQ_KEY, entry).catch(() => {});
      await this.redis.ltrim(this.DLQ_KEY, 0, 999).catch(() => {});
      await (this.redis as any).del(retryKey).catch(() => {});
      escalatedIds.push(id);
    }

    if (escalatedIds.length > 0) {
      await this.redis.xack(this.STREAM_KEY, this.GROUP_NAME, ...escalatedIds).catch(() => {});
      this.logger.warn(
        `[FleetWorker] Escalated ${escalatedIds.length}/${ids.length} message(s) to DLQ for ${vehicleId} (${source})`,
      );
    }
  }
}
