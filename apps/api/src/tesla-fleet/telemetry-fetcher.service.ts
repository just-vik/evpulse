import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { getCircuitBreakerStatus } from './tesla-http.config';
import { TeslaFleetService } from './tesla-fleet.service';
import { TeslaOAuthService } from './tesla-oauth.service';
import { VehicleStateMachineService, VehicleState } from './vehicle-state-machine.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { TripDetectorService } from '../trips/trip-detector.service';
import { TripPatternService } from '../trips/trip-pattern.service';
import { ChargingDetectorService } from '../charging/charging-detector.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeTeslaPayload } from '../utils/normalizeTeslaTelemetry';
import { TelemetryBufferService } from '../telemetry/telemetry-buffer.service';
import { RedisService } from '../redis/redis.service';
import { ChargingSyncService } from './charging-sync.service';
import { ApiUsageService } from '../billing/api-usage.service';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { isWorkerRole } from '../runtime/runtime-role';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { tracer } from '../otel';

const activeSpan = () => trace.getActiveSpan();

/** Sliding-window parameters for Tesla API rate limiting */
const SW_WINDOW_MS  = 30_000; // 30-second window
const SW_MAX_CALLS  = 1;       // max 1 call per window per vehicle

/** Adaptive REST polling intervals. Override via env vars to tune without deploys.
 * These only apply when fleet telemetry is NOT streaming — fleet live suppresses REST. */
const POLL_DRIVING_MS  = parseInt(process.env.TESLA_POLL_INTERVAL_DRIVING_MS  ?? '', 10) || 2 * 60_000;   // 2 min
const POLL_CHARGING_MS = parseInt(process.env.TESLA_POLL_INTERVAL_CHARGING_MS ?? '', 10) || 15 * 60_000;  // 15 min
const POLL_PARKED_MS   = parseInt(process.env.TESLA_POLL_INTERVAL_PARKED_MS   ?? '', 10) || 5 * 60_000;   // 5 min — was 30 min, reduced to catch charging start within ≤5 min

// Cost tracking defaults (informational only — Tesla Developer Portal enforces its own billing limits).
// NOTE: Tesla charges per vehicle_data API call (~€0.002/call). The app also
// counts other API calls (commands, status) so the estimate is ~2x actual billing.
// Use a higher budget and halved per-request cost for more accurate diagnostics.
const DEFAULT_MONTHLY_BUDGET_EUR = 25;      // reference budget for diagnostics display
const DEFAULT_SOFT_LIMIT_PCT = 0.85;        // threshold used for diagnostics reporting only
const DEFAULT_REQ_COST_EUR = 0.001;         // halved: app counts 2x more calls than Tesla bills

/**
 * Atomic Lua rate-limiter script.
 *
 * Executes ZREMRANGEBYSCORE + ZCARD + conditional ZADD + PEXPIRE as a
 * single Redis transaction — no race conditions between check and record.
 *
 * KEYS[1]  — sorted set key  (rate:sw:{vehicleId})
 * ARGV[1]  — current timestamp ms
 * ARGV[2]  — window size ms
 * ARGV[3]  — max calls allowed
 * ARGV[4]  — unique member (UUID)
 *
 * Returns 1 → allowed, 0 → rate-limited
 */
