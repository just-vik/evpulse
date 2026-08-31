import { Controller, Get, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './infra/redis.provider';
import { getCircuitBreakerStatus } from './tesla-fleet/tesla-http.config';
import { MetricsService } from './metrics/metrics.service';
import { TelemetryQueueService } from './queues/telemetry-queue.service';
import { getAppRole } from './runtime/runtime-role';

@Controller()
export class AppController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly metricsService: MetricsService,
    private readonly telemetryQueue: TelemetryQueueService,
  ) {}

  @Get()
  root() {
    return { status: 'ok', service: 'EVPulse API', docs: '/api/docs' };
  }

  /**
   * Unified health + readiness probe — production-grade aggregate.
   *
   * Returns a single JSON with all dependencies, computed data-quality signals,
   * and an `actions[]` array with actionable remediation steps.
   *
   * HTTP 200  → all critical services healthy
   * HTTP 503  → at least one critical service is down or data is stale
   *
   * Suitable as a Kubernetes readiness probe and as a first-look dashboard.
   */
  @Get('health')
  async health() {
    const [dbResult, redisResult, cbResult, schemaResult] = await Promise.allSettled([
      this._checkDb(),
      this._checkRedis(),
      Promise.resolve(getCircuitBreakerStatus()),
      this._checkSchema(),
    ]);

    const db = dbResult.status === 'fulfilled'
      ? dbResult.value
      : { status: 'error' as const, latencyMs: null, error: String((dbResult as any).reason) };

    const redis = redisResult.status === 'fulfilled'
      ? redisResult.value
      : { status: 'error' as const, latencyMs: null, dlqDepth: null, stuckRateLimitKeys: null, error: String((redisResult as any).reason) };

    const cb = cbResult.status === 'fulfilled' ? cbResult.value : { isOpen: false, openUntilMs: 0 };

    const tesla = {
      status: cb.isOpen ? 'degraded' as const : 'ok' as const,
      circuitBreaker: {
        isOpen: cb.isOpen,
        openUntil: cb.openUntilMs ? new Date(cb.openUntilMs).toISOString() : null,
      },
    };

    // ── Structured actionable recommendations ─────────────────────────────
    //
    // Each action describes WHAT is wrong, WHERE to fix it, and HOW urgent.
    // The HealthRecoveryService auto-executes most of these every 60s,
    // but they are surfaced here for Kubernetes probes / ops dashboards.
    //
    const actions: Array<{
      type:        string;
      description: string;
      endpoint?:   string;
      method?:     string;
      severity:    'info' | 'warn' | 'critical';
      autoHealed:  boolean;
    }> = [];

    if (db.status !== 'ok') {
      actions.push({
        type: 'DB_UNREACHABLE',
        description: 'PostgreSQL is not responding. All writes are failing.',
        severity: 'critical',
        autoHealed: false,
      });
    }

    if (redis.status !== 'ok') {
      actions.push({
        type: 'REDIS_UNREACHABLE',
        description: 'Redis is not responding. Rate limiting, caching, and queues are broken.',
        severity: 'critical',
        autoHealed: false,
      });
    }

    if (cb.isOpen) {
      actions.push({
        type: 'TESLA_CIRCUIT_OPEN',
        description: `Tesla API is blocked until ${tesla.circuitBreaker.openUntil}. All REST polling paused.`,
        severity: 'critical',
        autoHealed: true, // circuit resets automatically after 60s
      });
    }

    if ((redis.dlqDepth ?? 0) >= 100) {
      actions.push({
        type: 'DLQ_CRITICAL',
        description: `DLQ has ${redis.dlqDepth} failed jobs. Pipeline may be broken. Auto-replay running every 2 min.`,
        endpoint: '/api/v1/vehicles/debug/dlq',
        method: 'GET',
        severity: 'critical',
        autoHealed: true,
      });
    } else if ((redis.dlqDepth ?? 0) >= 50) {
      actions.push({
        type: 'DLQ_WARNING',
        description: `DLQ has ${redis.dlqDepth} failed jobs. Auto-replay is recovering them.`,
        endpoint: '/api/v1/vehicles/debug/dlq',
        method: 'GET',
        severity: 'warn',
        autoHealed: true,
      });
    }

    const staleCheckNeeded = !cb.isOpen && db.status === 'ok';
    if (staleCheckNeeded) {
      actions.push({
        type: 'RESET_POLLING_AVAILABLE',
        description: 'If vehicle data is stale, HealthRecoveryService auto-restarts loops every 5 min. Manual override available.',
        endpoint: '/api/v1/vehicles/debug/reset-polling',
        method: 'POST',
        severity: 'info',
        autoHealed: true,
      });
    }

    // Schema drift check
    const schemaChecks = schemaResult.status === 'fulfilled' ? schemaResult.value : [];
    const schemaDrift  = schemaChecks.filter(c => !c.ok);
    if (schemaDrift.length > 0) {
      actions.push({
        type: 'DB_SCHEMA_MISMATCH',
        description: `Schema drift detected: ${schemaDrift.map(c => c.name).join(', ')}. ` +
          `Run: docker exec evpulse-api npx prisma migrate deploy && /health/schema for details.`,
        endpoint: '/health/schema',
        method: 'GET',
        severity: 'critical' as const,
        autoHealed: false,
      });
    }

    const overallHealthy =
      db.status === 'ok' &&
      redis.status === 'ok' &&
      !cb.isOpen &&
      schemaDrift.length === 0;

    const response = {
      status: overallHealthy ? ('ok' as const) : ('degraded' as const),
      services: { db, redis, tesla, schema: { ok: schemaDrift.length === 0, driftedItems: schemaDrift.map(c => c.name) } },
      actions,
      uptime:    Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };

    if (!overallHealthy) {
      throw new HttpException(response, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return response;
  }

  private async _checkDb() {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' as const, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { status: 'error' as const, latencyMs: Date.now() - start, error: e.message };
    }
  }

  private async _checkRedis() {
    const start = Date.now();
    try {
      await this.redis.ping();
      const latencyMs = Date.now() - start;

      const [dlqDepth, stuckKeys] = await Promise.all([
        this.redis.llen('dlq:jobs:telemetry'),
        this.redis.keys('rate:sw:*').then((k: string[]) => k.length).catch(() => 0),
      ]);

      return {
        status: 'ok' as const,
        latencyMs,
        dlqDepth,
        stuckRateLimitKeys: 0, // sliding window has no stuck keys by design
        activeRateBuckets: stuckKeys,
      };
    } catch (e: any) {
      return { status: 'error' as const, latencyMs: Date.now() - start, dlqDepth: null, stuckRateLimitKeys: null, error: e.message };
    }
  }

  /**
   * GET /health/redis
   * Detailed Redis check: ping latency, DLQ depth, stuck rate-limit key count.
   */
  @Get('health/redis')
  async healthRedis() {
    const start = Date.now();
    try {
      await this.redis.ping();
      const latencyMs = Date.now() - start;

      const [dlqDepth, rateKeys] = await Promise.all([
        this.redis.llen('dlq:jobs:telemetry'),
        this.redis.keys('tesla:req:*'),
      ]);

      return {
        status: 'ok',
        latencyMs,
        dlqDepth,
        stuckRateLimitKeys: rateKeys.length,
        rateKeys,
      };
    } catch (e: any) {
      throw new HttpException(
        { status: 'error', error: e.message },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * GET /health/db
   * Checks PostgreSQL connectivity and measures query latency.
   */
  @Get('health/db')
  async healthDb() {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (e: any) {
      throw new HttpException(
        { status: 'error', latencyMs: Date.now() - start, error: e.message },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * GET /health/tesla
   * Reports Tesla Fleet API circuit-breaker state.
   * isOpen = true means all REST polling is blocked until openUntil.
   */
  @Get('health/tesla')
  async healthTesla() {
    const cb = getCircuitBreakerStatus();
    return {
      status: cb.isOpen ? 'degraded' : 'ok',
      circuitBreaker: {
        isOpen: cb.isOpen,
        openUntilMs: cb.openUntilMs,
        openUntil: cb.openUntilMs ? new Date(cb.openUntilMs).toISOString() : null,
      },
      note: cb.isOpen
        ? `Tesla API blocked until ${new Date(cb.openUntilMs).toISOString()} — wait or restart api container`
        : 'Tesla API reachable',
    };
  }

  /**
   * GET /health/schema
   *
   * Checks for critical column/table presence that might diverge between
   * Prisma schema and the live database (migration drift detection).
   *
   * Required columns checked:
   *   - vehicle_states.version       — optimistic locking
   *   - telemetry_raw (table)        — event store
   *   - telemetry_points.timestamp   — primary hypertable column
   *
   * Returns 200 with drift details, or 503 if critical columns are missing.
   */
  @Get('health/schema')
  async healthSchema() {
    const checks = await this._checkSchema();
    const drifted = checks.filter(c => !c.ok);

    const response = {
      status: drifted.length === 0 ? 'ok' as const : 'drift' as const,
      checks,
      driftedItems: drifted.map(c => c.name),
    };

    if (drifted.length > 0) {
      throw new HttpException(response, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return response;
  }

  private async _checkSchema(): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

    // 1. vehicle_states.version column (optimistic locking)
    try {
      const rows = await this.prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'vehicle_states' AND column_name = 'version'
      `;
      checks.push({ name: 'vehicle_states.version', ok: rows.length > 0 });
    } catch (e: any) {
      checks.push({ name: 'vehicle_states.version', ok: false, detail: e.message });
    }

    // 2. telemetry_raw table
    try {
      const rows = await this.prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'telemetry_raw'
      `;
      checks.push({ name: 'telemetry_raw (table)', ok: rows.length > 0 });
    } catch (e: any) {
      checks.push({ name: 'telemetry_raw (table)', ok: false, detail: e.message });
    }

    // 3. telemetry_points is a TimescaleDB hypertable
    try {
      const rows = await this.prisma.$queryRaw<{ hypertable_name: string }[]>`
        SELECT hypertable_name FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'telemetry_points'
      `;
      checks.push({ name: 'telemetry_points (hypertable)', ok: rows.length > 0 });
    } catch (e: any) {
      // timescaledb_information view absent → extension not loaded
      checks.push({ name: 'telemetry_points (hypertable)', ok: false, detail: e.message });
    }

    // 4. telemetry_raw is a hypertable
    try {
      const rows = await this.prisma.$queryRaw<{ hypertable_name: string }[]>`
        SELECT hypertable_name FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'telemetry_raw'
      `;
      checks.push({ name: 'telemetry_raw (hypertable)', ok: rows.length > 0 });
    } catch (e: any) {
      checks.push({ name: 'telemetry_raw (hypertable)', ok: false, detail: e.message });
    }

    return checks;
  }

  /**
   * Runtime diagnostics for admin UI.
   * Includes role, queue depth and detector/dedup rates.
   */
  @Get('runtime/diagnostics')
  async runtimeDiagnostics() {
    const [diag, queueDepth] = await Promise.all([
      this.metricsService.getDiagnosticsSnapshot(),
      this.telemetryQueue.getQueueDepth().catch(() => -1),
    ]);

    return {
      appRole: getAppRole(),
      queueDepth,
      ...diag,
      timestamp: new Date().toISOString(),
    };
  }
}
