import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TeslaOAuthService } from '../tesla-fleet/tesla-oauth.service';
import { TeslaFleetService } from '../tesla-fleet/tesla-fleet.service';
import { RedisService } from '../redis/redis.service';

// Dedup window: same command on same vehicle blocked for 2 minutes (in-memory)
const DEDUP_WINDOW_MS = 2 * 60 * 1000;
// Hourly rate limit per vehicle
const HOURLY_LIMIT = 3;
// State lock TTL — prevents conflicting concurrent commands within same domain
const STATE_LOCK_TTL_S = 30;
// Circuit breaker: 5 failures in 60s → block for 120s
const FAIL_THRESHOLD = 5;
const FAIL_WINDOW_S = 60;
const BLOCK_DURATION_S = 120;
// Per-domain cooldowns (seconds)
const DOMAIN_COOLDOWN_S: Record<string, number> = {
  charging: 5 * 60,  // 5 minutes between charging domain commands
  climate:  2 * 60,  // 2 minutes between climate domain commands
  doors:    30,
  lights:   30,
};

// Group commands into domains — lock at domain level, not per-command.
// This prevents AI from issuing charge_start while charge_stop is in progress.
const COMMAND_DOMAIN: Record<string, string> = {
  charge_start:            'charging',
  charge_stop:             'charging',
  set_charge_limit:        'charging',
  auto_conditioning_start: 'climate',
  auto_conditioning_stop:  'climate',
  door_lock:               'doors',
  door_unlock:             'doors',
  flash_lights:            'lights',
  honk_horn:               'lights',
};

// Command → fleet service method mapping
const COMMAND_MAP: Record<string, (fleet: TeslaFleetService, teslaId: string, token: string) => Promise<any>> = {
  charge_stop:              (f, id, t) => f.stopCharging(id, t),
  charge_start:             (f, id, t) => f.startCharging(id, t),
  door_lock:                (f, id, t) => f.lockVehicle(id, t),
  door_unlock:              (f, id, t) => f.unlockVehicle(id, t),
  auto_conditioning_start:  (f, id, t) => f.startClimate(id, t),
  auto_conditioning_stop:   (f, id, t) => f.stopClimate(id, t),
  flash_lights:             (f, id, t) => f.flashLights(id, t),
  honk_horn:                (f, id, t) => f.honkHorn(id, t),
};

// HTTP status codes that are transient and worth retrying
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Retry with exponential backoff + jitter.
 * Returns result and the actual attempt count (for logging).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<{ result: T; attempts: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt + 1 };
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status ?? err?.status;
      if (!RETRYABLE_STATUS.has(status)) throw err; // non-retryable, fail fast
      if (attempt === maxAttempts - 1) break;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise(r => setTimeout(r, Math.round(delay)));
    }
  }
  throw lastErr;
}

