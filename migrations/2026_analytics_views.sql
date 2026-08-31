-- ============================================================================
-- EVPulse Analytics Views & Timescale Hypertable
-- Applied manually on initial deployment (not a Prisma migration).
-- Safe to re-run — all statements use IF NOT EXISTS / IF EXISTS guards.
--
-- Column naming: Prisma stores camelCase as quoted identifiers in Postgres
-- ("vehicleId", "startTime", "distanceKm", "energyUsedKwh").
-- Output aliases are snake_case to match the indexes already in place.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- MATERIALIZED VIEW: vehicle_daily_stats
-- Aggregates trip data per vehicle per calendar day.
-- Output columns: vehicle_id, day, distance_km, energy_kwh
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS vehicle_daily_stats AS
SELECT
  "vehicleId"                              AS vehicle_id,
  date_trunc('day', "startTime")           AS day,
  SUM("distanceKm")                        AS distance_km,
  SUM("energyUsedKwh")                     AS energy_kwh
FROM trips
GROUP BY
  "vehicleId",
  date_trunc('day', "startTime");


-- INDEXES FOR vehicle_daily_stats

CREATE INDEX IF NOT EXISTS idx_vehicle_daily_stats
ON vehicle_daily_stats(vehicle_id, day DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_daily_stats_unique
ON vehicle_daily_stats(vehicle_id, day);


-- INITIAL REFRESH (non-concurrent is fine for first run)

REFRESH MATERIALIZED VIEW vehicle_daily_stats;


-- ============================================================================
-- TELEMETRY HYPERTABLE (TimescaleDB)
-- telemetry_points is already created by Prisma migrations.
-- This promotes it to a TimescaleDB hypertable for time-series optimisation.
-- ============================================================================

SELECT create_hypertable(
  'telemetry_points',
  'timestamp',
  if_not_exists => TRUE
);

-- Composite index for per-vehicle time-range queries (most common access pattern).
-- Note: Prisma migrations create "telemetry_points_vehicleId_timestamp_idx"
-- automatically. This index is a named alias kept for operational clarity.
CREATE INDEX IF NOT EXISTS idx_telemetry_vehicle_time
ON telemetry_points("vehicleId", "timestamp" DESC);

-- Deduplication: one point per (vehicleId, timestamp) to prevent streaming duplicates.
-- Prisma enforces this via @@unique([vehicleId, timestamp]) → unique index below.
-- The IF NOT EXISTS guard makes this a no-op if Prisma already created it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_unique
ON telemetry_points("vehicleId", "timestamp");

-- Retention policy: keep raw telemetry for 90 days (matches TimescaleSetupService).
-- TimescaleSetupService.onModuleInit() calls add_retention_policy on startup,
-- so this is a fallback for environments where the API has not yet run once.
SELECT add_retention_policy(
  'telemetry_points',
  INTERVAL '90 days',
  if_not_exists => TRUE
);
