-- Timescale Data Retention Policies for Tesla Analytics
-- 
-- Strategy:
-- - 7 days: raw telemetry (no compression) - real-time analysis
-- - 90 days: compressed telemetry - historical queries
-- - 2 years: heavily compressed aggregates - trend analysis
--
-- Compression reduces storage by ~90% with minimal query overhead
-- Auto-delete after retention period prevents unlimited database growth

-- Enable TimescaleDB extension if not already enabled
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ============================================================================
-- TELEMETRY POINTS - Real-time vehicle telemetry (most frequent data)
-- ============================================================================

-- Convert telemetry_points to hypertable if not already
SELECT create_hypertable('telemetry_points', 'timestamp', if_not_exists => TRUE);

-- Create compression policy: compress data older than 7 days
SELECT add_compression_policy('telemetry_points', INTERVAL '7 days', if_not_exists => TRUE);

-- Create retention policy: delete data older than 90 days
SELECT add_retention_policy('telemetry_points', INTERVAL '90 days', if_not_exists => TRUE);

-- Create index for queries by vehicle + time
CREATE INDEX IF NOT EXISTS idx_telemetry_vehicle_time 
  ON telemetry_points(vehicle_id, timestamp DESC);

-- ============================================================================
-- TELEMETRY EVENTS - State changes (lower frequency)
-- ============================================================================

-- Convert telemetry_events to hypertable if not already
SELECT create_hypertable('telemetry_events', 'timestamp', if_not_exists => TRUE);

-- Compress after 30 days
SELECT add_compression_policy('telemetry_events', INTERVAL '30 days', if_not_exists => TRUE);

-- Retain for 2 years
SELECT add_retention_policy('telemetry_events', INTERVAL '2 years', if_not_exists => TRUE);

-- ============================================================================
-- TRIP POINTS - GPS coordinates during trips
-- ============================================================================

-- Convert trip_points to hypertable if not already
SELECT create_hypertable('trip_points', 'timestamp', if_not_exists => TRUE);

-- Compress after 90 days
SELECT add_compression_policy('trip_points', INTERVAL '90 days', if_not_exists => TRUE);

-- Retain for 2 years (trips are lightweight, keep longer for history)
SELECT add_retention_policy('trip_points', INTERVAL '2 years', if_not_exists => TRUE);

-- ============================================================================
-- CHARGING POINTS - Detailed charging session data
-- ============================================================================

-- Convert charging_points to hypertable if not already
SELECT create_hypertable('charging_points', 'timestamp', if_not_exists => TRUE);

-- Compress after 60 days
SELECT add_compression_policy('charging_points', INTERVAL '60 days', if_not_exists => TRUE);

-- Retain for 1 year
SELECT add_retention_policy('charging_points', INTERVAL '1 year', if_not_exists => TRUE);

-- ============================================================================
-- VEHICLE LOCATIONS - GPS history
-- ============================================================================

-- Convert vehicle_locations to hypertable if not already
SELECT create_hypertable('vehicle_locations', 'timestamp', if_not_exists => TRUE);

-- Compress after 30 days
SELECT add_compression_policy('vehicle_locations', INTERVAL '30 days', if_not_exists => TRUE);

-- Retain for 6 months (useful for historical location tracking)
SELECT add_retention_policy('vehicle_locations', INTERVAL '6 months', if_not_exists => TRUE);

-- ============================================================================
-- BATTERY HEALTH - Health snapshots (daily, low frequency)
-- ============================================================================

-- Convert battery_health to hypertable if not already
SELECT create_hypertable('battery_health', 'timestamp', if_not_exists => TRUE);

-- Compress after 90 days (daily inserts, compress quickly)
SELECT add_compression_policy('battery_health', INTERVAL '90 days', if_not_exists => TRUE);

-- Retain for 5 years (long-term degradation tracking)
SELECT add_retention_policy('battery_health', INTERVAL '5 years', if_not_exists => TRUE);

-- Create index for vehicle + time queries
CREATE INDEX IF NOT EXISTS idx_battery_health_vehicle_time 
  ON battery_health(vehicle_id, timestamp DESC);

-- ============================================================================
-- AGGREGATION VIEWS - Pre-computed summaries for fast queries
-- ============================================================================

-- Summary: Daily telemetry averages per vehicle
-- Used for dashboard, trends, reports
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_telemetry_summary AS
SELECT
  vehicle_id,
  time_bucket('1 day', timestamp) as day,
  avg(soc) as avg_soc,
  max(soc) as max_soc,
  min(soc) as min_soc,
  avg(speed) as avg_speed,
  max(speed) as max_speed,
  avg(power) as avg_power,
  max(power) as max_power,
  count(*) as sample_count
FROM telemetry_points
GROUP BY vehicle_id, time_bucket('1 day', timestamp);

-- Index for fast queries
CREATE INDEX IF NOT EXISTS idx_daily_telemetry_vehicle_day 
  ON daily_telemetry_summary(vehicle_id, day DESC);

-- Compression policy for aggregates (very aggressive)
SELECT add_compression_policy('daily_telemetry_summary', INTERVAL '1 day', if_not_exists => TRUE);

-- Retain aggregates for 2 years
SELECT add_retention_policy('daily_telemetry_summary', INTERVAL '2 years', if_not_exists => TRUE);

-- ============================================================================
-- MONITORING - Show policy info
-- ============================================================================

-- Query to check all retention policies:
-- SELECT * FROM timescaledb_information.jobs WHERE hypertable_name IN (
--   'telemetry_points', 'telemetry_events', 'trip_points',
--   'charging_points', 'vehicle_locations', 'battery_health'
-- );

-- Query to check compression status:
-- SELECT * FROM timescaledb_information.compressed_hypertables;

-- Query storage of a table:
-- SELECT pg_size_pretty(pg_total_relation_size('telemetry_points'));