@Injectable()
export class AIExecutorService {
  private readonly logger = new Logger(AIExecutorService.name);
  // In-memory dedup: vehicleId:command → last execution timestamp
  private readonly lastExecuted = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly teslaOAuth: TeslaOAuthService,
    private readonly teslaFleet: TeslaFleetService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Execute a Tesla command for a vehicle.
   *
   * Security + reliability pipeline (in order):
   *   1. Vehicle ownership — vehicleId must belong to userId
   *   2. Circuit breaker — skip if vehicle has too many recent failures
   *   3. Deduplication — same command blocked for 2 min (in-memory)
   *   4. Domain cooldown — per-domain cooldown (charging=5m, climate=2m)
   *   5. Domain state lock — Redis NX lock prevents concurrent conflicting commands
   *   6. Hourly rate limit — max 3 AI actions / hour per vehicle
   *   7. Vehicle-scoped token — resolved from vehicle's Tesla account link
   *   8. Execute with retry + exponential backoff
   *   9. Log to ai_action_logs with userId, source, duration, retryCount
   *
   * Steps 2/4/5/6 are fail-closed (P1.5a, Oct 2026): if Redis can't be reached
   * to evaluate one of these checks, the command is blocked — `{ executed:
   * false, reason: 'safety check unavailable: <check>' }` — never silently
   * treated as "check passed". Mirrors VehicleCommandThrottleGuard's existing
   * fail-closed contract for the human REST path. This method never throws
   * for an unavailable safety check — it returns the same typed result as
   * every other block reason, so callers (chatAndExecute, AIAgentService's
   * insight loop) don't need special-case error handling and one blocked
   * insight can't abort processing of the others.
   */
  async execute(
    vehicleId: string,
    userId: string,
    command: string,
    source: 'auto' | 'user' | 'chat' = 'auto',
  ): Promise<{ executed: boolean; reason?: string }> {
    const startTime = Date.now();

    // ── 1. Ownership check ────────────────────────────────────────────────────
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { userId: true },
    });
    if (!vehicle) {
      return { executed: false, reason: 'vehicle not found' };
    }
    if (vehicle.userId !== userId) {
      this.logger.warn(
        `[AI] Security: user ${userId} attempted command on vehicle ${vehicleId} (owner: ${vehicle.userId})`,
      );
      return { executed: false, reason: 'access denied' };
    }

    // ── 2. Circuit breaker check ──────────────────────────────────────────────
    // Fail-closed (Oct 2026, P1.5a): a Redis error here used to be treated as
    // "not blocked" and execution continued. Safety checks that can't be
    // evaluated must block, same as VehicleCommandThrottleGuard already does
    // for the human REST path — an unavailable Redis must not become a
    // bypass for AI-initiated vehicle commands specifically.
    try {
      const blocked = await this.redis.get(`ai:block:${vehicleId}`);
      if (blocked) {
        this.logger.warn(`[AI] Circuit breaker open for vehicle ${vehicleId} — skipping ${command}`);
        return { executed: false, reason: 'circuit breaker open' };
      }
    } catch (err: any) {
      this.logger.error(`[AI] Circuit breaker check failed (Redis error) — blocking ${command} on ${vehicleId}: ${err?.message}`);
      return { executed: false, reason: 'safety check unavailable: circuit breaker' };
    }

    // ── 3. In-memory dedup ────────────────────────────────────────────────────
    const dedupKey = `${vehicleId}:${command}`;
    const now = Date.now();
    const last = this.lastExecuted.get(dedupKey);
    if (last && now - last < DEDUP_WINDOW_MS) {
      const secsAgo = Math.round((now - last) / 1000);
      this.logger.debug(`Dedup block: ${command} (${secsAgo}s ago)`);
      return { executed: false, reason: `duplicate (${secsAgo}s ago)` };
    }

    // ── 4. Domain cooldown ────────────────────────────────────────────────────
    const domain = COMMAND_DOMAIN[command] ?? command;
    const cooldownS = DOMAIN_COOLDOWN_S[domain];
    if (cooldownS) {
      try {
        const cooldownKey = `ai:cooldown:${vehicleId}:${domain}`;
        const inCooldown = await this.redis.get(cooldownKey);
        if (inCooldown) {
          this.logger.debug(`Domain cooldown active: ${domain} on vehicle ${vehicleId}`);
          return { executed: false, reason: `${domain} cooldown active` };
        }
      } catch (err: any) {
        this.logger.error(`[AI] Domain cooldown check failed (Redis error) — blocking ${command} on ${vehicleId}: ${err?.message}`);
        return { executed: false, reason: 'safety check unavailable: domain cooldown' };
      }
    }

    // ── 5. Domain state lock (prevents race between AI and user) ─────────────
    const stateLockKey = `ai:state-lock:${vehicleId}:${domain}`;
    try {
      const locked = await this.redis.setIfNotExists(stateLockKey, STATE_LOCK_TTL_S);
      if (!locked) {
        this.logger.debug(`State lock active: ${domain} on vehicle ${vehicleId}`);
        return { executed: false, reason: `${domain} in progress` };
      }
    } catch (err: any) {
      this.logger.error(`[AI] State lock check failed (Redis error) — blocking ${command} on ${vehicleId}: ${err?.message}`);
      return { executed: false, reason: 'safety check unavailable: state lock' };
    }

    // ── 6. Hourly rate limit ──────────────────────────────────────────────────
    const rateLimitKey = `ai:hourly:${vehicleId}`;
    try {
      const current = (await this.redis.getNumber(rateLimitKey)) ?? 0;
      if (current >= HOURLY_LIMIT) {
        this.logger.warn(`Hourly rate limit hit for vehicle ${vehicleId} (${current}/${HOURLY_LIMIT})`);
        return { executed: false, reason: `hourly limit (${current}/${HOURLY_LIMIT})` };
      }
      await this.redis.set(rateLimitKey, String(current + 1), 'EX', 3600);
    } catch (err: any) {
      this.logger.error(`[AI] Hourly rate limit check failed (Redis error) — blocking ${command} on ${vehicleId}: ${err?.message}`);
      return { executed: false, reason: 'safety check unavailable: hourly rate limit' };
    }

    // ── 7. Vehicle-scoped token ───────────────────────────────────────────────
    let accessToken: string;
    let teslaVehicleId: string;
    try {
      // getTokenForVehicle verifies vehicle→account→userId chain — no cross-account leakage
      accessToken = await this.teslaOAuth.getTokenForVehicle(vehicleId, userId);
      const link = await this.prisma.teslaVehicleLink.findUnique({
        where: { vehicleId },
        select: { teslaVehicleId: true },
      });
      if (!link?.teslaVehicleId) {
        return { executed: false, reason: 'no Tesla vehicle link' };
      }
      teslaVehicleId = link.teslaVehicleId;
    } catch (err: any) {
      return { executed: false, reason: `token error: ${err?.message}` };
    }

    // ── 8. Execute with retry ─────────────────────────────────────────────────
    const fn = COMMAND_MAP[command];
    if (!fn) {
      return { executed: false, reason: `unknown command: ${command}` };
    }

    try {
      const { attempts } = await withRetry(
        () => fn(this.teslaFleet, teslaVehicleId, accessToken),
        3,
        1000,
      );

      const durationMs = Date.now() - startTime;
      this.lastExecuted.set(dedupKey, now);

      // Set domain cooldown AFTER successful execution
      if (cooldownS) {
        await this.redis.set(`ai:cooldown:${vehicleId}:${domain}`, '1', 'EX', cooldownS).catch(() => {});
      }

      // ── 9. Log success ──────────────────────────────────────────────────────
      await this.prisma.$executeRaw`
        INSERT INTO "ai_action_logs" ("id", "vehicleId", "userId", "action", "executedAt", "success", "source", "durationMs", "retryCount")
        VALUES (gen_random_uuid()::text, ${vehicleId}, ${userId}, ${command}, NOW(), true, ${source}, ${durationMs}, ${attempts - 1})
      `;

      this.logger.log(
        `[AI] executed ${command} on ${vehicleId} ` +
        `(user=${userId}, source=${source}, ${durationMs}ms, attempts=${attempts})`,
      );
      return { executed: true };
    } catch (err: any) {
      const errMsg = String(err?.message ?? err);
      const durationMs = Date.now() - startTime;

      await this.prisma.$executeRaw`
        INSERT INTO "ai_action_logs" ("id", "vehicleId", "userId", "action", "executedAt", "success", "error", "source", "durationMs")
        VALUES (gen_random_uuid()::text, ${vehicleId}, ${userId}, ${command}, NOW(), false, ${errMsg}, ${source}, ${durationMs})
      `;

      // Update circuit breaker failure counter
      try {
        const failKey = `ai:fail:${vehicleId}`;
        const failCount = ((await this.redis.getNumber(failKey)) ?? 0) + 1;
        if (failCount >= FAIL_THRESHOLD) {
          await this.redis.set(`ai:block:${vehicleId}`, '1', 'EX', BLOCK_DURATION_S);
          await this.redis.set(failKey, '0', 'EX', FAIL_WINDOW_S);
          this.logger.warn(`[AI] Circuit breaker opened for vehicle ${vehicleId}`);
        } else {
          await this.redis.set(failKey, String(failCount), 'EX', FAIL_WINDOW_S);
        }
      } catch {}

      this.logger.error(`[AI] ${command} failed on ${vehicleId}: ${errMsg}`);
      return { executed: false, reason: errMsg };
    }
  }

  async getRecentActions(vehicleId: string, limit = 10) {
    return this.prisma.$queryRaw<
      Array<{
        action: string;
        executedAt: Date;
        success: boolean;
        error: string | null;
      }>
    >`
      SELECT "action", "executedAt", "success", "error"
      FROM "ai_action_logs"
      WHERE "vehicleId" = ${vehicleId}
      ORDER BY "executedAt" DESC
      LIMIT ${limit}
    `;
  }
}
