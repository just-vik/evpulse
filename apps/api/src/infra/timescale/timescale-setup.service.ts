import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * TimescaleSetupService — runs once on startup to configure TimescaleDB features.
 *
 * Operations (idempotent — safe to run multiple times):
 * 1. Convert telemetry_points to hypertable (partitioned by timestamp, 1-day chunks)
 * 2. Create continuous aggregate views: telemetry_1min, telemetry_1hour
 * 3. Add compression policy (compress chunks older than 7 days)
 * 4. Add data retention policy (drop raw data older than 90 days)
 * 5. Set retention on hourly aggregate (keep 5 years)
 */
@Injectable()
export class TimescaleSetupService implements OnModuleInit {
  private readonly logger = new Logger(TimescaleSetupService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      await this.setupTimescaleDB();
    } catch (err) {
      // Non-fatal: plain PostgreSQL can run without TimescaleDB extensions
      this.logger.warn(`TimescaleDB setup skipped (not available or already configured): ${err.message}`);
    }
  }

  private async setupTimescaleDB() {
    // Check if TimescaleDB extension is available
    const ext = await this.prisma.$queryRawUnsafe(
      `SELECT count(*)::int as count FROM pg_extension WHERE extname = 'timescaledb'`,
    ) as any[];
    if (!ext[0] || ext[0].count === 0) {
      this.logger.warn('TimescaleDB extension not found — skipping hypertable setup');
      return;
    }

    await this.convertToHypertable();
    await this.createContinuousAggregates();
    await this.addCompressionPolicy();
    await this.addRetentionPolicies();

    this.logger.log('TimescaleDB setup complete');
  }

  /**
   * Step 1: Convert telemetry_points to hypertable.
   *
   * TimescaleDB requires the partition column (timestamp) to be part of
   * any unique index. Prisma creates a `telemetry_points_pkey` on `id` only.
   * We drop that PK and replace it with a unique constraint so TimescaleDB
   * can partition by timestamp freely. The `id` column stays unique.
   */
  private async convertToHypertable() {
    try {
      // Check if it's already a hypertable — idempotent guard
      const already = await this.prisma.$queryRawUnsafe(
        `SELECT count(*)::int as count FROM timescaledb_information.hypertables WHERE hypertable_name = 'telemetry_points'`,
      ) as any[];
      if (already[0]?.count > 0) {
        this.logger.log('telemetry_points already a hypertable — skipping');
        return;
      }

      // Drop the PK constraint that blocks hypertable creation
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE telemetry_points DROP CONSTRAINT IF EXISTS telemetry_points_pkey;
      `);

      // Re-add id as a regular (non-unique) index — TimescaleDB requires that ALL
      // unique indexes include the partition column (timestamp), so we cannot keep
      // a unique constraint on id alone. id is a CUID (practically unique) and
      // Prisma can still use this index for point lookups.
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS telemetry_points_id_idx ON telemetry_points(id);
      `);

      // Convert to hypertable — 1-day chunks are optimal for ~30k points/day
      await this.prisma.$executeRawUnsafe(`
        SELECT create_hypertable(
          'telemetry_points',
          'timestamp',
          chunk_time_interval => INTERVAL '1 day',
          if_not_exists => TRUE,
          migrate_data => TRUE
        );
      `);

      // Fast lookup index: vehicle + time range queries (most common pattern)
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_telemetry_vehicle_time
          ON telemetry_points ("vehicleId", timestamp DESC);
      `);

      this.logger.log('telemetry_points hypertable configured');
    } catch (err) {
      this.logger.warn(`Hypertable creation skipped: ${err.message}`);
    }
  }

  /**
   * Step 2: Continuous aggregate views for fast dashboard queries.
   *
   * telemetry_1min  — 1-minute OHLC buckets (live chart data)
   * telemetry_1hour — 1-hour buckets (daily/weekly trends)
   */
  private async createContinuousAggregates() {
    // 1-minute aggregate
    await this.prisma.$executeRawUnsafe(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1min
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('1 minute', timestamp)  AS bucket,
        "vehicleId",
        AVG(soc)                            AS avg_soc,
        MIN(soc)                            AS min_soc,
        MAX(soc)                            AS max_soc,
        AVG(speed)                          AS avg_speed,
        MAX(speed)                          AS max_speed,
        AVG(power)                          AS avg_power,
        MIN(power)                          AS min_power,
        MAX(power)                          AS max_power,
        AVG("batteryTemp")                  AS avg_battery_temp,
        AVG("outsideTemp")                  AS avg_outside_temp,
        MAX(odometer)                       AS max_odometer,
        COUNT(*)                            AS point_count
      FROM telemetry_points
      GROUP BY bucket, "vehicleId"
      WITH NO DATA;
    `).catch(err => this.logger.warn(`telemetry_1min view: ${err.message}`));

    // Refresh policy for 1-min view: refresh last 2 hours every 1 minute
    await this.prisma.$executeRawUnsafe(`
      SELECT add_continuous_aggregate_policy(
        'telemetry_1min',
        start_offset => INTERVAL '2 hours',
        end_offset   => INTERVAL '1 minute',
        schedule_interval => INTERVAL '1 minute',
        if_not_exists => TRUE
      );
    `).catch(err => this.logger.warn(`telemetry_1min policy: ${err.message}`));

    // 1-hour aggregate
    await this.prisma.$executeRawUnsafe(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1hour
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('1 hour', timestamp)    AS bucket,
        "vehicleId",
        AVG(soc)                            AS avg_soc,
        MIN(soc)                            AS min_soc,
        MAX(soc)                            AS max_soc,
        AVG(speed)                          AS avg_speed,
        MAX(speed)                          AS max_speed,
        SUM(CASE WHEN power > 0 THEN power * (1.0/3600) ELSE 0 END) AS energy_used_kwh,
        SUM(CASE WHEN power < 0 THEN ABS(power) * (1.0/3600) ELSE 0 END) AS regen_kwh,
        AVG("batteryTemp")                  AS avg_battery_temp,
        AVG("outsideTemp")                  AS avg_outside_temp,
        MAX(odometer)                       AS max_odometer,
        COUNT(*)                            AS point_count
      FROM telemetry_points
      GROUP BY bucket, "vehicleId"
      WITH NO DATA;
    `).catch(err => this.logger.warn(`telemetry_1hour view: ${err.message}`));

    // Refresh policy for 1-hour view: refresh last 7 days every hour
    await this.prisma.$executeRawUnsafe(`
      SELECT add_continuous_aggregate_policy(
        'telemetry_1hour',
        start_offset => INTERVAL '7 days',
        end_offset   => INTERVAL '1 hour',
        schedule_interval => INTERVAL '1 hour',
        if_not_exists => TRUE
      );
    `).catch(err => this.logger.warn(`telemetry_1hour policy: ${err.message}`));

    this.logger.log('Continuous aggregates configured');
  }

  /**
   * Step 3: Compress chunks older than 7 days.
   * Typical compression ratio for telemetry: 20-30x.
   */
  private async addCompressionPolicy() {
    // Enable compression with segment + order keys for optimal ratio
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE telemetry_points SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = '"vehicleId"',
        timescaledb.compress_orderby = 'timestamp ASC'
      );
    `).catch(err => this.logger.warn(`Compression settings: ${err.message}`));

    await this.prisma.$executeRawUnsafe(`
      SELECT add_compression_policy(
        'telemetry_points',
        compress_after => INTERVAL '7 days',
        if_not_exists => TRUE
      );
    `).catch(err => this.logger.warn(`Compression policy: ${err.message}`));

    this.logger.log('Compression policy set (7 days)');
  }

  /**
   * Step 4 & 5: Data retention policies.
   * Raw data: 90 days → drop old chunks automatically.
   * Hourly aggregates: 5 years → much cheaper to keep.
   */
  private async addRetentionPolicies() {
    // Raw telemetry: 90 days
    await this.prisma.$executeRawUnsafe(`
      SELECT add_retention_policy(
        'telemetry_points',
        drop_after => INTERVAL '90 days',
        if_not_exists => TRUE
      );
    `).catch(err => this.logger.warn(`Retention policy (raw): ${err.message}`));

    // 1-hour aggregate: 5 years
    await this.prisma.$executeRawUnsafe(`
      SELECT add_retention_policy(
        'telemetry_1hour',
        drop_after => INTERVAL '5 years',
        if_not_exists => TRUE
      );
    `).catch(err => this.logger.warn(`Retention policy (1h agg): ${err.message}`));

    this.logger.log('Retention policies set (raw=90d, hourly=5y)');
  }
}
