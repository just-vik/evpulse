import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as tls from 'tls';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryFetcherService } from './telemetry-fetcher.service';
import { getCircuitBreakerStatus } from './tesla-http.config';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { isWorkerRole } from '../runtime/runtime-role';

// ─── Alert severity ───────────────────────────────────────────────────────────

enum AlertSeverity {
  INFO     = 'ℹ️',
  WARN     = '⚠️',
  CRITICAL = '🚨',
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const DLQ_WARN_THRESHOLD  = 50;
const DLQ_CRIT_THRESHOLD  = 100;
const STUCK_KEYS_ALERT    = 10;
/** Alert if fleet-telemetry cert expires within this many days */
const CERT_WARN_DAYS      = 14;
/** Alert if a non-sleeping vehicle has zero telemetry_points rows for this long */
const TELEMETRY_GAP_HOURS = 2;
const FLEET_TELEMETRY_HOST = 'tesla-fleet-telemetry';
const FLEET_TELEMETRY_PORT = 443;
/**
 * Per-state stale thresholds (seconds).
 * Charging: Tesla can be silent for 5-6 min between updates — use 10 min.
 * Sleeping: BOHSP controls intervals up to 90 min — never restart from here.
 * Default: 6 min for idle/unknown states.
 */
const STALE_THRESHOLDS: Partial<Record<string, number>> = {
  driving:  180,   // 3 min  — should stream constantly
  charging: 600,   // 10 min — Tesla silent during stable charge phases
  idle:     360,   // 6 min
  sleeping: 5400,  // 90 min — BOHSP manages this, leave it alone
};
const STALE_RESTART_SEC_DEFAULT = 360; // 6 min fallback for unknown states
/** Minimum gap between two consecutive loop restarts for the same vehicle */
const ANTI_THRASH_MS      = 5 * 60_000; // 5 minutes
/** Suppress repeated identical ops alerts within this window */
const ALERT_COOLDOWN_MS   = 15 * 60_000; // 15 minutes

/**
 * HealthRecoveryService — proactive self-healing cron.
 *
 * Every 60 seconds runs these checks in parallel:
 *
 *  1. checkRedisLocks         — removes stuck rate-limit keys (TTL absent / > 60s)
 *  2. checkDlq                — alerts on DLQ overflow with TREND detection:
 *                               "DLQ growing: 50 → 80 (+30 in 1 min)"
 *  3. checkStaleness          — restarts adaptive polling loops for vehicles with
 *                               no fresh data, with anti-thrashing guard
 *  4. checkTelemetryFreshness — alerts if a non-sleeping vehicle has zero rows in
 *                               telemetry_points for TELEMETRY_GAP_HOURS (2h)
 *  5. checkCertExpiry         — TLS connects to fleet-telemetry:443 once/hour;
 *                               alerts WARN at ≤14d to expiry, CRITICAL if expired
 *                               or container unreachable
 *
 * Alert levels:  INFO / WARN / CRITICAL (Telegram via TELEGRAM_OPS_CHAT_ID)
 * Deduplication: same alert key suppressed for ALERT_COOLDOWN_MS (15 min)
 * Trend:         DLQ depth compared between consecutive cron runs
 */
@Injectable()
export class HealthRecoveryService {
  private readonly logger = new Logger(HealthRecoveryService.name);

  /** Per-alert-key cooldown timestamps */
  private readonly alertedAt = new Map<string, number>();

  /** Previous DLQ depth — for trend / rate-of-change detection */
  private prevDlqDepth = 0;

  /** Per-vehicle: timestamp of last polling loop restart — anti-thrashing */
  private readonly lastRestartAt = new Map<string, number>();

  /** Timestamp of last cert check — run once per hour, not every 60s */
  private lastCertCheckAt = 0;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly telemetryFetcher: TelemetryFetcherService,
  ) {}

