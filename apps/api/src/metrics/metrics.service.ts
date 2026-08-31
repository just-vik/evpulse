import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
} from 'prom-client';

/**
 * MetricsService — Prometheus instrumentation.
 *
 * Scraped at GET /metrics (plain text, Prometheus format).
 * Add to Prometheus config:
 *   - job_name: 'evpulse'
 *     static_configs:
 *       - targets: ['api:3000']
 *     metrics_path: '/metrics'
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  // ── Telemetry ──────────────────────────────────────────────────────────────

  /** Total telemetry points received (before dedup) */
  readonly telemetryPointsReceived = new Counter({
    name: 'evpulse_telemetry_points_received_total',
    help: 'Total telemetry points received before dedup',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  /** Total telemetry points stored (after dedup + delta-filter) */
  readonly telemetryPointsStored = new Counter({
    name: 'evpulse_telemetry_points_stored_total',
    help: 'Total telemetry points written to TimescaleDB',
    labelNames: ['vehicleId'] as const,
    registers: [this.registry],
  });

  /** Points dropped by dedup stage (already seen hashes) */
  readonly telemetryPointsDedupDropped = new Counter({
    name: 'evpulse_telemetry_points_dedup_dropped_total',
    help: 'Telemetry points dropped by dedup stage',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  /** Points dropped by out-of-order guard (never sent to detectors / aggregated points) */
  readonly pipelineTelemetryOooDropped = new Counter({
    name: 'evpulse_pipeline_telemetry_ooo_dropped_total',
    help: 'Telemetry points dropped by pipeline out-of-order guard',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  /** Lag between Tesla vehicle timestamp and backend received time */
  readonly telemetryLagMs = new Histogram({
    name: 'evpulse_telemetry_lag_ms',
    help: 'Lag between vehicle telemetry timestamp and backend ingestion (ms)',
    buckets: [100, 500, 1000, 3000, 5000, 10000, 30000],
    registers: [this.registry],
  });

  /** Pipeline processing time per batch */
  readonly pipelineLatencyMs = new Histogram({
    name: 'evpulse_pipeline_latency_ms',
    help: 'Time to process a telemetry batch through the full pipeline (ms)',
    buckets: [10, 50, 100, 250, 500, 1000, 2000],
    registers: [this.registry],
  });

  // ── Tesla API ──────────────────────────────────────────────────────────────

  /** Total Tesla Fleet API HTTP requests by endpoint and status code */
  readonly teslaApiRequestsTotal = new Counter({
    name: 'evpulse_tesla_api_requests_total',
    help: 'Total Tesla Fleet API HTTP requests by endpoint and status code',
    labelNames: ['endpoint', 'status'] as const,
    registers: [this.registry],
  });

  /** Tesla API call failures (after all retries exhausted) */
  readonly teslaApiErrors = new Counter({
    name: 'evpulse_tesla_api_errors_total',
    help: 'Tesla API calls that failed after all retries',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });

  /** Current circuit breaker state (0 = CLOSED, 1 = OPEN) */
  readonly circuitBreakerOpen = new Gauge({
    name: 'evpulse_circuit_breaker_open',
    help: '1 if Tesla API circuit breaker is OPEN, 0 if CLOSED',
    registers: [this.registry],
  });

  // ── Vehicles ───────────────────────────────────────────────────────────────

  /** Vehicles currently tracked as OFFLINE (dataFreshnessSec > 300) */
  readonly vehiclesOffline = new Gauge({
    name: 'evpulse_vehicles_offline',
    help: 'Number of vehicles where last telemetry is > 5 minutes old',
    registers: [this.registry],
  });

  /** State transitions fired by TelemetryEventEngine */
  readonly stateTransitions = new Counter({
    name: 'evpulse_state_transitions_total',
    help: 'High-level vehicle state transitions (IDLE/DRIVING/CHARGING)',
    labelNames: ['from', 'to'] as const,
    registers: [this.registry],
  });

  // ── Trips & Charging ───────────────────────────────────────────────────────

  readonly tripsStarted = new Counter({
    name: 'evpulse_trips_started_total',
    help: 'Trips started',
    registers: [this.registry],
  });

  readonly tripsFinished = new Counter({
    name: 'evpulse_trips_finished_total',
    help: 'Trips finalised',
    registers: [this.registry],
  });

  readonly chargingSessionsStarted = new Counter({
    name: 'evpulse_charging_sessions_started_total',
    help: 'Charging sessions started',
    registers: [this.registry],
  });

  /** SoC% gap between first-detected startSoc and the real startSoc from Tesla billing backfill.
   * Positive value means our polling was late (detected charging N% into the session).
   * Target: < 5% after parked interval reduced to 5 min. */
  readonly chargingStartLagPct = new Histogram({
    name: 'evpulse_charging_start_lag_pct',
    help: 'SoC% gap between initially recorded startSoc and real startSoc corrected by Tesla billing backfill',
    buckets: [1, 2, 5, 10, 15, 20, 30, 40, 50],
    registers: [this.registry],
  });

  readonly detectorErrors = new Counter({
    name: 'evpulse_detector_errors_total',
    help: 'Errors in event engine / trip detector / charging detector',
    labelNames: ['detector'] as const,
    registers: [this.registry],
  });

  // ── Product / SLA Metrics ──────────────────────────────────────────────────

  /** Fraction of tracked vehicles with fresh data (freshness < 600s) */
  readonly vehicleOnlineRatio = new Gauge({
    name: 'evpulse_vehicle_online_ratio',
    help: 'Fraction of vehicles with data fresher than 600s (0.0–1.0)',
    registers: [this.registry],
  });

  /** Average data freshness across all tracked vehicles (seconds) */
  readonly avgDataFreshnessSec = new Gauge({
    name: 'evpulse_avg_data_freshness_sec',
    help: 'Mean telemetry freshness across all active vehicles (seconds)',
    registers: [this.registry],
  });

  /** Number of jobs currently sitting in the telemetry DLQ (Redis list length) */
  readonly dlqDepth = new Gauge({
    name: 'evpulse_dlq_depth',
    help: 'Current depth of dlq:telemetry Redis list (sampled after each push)',
    registers: [this.registry],
  });

  /** Total telemetry overflow pushes into the DLQ (monotonically increasing) */
  readonly dlqPushTotal = new Counter({
    name: 'evpulse_dlq_push_total',
    help: 'Total number of telemetry overflow payloads pushed to dlq:telemetry',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  /** Bull telemetry queue waiting depth */
  readonly queueDepth = new Gauge({
    name: 'evpulse_queue_depth',
    help: 'Number of jobs waiting in the telemetry queue',
    registers: [this.registry],
  });

  onModuleInit() {
    collectDefaultMetrics({ register: this.registry });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  async getDiagnosticsSnapshot() {
    const metrics = await this.registry.getMetricsAsJSON();
    const getCounter = (name: string): number => {
      const m = metrics.find((x: any) => x.name === name);
      if (!m?.values?.length) return 0;
      return m.values.reduce((sum: number, v: any) => sum + (Number(v.value) || 0), 0);
    };

    const pointsReceived = getCounter('evpulse_telemetry_points_received_total');
    const pointsStored = getCounter('evpulse_telemetry_points_stored_total');
    const dedupDropped = getCounter('evpulse_telemetry_points_dedup_dropped_total');
    const detectorErrors = getCounter('evpulse_detector_errors_total');

    const dedupDropRatePct = pointsReceived > 0
      ? +((dedupDropped / pointsReceived) * 100).toFixed(3)
      : 0;
    const detectorErrorRatePct = pointsStored > 0
      ? +((detectorErrors / pointsStored) * 100).toFixed(3)
      : 0;

    return {
      counters: { pointsReceived, pointsStored, dedupDropped, detectorErrors },
      rates: { dedupDropRatePct, detectorErrorRatePct },
    };
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