const RATE_LIMITER_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window + 10000)
return 1
`;

/**
 * Concurrency limiter for external API calls.
 * Queues callers when the concurrent request limit is reached.
 */
class ConcurrencyLimiter {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running < this.max) {
      this.running++;
      try { return await fn(); }
      finally { this.running--; this.dequeue(); }
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.running++;
        fn().then(resolve).catch(reject).finally(() => { this.running--; this.dequeue(); });
      });
    });
  }
  private dequeue() { this.queue.shift()?.(); }
}

/**
 * TelemetryFetcherService - Orchestrates real Tesla data ingestion
 * 
 * Responsibilities:
 * - Fetch live vehicle data from Tesla Fleet API
 * - Handle API errors gracefully
 * - Extract telemetry points from API response
 * - Normalize data for storage
 * - Trigger downstream services (trip detection, charging detection)
 * - Respect vehicle state for polling frequency
 * 
 * This replaces the mock telemetry in telemetry.processor.ts
 */
@Injectable()
export class TelemetryFetcherService {
  private readonly logger = new Logger(TelemetryFetcherService.name);
  // Tracks which vehicles already have an adaptive polling loop running
  private readonly activeLoops = new Map<string, boolean>();
  // Tracks last time activity (driving/charging) was detected per vehicle
  private readonly lastActivityMap = new Map<string, number>();
  // Tracks previous charging state per vehicle for transition detection
  private readonly prevChargingState = new Map<string, string>();

  /**
   * Global Tesla API concurrency limiter.
   * Max 2 simultaneous requests, min 200ms between completions.
   * Prevents 408/502 errors from hammering the API.
   */
  private readonly teslaApiLimiter = new ConcurrencyLimiter(2);
  private readonly monthlyBudgetEur = Number(process.env.TESLA_BUDGET_MONTHLY_EUR ?? DEFAULT_MONTHLY_BUDGET_EUR);
  private readonly softLimitPct = Number(process.env.TESLA_BUDGET_SOFT_PCT ?? DEFAULT_SOFT_LIMIT_PCT);
  private readonly estimatedReqCostEur = Number(process.env.TESLA_BUDGET_ESTIMATED_EUR_PER_REQUEST ?? DEFAULT_REQ_COST_EUR);

  constructor(
    private teslaFleet: TeslaFleetService,
    private teslaOAuth: TeslaOAuthService,
    private stateMachine: VehicleStateMachineService,
    private telemetryService: TelemetryService,
    private tripDetector: TripDetectorService,
    private chargingDetector: ChargingDetectorService,
    private telemetryBuffer: TelemetryBufferService,
    private prisma: PrismaService,
    private redis: RedisService,
    @Inject(REDIS_CLIENT) private rawRedis: Redis,
    @Optional() private chargingSync?: ChargingSyncService,
    @Optional() private tripPattern?: TripPatternService,
    @Optional() private apiUsage?: ApiUsageService,
  ) { }

  /**
   * Atomic sliding-window rate limiter via Lua eval.
   *
   * All Redis operations (ZREMRANGEBYSCORE + ZCARD + ZADD + PEXPIRE) run
   * as a single atomic script — no race conditions between concurrent pollers.
   *
   * Returns true  → caller is allowed to proceed
   * Returns false → caller should skip this cycle
   */
  private async slidingWindowAllow(vehicleId: string): Promise<boolean> {
    const key = `rate:sw:${vehicleId}`;
    const result = await (this.rawRedis as any).eval(
      RATE_LIMITER_LUA,
      1,                          // numkeys
      key,                        // KEYS[1]
      Date.now().toString(),      // ARGV[1]
      SW_WINDOW_MS.toString(),    // ARGV[2]
      SW_MAX_CALLS.toString(),    // ARGV[3]
      randomUUID(),               // ARGV[4]
    ) as number;
    return result === 1;
  }

  private getMonthKey(now = new Date()): string {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  private getMonthTtlSeconds(now = new Date()): number {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
    return Math.max(60, Math.floor((next.getTime() - now.getTime()) / 1000));
  }

  private async recordEstimatedBillingRequest(vehicleId: string): Promise<void> {
    const month = this.getMonthKey();
    const ttl = this.getMonthTtlSeconds();
    const key = `tesla:billing:req-count:${vehicleId}:${month}`;
    await this.rawRedis.incr(key);
    await this.rawRedis.expire(key, ttl);
    void this.apiUsage?.trackWake(vehicleId).catch(() => {});
  }

  private async setLastFailure(
    vehicleId: string,
    reason: 'billing_scope_403' | 'no_vehicle_data' | 'timeout_or_network',
    status?: number,
  ): Promise<void> {
    const payload = JSON.stringify({
      reason,
      status: status ?? null,
      at: new Date().toISOString(),
    });
    await this.rawRedis.set(`tesla:last-failure:${vehicleId}`, payload, 'EX', 12 * 60 * 60);
  }

  private async clearLastFailure(vehicleId: string): Promise<void> {
    await this.rawRedis.del(`tesla:last-failure:${vehicleId}`);
  }

  async getBudgetStatusForVehicle(vehicleId: string): Promise<{
    monthlyBudgetEur: number;
    softLimitPct: number;
    softLimitEur: number;
    estimatedReqCostEur: number;
    estimatedMonthSpendEur: number;
    estimatedRequestCount: number;
  }> {
    const month = this.getMonthKey();
    const calls = Number(await this.rawRedis.get(`tesla:billing:req-count:${vehicleId}:${month}`)) || 0;
    const estimatedMonthSpendEur = calls * this.estimatedReqCostEur;
    return {
      monthlyBudgetEur: this.monthlyBudgetEur,
      softLimitPct: this.softLimitPct,
      softLimitEur: this.monthlyBudgetEur * this.softLimitPct,
      estimatedReqCostEur: this.estimatedReqCostEur,
      estimatedMonthSpendEur,
      estimatedRequestCount: calls,
    };
  }

  /**
   * Fetch telemetry for a specific vehicle.
   * Returns normalized telemetry point when successful, otherwise null.
   */
  async fetchVehicleTelemetry(
    vehicleId: string,
    userId: string,
    opts?: { bypassSlidingWindow?: boolean },
  ): Promise<ReturnType<typeof normalizeTeslaPayload> | null> {
    return tracer.startActiveSpan(
      'tesla.rest.poll',
      { attributes: { 'vehicle.id': vehicleId, 'poll.bypass_window': opts?.bypassSlidingWindow ?? false } },
      (span) => this._fetchVehicleTelemetryInner(vehicleId, userId, opts).then(
        (result) => { span.setAttribute('poll.result', result ? 'fetched' : 'skipped'); span.end(); return result; },
        (err)    => { span.recordException(err); span.setStatus({ code: SpanStatusCode.ERROR, message: err.message }); span.end(); throw err; },
      ),
    );
  }

  private async _fetchVehicleTelemetryInner(
    vehicleId: string,
    userId: string,
    opts?: { bypassSlidingWindow?: boolean },
  ): Promise<ReturnType<typeof normalizeTeslaPayload> | null> {
    try {
      // Tesla billing backoff: if Tesla returned 403 (EXCEEDED_LIMIT) recently, stop hammering.
      // Checked before sliding window so ALL callers (cron, gap-recovery, etc.) respect it.
      if (!opts?.bypassSlidingWindow) {
        const rateLimited = await this.redis.get(`tesla:ratelimit:${vehicleId}`).catch(() => null);
        if (rateLimited) {
          this.logger.debug(`Vehicle ${vehicleId} rate-limited by Tesla 403 — skipping REST poll`);
          activeSpan()?.setAttribute('poll.skip_reason', 'rate_limited_403');
          return null;
        }
      }

      // Sliding-window rate limit: max SW_MAX_CALLS per SW_WINDOW_MS per vehicle.
      // Unlike the old TTL-key approach, this window can never "get stuck" —
      // entries expire naturally and keys carry an automatic TTL.
      if (!opts?.bypassSlidingWindow) {
        const allowed = await this.slidingWindowAllow(vehicleId);
        if (!allowed) {
          this.logger.debug(`[SW-rate] limited Tesla API poll for vehicle ${vehicleId}`);
          activeSpan()?.setAttribute('poll.skip_reason', 'sliding_window');
          return null;
        }
      }

      // Skip REST poll when fleet telemetry is streaming — saves ~€10/month in API costs.
      // Fleet telemetry sets fleet:live:vin:{vin} with 5-min TTL on every MQTT flush.
      // Exception: wake-hint bypasses this skip so we get fresh data after car wakes.
      const wakeHintEarly = await this.redis.get(`tesla:wake-hint:${vehicleId}`);
      const vehicleForLiveCheck = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: { vin: true },
      });
      if (!wakeHintEarly && vehicleForLiveCheck?.vin) {
        const fleetLive = await this.redis.get(`fleet:live:vin:${vehicleForLiveCheck.vin}`);
        if (fleetLive) {
          this.logger.debug(`Fleet telemetry live for ${vehicleId} — skipping REST poll`);
          activeSpan()?.setAttribute('poll.skip_reason', 'fleet_live');
          return null;
        }
        // Sleep-confirmed cache: Tesla confirmed the car asleep recently — skip Daten call.
        // Cleared by markVehicleLive() when fleet data arrives (car woke + streaming).
        // 10-min TTL: short window trades ~4 extra API calls/sleep for never missing >10 min of driving.
        const sleepConfirmed = await this.redis.get(`tesla:sleep-confirmed:vin:${vehicleForLiveCheck.vin}`);
        if (sleepConfirmed) {
          this.logger.debug(`Sleep-confirmed for ${vehicleId} — skipping REST poll (fleet will push on wake)`);
          activeSpan()?.setAttribute('poll.skip_reason', 'sleep_confirmed');
          return null;
        }
      }
      if (wakeHintEarly) {
        this.logger.debug(`Fleet live bypass: wake-hint active for ${vehicleId} — forcing REST poll`);
      }

      // Small random jitter to avoid thundering herd on Tesla API
      await new Promise((r) => setTimeout(r, Math.random() * 1000));

      // Get valid access token (refreshes if needed)
      const accessToken = await this.teslaOAuth.getValidAccessToken(userId);

      // Get vehicle from DB (we need Tesla ID)
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
      });

      if (!vehicle) {
        this.logger.warn(`Vehicle ${vehicleId} not found`);
        return null;
      }

      if (!vehicle.teslaId) {
        this.logger.warn(`Vehicle ${vehicleId} has no linked Tesla ID – skipping polling`);
        return null;
      }

      const teslaId = vehicle.teslaId.toString();

      // Lightweight state check via /vehicles/{id} to avoid hammering /vehicle_data
      // when the car is clearly ASLEEP. "offline" в Fleet иногда не означает
      // реальное недоступное состояние, поэтому его не блокируем полностью.
      this.logger.debug(
        `Tesla summary request vehicle=${vehicleId} teslaId=${teslaId}`,
      );
      const summary = await this.withTimeout(
        this.teslaFleet.getVehicleSummary(teslaId, accessToken),
      );
      await this.recordEstimatedBillingRequest(vehicleId);
      const connectionState = summary?.state as string | undefined;
      activeSpan()?.setAttribute('tesla.vehicle_state', connectionState ?? 'unknown');

      // Soft "let it sleep": если Tesla говорит, что машина спит, мы обычно
      // пропускаем тяжёлый vehicle_data, чтобы не будить её лишний раз.
      // НО: если в последние 5 мин была активность (speed > 0) — Tesla API
      // часто кэширует summary как "asleep" с задержкой. Игнорируем asleep
      // и делаем полный запрос, чтобы не терять поездки.
      if (connectionState && connectionState.toLowerCase() === 'asleep') {
        const wakeHintKey = `tesla:wake-hint:${vehicleId}`;
        const recentWake = await this.redis.get(wakeHintKey);
        const lastActivity = this.lastActivityMap.get(vehicleId) ?? 0;
        const recentlyActive = (Date.now() - lastActivity) < 5 * 60_000; // active within 5 min

        if (!recentWake && !recentlyActive) {
          // Mark as SLEEPING so pollLoop can skip REST calls entirely on next iterations.
          await this.stateMachine.setSleeping(vehicleId);
          // Cache sleep confirmation — prevents forceFetch/GapRecovery from re-calling Tesla
          // API every 5-10 min while car is asleep. Cleared when fleet telemetry resumes.
          // TTL 10 min (was 90 min): shorter window trades ~4 extra API calls/sleep episode
          // for never missing more than 10 min of driving when fleet telemetry is offline.
          if (vehicleForLiveCheck?.vin) {
            await this.redis.set(`tesla:sleep-confirmed:vin:${vehicleForLiveCheck.vin}`, '1', 'EX', 10 * 60);
          }
          this.logger.debug(
            `Skipping telemetry poll for vehicle ${vehicleId} — Tesla state=${connectionState}, sleep-confirmed 10min`,
          );
          activeSpan()?.setAttribute('poll.skip_reason', 'tesla_asleep');
          return null;
        }

        this.logger.debug(
          `Tesla state=${connectionState} but ${recentlyActive ? 'recently active' : 'recent wake'} — forcing vehicle_data poll for ${vehicleId}`,
        );
      }

      // NOTE: раньше здесь был gate через shouldPollVehicle, который блокировал
      // опрос, если stateMachine считала машину offline. Это приводило к
      // "залипанию" в offline и отсутствию новых точек. Сейчас всегда делаем
      // попытку опроса (см. state-aware интервалы в pollLoop).

      // Fetch full vehicle_data from Tesla Fleet API.
      // NOTE: For Fleet API, /vehicle_data is supported while /data_request/* endpoints
      // may not be, so we rely on this consolidated call and then normalize the payload.
      this.logger.debug(
        `Tesla vehicle_data request vehicle=${vehicleId} teslaId=${teslaId}`,
      );
      const vehicleData = await this.teslaApiLimiter.run(() =>
        this.withTimeout(
          this.teslaFleet.getVehicleData(teslaId, accessToken, {
            // location_data — explicit GPS endpoint for Tesla Fleet API.
            // drive_state alone may omit lat/lon when car is parked.
            endpoints: ['drive_state', 'charge_state', 'climate_state', 'vehicle_state', 'location_data'],
          }),
        ),
      );
      await this.recordEstimatedBillingRequest(vehicleId);

      if (!vehicleData) {
        this.logger.warn(
          `No data received for vehicle ${vehicleId} - vehicle may be sleeping`,
        );
        // Mark as SLEEPING so the next pollLoop iteration skips REST polling entirely.
        // Fleet Telemetry will push data when the car wakes up.
        await this.stateMachine.setSleeping(vehicleId);
        await this.setLastFailure(vehicleId, 'no_vehicle_data');
        // Cache as sleeping to prevent the next forceFetch/GapRecovery cycle burning 2 Daten again
        if (vehicleForLiveCheck?.vin) {
          await this.redis.set(`tesla:sleep-confirmed:vin:${vehicleForLiveCheck.vin}`, '1', 'EX', 10 * 60);
        }
        return null;
      }

      await this.clearLastFailure(vehicleId);
      // Car is awake and responded — clear any stale sleep-confirmed cache
      if (vehicleForLiveCheck?.vin) {
        await this.rawRedis.del(`tesla:sleep-confirmed:vin:${vehicleForLiveCheck.vin}`).catch(() => {});
      }

      // Update vehicle state machine
      await this.stateMachine.updateVehicleState(vehicleId, vehicleData);

      // Create telemetry point from API data (normalized format)
      const telemetryPoint = normalizeTeslaPayload(vehicleData);

      // High-frequency ingestion через буфер (Redis → batched Timescale)
      await this.telemetryBuffer.addPoint(vehicleId, {
        ...telemetryPoint,
        timestamp: new Date(telemetryPoint.timestamp),
      });

      // Detect charging state transitions for backfill
      const currentChargingState = telemetryPoint.charging_state ?? '';
      const prevState = this.prevChargingState.get(vehicleId) ?? '';
      this.prevChargingState.set(vehicleId, currentChargingState);

      // When charging STARTS: attempt backfill to get real start time from Tesla billing
      if (currentChargingState === 'Charging' && prevState !== 'Charging' && this.chargingSync) {
        this.logger.debug(`Charging started for vehicle ${vehicleId} — triggering backfill`);
        this.chargingSync.backfillSessionStart(vehicleId, vehicle.vin, userId).catch(() => {});
      }

      this.logger.debug(`Telemetry fetched for vehicle ${vehicleId}`);
      return telemetryPoint;
    } catch (error: any) {
      const status = error?.response?.status ?? error?.status;
      if (status === 403) {
        // Tesla API billing limit hit — back off for 15 min, then resume.
        // Tesla Developer Portal already enforces the monthly billing limit via 403.
        // No app-level throttling needed beyond the backoff window.
        await this.redis.set(`tesla:ratelimit:${vehicleId}`, '1', 'EX', 900); // 15 min
        this.logger.warn(`Tesla API 403 for vehicle ${vehicleId} — backing off 15 min`);
        await this.setLastFailure(vehicleId, 'billing_scope_403', status);
      } else {
        await this.setLastFailure(vehicleId, 'timeout_or_network', status);
        this.logger.error(
          `Failed to fetch telemetry for vehicle ${vehicleId}: ${error.message}`,
        );
      }
      // Continue - don't throw to avoid stopping queue processing
      return null;
    }
  }

  /**
   * Hard timeout wrapper for any async Tesla call. Даже если HTTP-клиент
   * "залипнет", промис будет отклонён через ms миллисекунд.
   */
  private async withTimeout<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timeout after ${ms}ms`)),
        ms,
      );
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Start adaptive polling loop for a given vehicle.
   * Safe to call multiple times – subsequent calls will be ignored while a loop is active.
   */
  startAdaptivePolling(vehicleId: string, userId: string) {
    if (!isWorkerRole()) return;
    if (this.activeLoops.get(vehicleId)) {
      return;
    }

    this.logger.log(
      `Starting adaptive telemetry polling loop for vehicle ${vehicleId}`,
    );
    this.activeLoops.set(vehicleId, true);
    // fire-and-forget async loop
    void this.pollLoop(vehicleId, userId);
  }

  /**
   * Perform a single immediate poll and reset the idle timer.
   * Used by the wake-poll endpoint when the user opens the dashboard.
   */
  async pollOnce(vehicleId: string, userId: string): Promise<void> {
    // Reset idle timer so next scheduled poll uses active interval
    this.lastActivityMap.set(vehicleId, Date.now());
    // User-initiated refresh should aggressively bypass "fleet live/asleep" skips.
    await this.redis.set(`tesla:wake-hint:${vehicleId}`, '1', 'EX', 180).catch(() => null);
    // Drop cached status so frontend gets fresh state right after this call.
    await this.rawRedis.del(`vehicle:status:${vehicleId}`).catch(() => null);
    // Ensure adaptive loop is running after manual refresh.
    this.startAdaptivePolling(vehicleId, userId);
    // Do a short burst so wake-up transitions are actually captured.
    // 1st attempt immediately, then 2 retries with small gaps.
    for (let i = 0; i < 3; i++) {
      const point = await this.fetchVehicleTelemetry(vehicleId, userId, { bypassSlidingWindow: true });
      if (point) break;
      if (i < 2) await new Promise((r) => setTimeout(r, 4000));
    }
  }

  /**
   * Stop adaptive polling loop for a given vehicle.
   */
  stopAdaptivePolling(vehicleId: string) {
    if (this.activeLoops.has(vehicleId)) {
      this.logger.log(
        `Stopping adaptive telemetry polling loop for vehicle ${vehicleId}`,
      );
      this.activeLoops.delete(vehicleId);
    }
  }

  /**
   * Core adaptive polling loop.
   *
   * IMPORTANT: implemented as a self-scheduling async function instead of a tight
   * while(true) to avoid blocking the event loop and to keep stack traces readable.
   */
  private async pollLoop(vehicleId: string, userId: string): Promise<void> {
    if (!this.activeLoops.get(vehicleId)) {
      return;
    }

    let interval = 60_000; // default 1 min

    // Check if Tesla API is rate-limiting us — back off to avoid EXCEEDED_LIMIT
    const rateLimited = await this.redis.get(`tesla:ratelimit:${vehicleId}`).catch(() => null);
    if (rateLimited) {
      interval = 15 * 60_000; // 15 min while rate-limited
      this.logger.debug(`Vehicle ${vehicleId} rate-limited by Tesla — backoff 15 min`);
    }

    if (!rateLimited) try {
      // Pre-flight: resolve VIN + fleet-live status BEFORE any Tesla API call.
      // This lets us skip the getVehicleSummary call when the car is already known
      // to be sleeping and fleet telemetry is not streaming.
      const wakeHint = await this.redis.get(`tesla:wake-hint:${vehicleId}`).catch(() => null);
      const vehicleVin = (await this.prisma.vehicle.findUnique({
        where: { id: vehicleId }, select: { vin: true },
      }))?.vin;
      const fleetLive = vehicleVin
        ? await this.redis.get(`fleet:live:vin:${vehicleVin}`).catch(() => null)
        : null;

      // When car is sleeping and fleet telemetry is not streaming, skip REST poll entirely.
      // Fleet telemetry will push data as soon as the car wakes (door open, charging starts, etc.)
      // — no need to burn API quota checking a sleeping vehicle every 10-15 min.
      const prevState = !wakeHint && !fleetLive
        ? await this.stateMachine.getVehicleState(vehicleId)
        : null;

      if (!wakeHint && !fleetLive && prevState?.state === VehicleState.SLEEPING) {
        // ── Budget-Optimal Hazard Scheduling ─────────────────────────────
        // Instead of flat 60 min interval, use T*(t) = C/√λ̂(h,d).
        // This minimises expected detection delay under the API budget constraint.
        // Falls back to flat interval when TripPatternService has no data yet.
        interval = this.tripPattern
          ? await this.tripPattern.getSleepIntervalMs(vehicleId, new Date(), null)
          : 60 * 60_000;
        this.logger.debug(
          `Vehicle ${vehicleId} sleeping + fleet offline → REST skipped, ` +
          `next check in ${Math.round(interval / 60000)}min (hazard-scheduled)`,
        );
      } else {
        this.logger.debug(`Polling vehicle ${vehicleId}`);
        const telemetry = await this.fetchVehicleTelemetry(vehicleId, userId);

        const now = Date.now();
        // Initialize lastActivity to now on first poll to avoid false sleeping detection
        if (!this.lastActivityMap.has(vehicleId)) {
          this.lastActivityMap.set(vehicleId, now);
        }

        if (telemetry) {
          const speed = (telemetry as any).speedKmh ?? (telemetry as any).speed ?? 0;
          const chargingState: string =
            (telemetry as any).chargingState ??
            (telemetry as any).charging_state ?? '';

          if (speed > 2 || chargingState === 'Charging') {
            this.lastActivityMap.set(vehicleId, now);
          }

          // Feed SOC snapshot to TripPatternService for Vampire Drain Anomaly detection.
          // This is the primary source of SOC data during non-sleeping polls; the
          // anomaly detector uses it to identify pre-departure battery activity.
          const soc = (telemetry as any).soc ?? null;
          if (soc != null && this.tripPattern) {
            void this.tripPattern.recordSocSnapshot(vehicleId, soc, new Date()).catch(() => {});
          }
        }

        const idleMs = now - (this.lastActivityMap.get(vehicleId) ?? now);
        const state = await this.stateMachine.getVehicleState(vehicleId);

        if (wakeHint) {
          interval = 15_000;
          this.logger.debug(`Vehicle ${vehicleId} wake hint active — poll ${Math.round(interval / 1000)}s`);
        } else if (state.state === 'waking') {
          interval = 30_000;
          this.logger.debug(`Vehicle ${vehicleId} waking — poll ${Math.round(interval / 1000)}s`);
        } else if (fleetLive) {
          // MQTT fleet telemetry is streaming — fetchVehicleTelemetry returns null immediately (0 Daten).
          // Loop just needs to stay alive; 60 min is enough to detect if fleet goes silent.
          interval = 60 * 60_000;
          this.logger.debug(`Vehicle ${vehicleId} fleet live — REST suppressed, loop heartbeat ${Math.round(interval / 60000)}min`);
        } else if (state.state === 'driving') {
          interval = POLL_DRIVING_MS;
        } else if (state.state === 'charging') {
          // Charging is mostly handled by fleet stream; REST can be slower to save budget.
          interval = POLL_CHARGING_MS;
        } else if (state.state === VehicleState.SLEEPING) {
          // Car just transitioned to sleeping via REST poll — apply hazard scheduling.
          interval = this.tripPattern
            ? await this.tripPattern.getSleepIntervalMs(vehicleId, new Date(), null)
            : 60 * 60_000;
          this.logger.debug(`Vehicle ${vehicleId} sleeping — next REST check in ${Math.round(interval / 60000)}min`);
        } else if (idleMs > 3 * 60 * 60_000 && !fleetLive) {
          // Deep idle (3+ hrs no activity, fleet offline) — apply hazard scheduling
          // with the latest SOC for Vampire Drain Anomaly detection.
          const deepIdleSoc = telemetry ? ((telemetry as any).soc ?? null) : null;
          interval = this.tripPattern
            ? await this.tripPattern.getSleepIntervalMs(vehicleId, new Date(), deepIdleSoc)
            : 10 * 60_000;
          this.logger.debug(`Vehicle ${vehicleId} deep-idle ${Math.round(idleMs / 60000)}min → ${Math.round(interval / 60000)}min (hazard-scheduled)`);
        } else {
          // Parked without fleet live — use POLL_PARKED_MS (default 5 min).
          // Short interval means charging start is detected within ≤5 min instead of ≤30 min,
          // fixing the startSoc lag (19% → 63% issue).
          interval = POLL_PARKED_MS;
          this.logger.debug(`Vehicle ${vehicleId} idle ${Math.round(idleMs / 60000)}min → parked ${Math.round(interval / 60000)}min`);
        }
      }
    } catch (error: any) {
      this.logger.error(
        `Adaptive poll failed for vehicle ${vehicleId}: ${error.message}`,
      );
      interval = Math.max(interval, 300_000); // 5 min backoff on error
    }

    if (!this.activeLoops.get(vehicleId)) {
      return;
    }

    setTimeout(() => {
      if (!this.activeLoops.get(vehicleId)) {
        return;
      }
      void this.pollLoop(vehicleId, userId);
    }, interval);
  }

  /**
   * List vehicles for user to poll
   */
  async getVehiclesForPolling(userId: string): Promise<string[]> {
    try {
      const accessToken = await this.teslaOAuth.getValidAccessToken(userId);
      const vehicles = await this.teslaFleet.getVehicles(accessToken);

      return vehicles.map((v: any) => v.id.toString());
    } catch (error) {
      this.logger.error(
        `Failed to list vehicles for user ${userId}: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Estimate data usage for all vehicles
   */
  async estimateDataUsage(userId: string): Promise<{
    vehicleId: string;
    state: string;
    pointsPerDay: number;
  }[]> {
    try {
      const account = await this.prisma.teslaAccount.findUnique({ where: { userId } });
      if (!account) return [];
      const vehicles = await this.prisma.teslaVehicleLink.findMany({
        where: { teslaAccountId: account.id },
      });

      const usage = [];
      for (const vehicle of vehicles) {
        const state = await this.stateMachine.getVehicleState(
          vehicle.vehicleId,
        );
        usage.push({
          vehicleId: vehicle.vehicleId,
          state: state.state,
          pointsPerDay: this.stateMachine.estimateDailyDataPoints(state.state),
        });
      }

      return usage;
    } catch (error) {
      this.logger.error(`Failed to estimate data usage: ${error.message}`);
      return [];
    }
  }

  /**
   * Polling diagnostics — call from a debug endpoint to see why data is stale.
   * Returns circuit breaker state, active polling loops, and last seen timestamps.
   */
  async getPollingDiagnostics(userId: string): Promise<{
    circuitBreaker: { isOpen: boolean; openUntilMs: number };
    activeLoops: string[];
    vehicles: Array<{
      vehicleId: string;
      state: string;
      lastUpdateMs: number | null;
      staleSec: number | null;
      rateKeyRemainingMs: number | null;
    }>;
  }> {
    const cb = getCircuitBreakerStatus();
    const activeLoops = Array.from(this.activeLoops.keys());

    const account = await this.prisma.teslaAccount.findUnique({
      where: { userId },
      include: { vehicleLinks: { select: { vehicleId: true } } },
    });

    const vehicles: any[] = [];
    for (const link of account?.vehicleLinks ?? []) {
      const { vehicleId } = link;
      const state = await this.stateMachine.getVehicleState(vehicleId);
      // Sliding window: report how many calls are in the current window
      const swKey = `rate:sw:${vehicleId}`;
      const swCount = await this.rawRedis
        .zcount(swKey, Date.now() - SW_WINDOW_MS, '+inf')
        .catch(() => 0);
      const rateRemainingMs: number | null = swCount >= SW_MAX_CALLS ? SW_WINDOW_MS : null;

      const staleSec = state.lastUpdate
        ? Math.round((Date.now() - new Date(state.lastUpdate).getTime()) / 1000)
        : null;

      vehicles.push({
        vehicleId,
        state:              state.state,
        lastUpdateMs:       state.lastUpdate ? new Date(state.lastUpdate).getTime() : null,
        staleSec,
        rateKeyRemainingMs: rateRemainingMs,
      });
    }

    return { circuitBreaker: cb, activeLoops, vehicles };
  }
}