  @Cron('*/1 * * * *') // every 60 seconds
  async autoHeal(): Promise<void> {
    if (!isWorkerRole()) return;

    const checks: Promise<void>[] = [
      this.checkRedisLocks(),
      this.checkDlq(),
      this.checkStaleness(),
      this.checkTelemetryFreshness(),
    ];

    // Cert check: TLS handshake is cheap but no need to run every minute;
    // once per hour is enough given sendOpsAlert already deduplicates at 15 min.
    if (Date.now() - this.lastCertCheckAt > 60 * 60 * 1000) {
      this.lastCertCheckAt = Date.now();
      checks.push(this.checkCertExpiry());
    }

    await Promise.all(checks);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Stuck Redis rate-limit keys
  // ─────────────────────────────────────────────────────────────────────────

  private async checkRedisLocks(): Promise<void> {
    try {
      // Legacy tesla:req:* keys (old TTL-based rate limiter) — should no longer appear
      // but we keep the check for safety during the transition period
      const legacyKeys = await this.redis.keys('tesla:req:*');
      if (legacyKeys.length > 0) {
        await this.redis.del(...legacyKeys);
        this.logger.warn(
          `[AutoHeal] Removed ${legacyKeys.length} legacy rate-limit key(s)`,
        );
      }

      // Sliding-window keys (rate:sw:*) don't get "stuck" but we still
      // alert if an unusually high number accumulates (e.g. Redis mem issue)
      const swKeys = await this.redis.keys('rate:sw:*');

      if (swKeys.length >= STUCK_KEYS_ALERT) {
        await this.sendOpsAlert(
          AlertSeverity.WARN,
          'stuckKeys',
          `Polling rate buckets: ${swKeys.length} active (≥ ${STUCK_KEYS_ALERT} is unusual). ` +
          `Legacy stuck keys removed: ${legacyKeys.length}.`,
        );
      }
    } catch (e: any) {
      this.logger.error(`[AutoHeal] checkRedisLocks error: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. DLQ overflow + trend detection
  // ─────────────────────────────────────────────────────────────────────────

  private async checkDlq(): Promise<void> {
    try {
      const depth  = await this.redis.llen('dlq:jobs:telemetry');
      const growth = depth - this.prevDlqDepth;
      const prev   = this.prevDlqDepth;
      this.prevDlqDepth = depth;

      if (depth === 0) return;

      // Trend alert — independent of absolute threshold
      if (growth >= 20 && prev > 0) {
        await this.sendOpsAlert(
          AlertSeverity.WARN,
          'dlqGrowth',
          `DLQ growing: ${prev} → ${depth} (+${growth} in ~1 min). Pipeline is failing faster than replay.`,
        );
      }

      // Absolute threshold alerts
      if (depth >= DLQ_CRIT_THRESHOLD) {
        this.logger.error(`[AutoHeal] DLQ CRITICAL: ${depth} failed jobs`);
        await this.sendOpsAlert(
          AlertSeverity.CRITICAL,
          'dlqCrit',
          `DLQ CRITICAL: ${depth} failed telemetry jobs. Replay may be unable to keep up — pipeline likely broken.`,
        );
      } else if (depth >= DLQ_WARN_THRESHOLD) {
        this.logger.warn(`[AutoHeal] DLQ WARNING: ${depth} failed jobs`);
        await this.sendOpsAlert(
          AlertSeverity.WARN,
          'dlqWarn',
          `DLQ WARNING: ${depth} failed telemetry jobs accumulating.`,
        );
      }

      // Log permanent failure queue depth
      const permDepth = await this.redis.llen('dlq:permanent:telemetry').catch(() => 0);
      if (permDepth > 0) {
        this.logger.warn(`[AutoHeal] Permanent failure queue: ${permDepth} unrecoverable jobs`);
      }
    } catch (e: any) {
      this.logger.error(`[AutoHeal] checkDlq error: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Staleness → auto-restart polling loops (with anti-thrashing)
  // ─────────────────────────────────────────────────────────────────────────

  private async checkStaleness(): Promise<void> {
    const cb = getCircuitBreakerStatus();
    if (cb.isOpen) {
      this.logger.debug('[AutoHeal] Skipping staleness check — circuit breaker OPEN');
      await this.sendOpsAlert(
        AlertSeverity.CRITICAL,
        'cbOpen',
        `Tesla API circuit breaker OPEN until ${new Date(cb.openUntilMs).toISOString()}. All REST polling paused.`,
      );
      return;
    }

    try {
      const accounts = await this.prisma.teslaAccount.findMany({
        include: {
          vehicleLinks: {
            include: { vehicle: { select: { id: true, teslaId: true, vin: true } } },
          },
        },
      });

      for (const account of accounts) {
        for (const link of account.vehicleLinks) {
          if (!link.vehicle.teslaId) continue;
          const vehicleId = link.vehicle.id;

          // Skip if MQTT fleet telemetry is actively streaming — REST is a fallback
          if (link.vehicle.vin) {
            const mqttLive = await this.redis.get(`fleet:live:vin:${link.vehicle.vin}`);
            if (mqttLive) {
              this.logger.debug(
                `[AutoHeal] Vehicle ${vehicleId} MQTT live — skipping REST restart`,
              );
              continue;
            }
          }

          const state = await this.prisma.vehicleState.findUnique({
            where: { vehicleId },
            select: { lastUpdate: true, state: true },
          });

          if (!state?.lastUpdate) continue;

          const staleSec = Math.round(
            (Date.now() - new Date(state.lastUpdate).getTime()) / 1000,
          );

          const staleThreshold = STALE_THRESHOLDS[state.state ?? ''] ?? STALE_RESTART_SEC_DEFAULT;
          if (staleSec <= staleThreshold) continue;

          // ── Anti-thrashing guard ──────────────────────────────────────────
          // If we already restarted this loop in the last ANTI_THRASH_MS,
          // skip — a fast restart/fail/restart cycle wastes Tesla API quota
          // and may indicate a deeper problem (invalid token, vehicle offline).
          const lastRestart = this.lastRestartAt.get(vehicleId) ?? 0;
          const timeSinceRestart = Date.now() - lastRestart;

          if (timeSinceRestart < ANTI_THRASH_MS) {
            this.logger.debug(
              `[AutoHeal] Vehicle ${vehicleId} stale ${staleSec}s but restart suppressed ` +
              `(last restart ${Math.round(timeSinceRestart / 1000)}s ago, anti-thrash: ${ANTI_THRASH_MS / 1000}s)`,
            );
            continue;
          }

          // ── Restart ───────────────────────────────────────────────────────
          this.logger.warn(
            `[AutoHeal] Vehicle ${vehicleId} stale ${staleSec}s (state=${state.state}) — restarting polling loop`,
          );
          this.lastRestartAt.set(vehicleId, Date.now());
          this.telemetryFetcher.stopAdaptivePolling(vehicleId);
          this.telemetryFetcher.startAdaptivePolling(vehicleId, account.userId);
        }
      }
    } catch (e: any) {
      this.logger.error(`[AutoHeal] checkStaleness error: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. fleet-telemetry TLS cert expiry
  // ─────────────────────────────────────────────────────────────────────────

  private async checkCertExpiry(): Promise<void> {
    try {
      const { daysLeft, expiry } = await new Promise<{ daysLeft: number; expiry: Date }>(
        (resolve, reject) => {
          const socket = tls.connect(
            {
              host: FLEET_TELEMETRY_HOST,
              port: FLEET_TELEMETRY_PORT,
              rejectUnauthorized: false, // intentional: check cert data even if expired
            },
            () => {
              const cert = socket.getPeerCertificate();
              socket.destroy();
              if (!cert?.valid_to) return reject(new Error('No certificate returned'));
              const expiry = new Date(cert.valid_to);
              const daysLeft = Math.floor((expiry.getTime() - Date.now()) / 86_400_000);
              resolve({ daysLeft, expiry });
            },
          );
          socket.on('error', reject);
          socket.setTimeout(5_000, () => {
            socket.destroy();
            reject(new Error('TLS connect timeout after 5s'));
          });
        },
      );

      const expiryStr = expiry.toISOString().slice(0, 10);
      if (daysLeft <= 0) {
        await this.sendOpsAlert(
          AlertSeverity.CRITICAL,
          'certExpired',
          `fleet-telemetry TLS cert EXPIRED ${Math.abs(daysLeft)}d ago (${expiryStr}). ` +
          `Tesla vehicles cannot connect. Run: sudo certbot renew --cert-name telemetry.evpulse.app --force-renewal`,
        );
      } else if (daysLeft <= CERT_WARN_DAYS) {
        await this.sendOpsAlert(
          AlertSeverity.WARN,
          'certExpiring',
          `fleet-telemetry TLS cert expires in ${daysLeft}d (${expiryStr}). ` +
          `certbot should auto-renew — check /etc/letsencrypt/renewal-hooks/deploy/ hook is installed.`,
        );
      }
    } catch (e: any) {
      // ECONNREFUSED = fleet-telemetry container is down; ETIMEDOUT = network issue
      await this.sendOpsAlert(
        AlertSeverity.CRITICAL,
        'certUnreachable',
        `fleet-telemetry not reachable at ${FLEET_TELEMETRY_HOST}:${FLEET_TELEMETRY_PORT}: ${e.message}. Container may be down.`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Telemetry data freshness — detects silent push/poll failures
  // ─────────────────────────────────────────────────────────────────────────

  private async checkTelemetryFreshness(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - TELEMETRY_GAP_HOURS * 3_600_000);

      // Vehicles that REST polling sees as awake (not sleeping/offline) AND
      // whose state was updated within the gap window (i.e. system sees them)
      const awakeVehicles = await this.prisma.vehicleState.findMany({
        where: {
          state: { notIn: ['sleeping', 'offline', 'sleep'] },
          lastUpdate: { gte: cutoff },
        },
        select: { vehicleId: true, state: true },
      });

      for (const vs of awakeVehicles) {
        const count = await this.prisma.telemetryPoint.count({
          where: { vehicleId: vs.vehicleId, timestamp: { gte: cutoff } },
        });

        if (count === 0) {
          await this.sendOpsAlert(
            AlertSeverity.WARN,
            `telemetryGap:${vs.vehicleId}`,
            `No telemetry_points for vehicle ${vs.vehicleId} in ${TELEMETRY_GAP_HOURS}h (state=${vs.state}). ` +
            `fleet-telemetry push and/or REST polling may be broken.`,
          );
        }
      }
    } catch (e: any) {
      this.logger.error(`[AutoHeal] checkTelemetryFreshness error: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ops alerting — direct Telegram HTTP, no per-user setup required
  // ─────────────────────────────────────────────────────────────────────────

  private async sendOpsAlert(
    severity: AlertSeverity,
    key: string,
    message: string,
  ): Promise<void> {
    const now  = Date.now();
    const last = this.alertedAt.get(key) ?? 0;
    if (now - last < ALERT_COOLDOWN_MS) return; // deduplicate within cooldown window
    this.alertedAt.set(key, now);

    const text = `${severity} *EVPulse Ops Alert*\n\n${message}\n\n_${new Date().toISOString()}_`;
    this.logger.warn(`[OpsAlert] ${severity} ${key}: ${message}`);

    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_OPS_CHAT_ID;
    if (!token || !chatId) return;

    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      });
    } catch (e: any) {
      this.logger.debug(`[OpsAlert] Telegram delivery failed: ${e.message}`);
    }
  }
}
