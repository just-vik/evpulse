-- Initialize TimescaleDB for Tesla Telemetry
-- 
-- This migration:
-- 1. Enables TimescaleDB extension
-- 2. Converts existing tables to hypertables
-- 3. Creates retention and compression policies
-- 4. Sets up indexes for optimal query performance

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ============================================================================
-- VERIFY TELEMETRY_POINTS TABLE STRUCTURE
-- ============================================================================

-- Check if telemetry_points table exists, if not create it
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables 
                 WHERE table_name = 'telemetry_points') THEN
    CREATE TABLE telemetry_points (
      id TEXT PRIMARY KEY,
      "vehicleId" TEXT NOT NULL,
      "timestamp" TIMESTAMPTZ NOT NULL,
      
      -- Battery metrics
      soc DOUBLE PRECISION,
      "batteryTemp" DOUBLE PRECISION,
      
      -- Motion
      speed DOUBLE PRECISION,
      power DOUBLE PRECISION,
      current DOUBLE PRECISION,
      voltage DOUBLE PRECISION,
      
      -- Location
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      
      -- Climate
      "outsideTemp" DOUBLE PRECISION,
      "insideTemp" DOUBLE PRECISION,
      
      -- Vehicle state
      odometer DOUBLE PRECISION,
      heading DOUBLE PRECISION,
      
      CONSTRAINT fk_vehicle FOREIGN KEY ("vehicleId") REFERENCES vehicles(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_telemetry_vehicle_time ON telemetry_points("vehicleId", "timestamp" DESC);
    CREATE INDEX idx_telemetry_time ON telemetry_points("timestamp" DESC);
  END IF;
END $$;

-- ============================================================================
-- CONVERT TO HYPERTABLE (if not already)
-- ============================================================================

-- Convert telemetry_points to hypertable (safe to call if already converted)
DO $$
BEGIN
  PERFORM create_hypertable('telemetry_points', 'timestamp', if_not_exists => TRUE);
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
  WHEN others THEN
    RAISE WARNING 'Error creating hypertable: %', SQLERRM;
END $$;

-- ============================================================================
-- COMPRESSION POLICY
-- ============================================================================

-- Compress data older than 7 days (reduces storage by ~90%)
SELECT add_compression_policy(
  'telemetry_points',
  INTERVAL '7 days',
  if_not_exists => TRUE
);

-- ============================================================================
-- RETENTION POLICY
-- ============================================================================

-- Delete data older than 90 days (prevents unbounded growth)
SELECT add_retention_policy(
  'telemetry_points',
  INTERVAL '90 days',
  if_not_exists => TRUE
);

-- ============================================================================
-- OPTIMIZED INDEXES FOR COMMON QUERIES
-- ============================================================================

-- Index for vehicle + time range queries (most common)
CREATE INDEX IF NOT EXISTS idx_telemetry_vehicle_time_desc 
  ON telemetry_points (
    "vehicleId",
    "timestamp" DESC
  );

-- BRIN index for time-range queries (efficient on large tables)
CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp_brin 
  ON telemetry_points USING BRIN ("timestamp");

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Verify hypertable exists
DO $$
DECLARE
  is_hypertable BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM timescaledb_information.hypertables
    WHERE hypertable_name = 'telemetry_points'
  ) INTO is_hypertable;
  
  IF is_hypertable THEN
    RAISE NOTICE '✅ telemetry_points is a hypertable';
  ELSE
    RAISE WARNING '⚠️  telemetry_points is NOT a hypertable';
  END IF;
END $$;

-- Show table size before compression
SELECT 
  'Table Size (before compression)' AS metric,
  pg_size_pretty(pg_total_relation_size('telemetry_points')) AS value;

-- Show compression policy status
SELECT 
  'Compression Policy' AS metric,
  CASE 
    WHEN count(*) > 0 THEN '✅ Enabled'
    ELSE '❌ Not configured'
  END AS status
FROM timescaledb_information.jobs
WHERE hypertable_name = 'telemetry_points'
  AND proc_name = 'compress_chunk';

-- Show retention policy status
SELECT 
  'Retention Policy' AS metric,
  CASE 
    WHEN count(*) > 0 THEN '✅ Enabled (' || 
         string_agg(config::text, ', ') || ')'
    ELSE '❌ Not configured'
  END AS status
FROM timescaledb_information.jobs
WHERE hypertable_name = 'telemetry_points'
  AND proc_name = 'policy_retention';

-- ============================================================================
-- TELEMETRY_EVENTS HYPERTABLE
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables 
                 WHERE table_name = 'telemetry_events') THEN
    CREATE TABLE telemetry_events (
      id TEXT PRIMARY KEY,
      "vehicleId" TEXT NOT NULL,
      "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "eventType" TEXT NOT NULL,
      "payloadJson" JSONB,
      
      CONSTRAINT fk_vehicle FOREIGN KEY ("vehicleId") REFERENCES vehicles(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_telemetry_events_vehicle_time ON telemetry_events("vehicleId", "timestamp" DESC);
    CREATE INDEX idx_telemetry_events_type ON telemetry_events("eventType");
  END IF;
END $$;

-- Convert to hypertable
DO $$
BEGIN
  PERFORM create_hypertable('telemetry_events', 'timestamp', if_not_exists => TRUE);
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;

-- Policies for events
SELECT add_compression_policy('telemetry_events', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('telemetry_events', INTERVAL '2 years', if_not_exists => TRUE);

-- ============================================================================
-- TRIP POINTS HYPERTABLE
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables 
                 WHERE table_name = 'trip_points') THEN
    CREATE TABLE trip_points (
      id TEXT PRIMARY KEY,
      "tripId" TEXT NOT NULL,
      "timestamp" TIMESTAMPTZ NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      speed DOUBLE PRECISION,
      power DOUBLE PRECISION,
      soc DOUBLE PRECISION,
      
      CONSTRAINT fk_trip FOREIGN KEY ("tripId") REFERENCES trips(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_trip_points_trip ON trip_points("tripId");
  END IF;
END $$;

-- Convert to hypertable
DO $$
BEGIN
  PERFORM create_hypertable('trip_points', 'timestamp', if_not_exists => TRUE);
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;

SELECT add_compression_policy('trip_points', INTERVAL '90 days', if_not_exists => TRUE);
SELECT add_retention_policy('trip_points', INTERVAL '2 years', if_not_exists => TRUE);

-- ============================================================================
-- BATTERY HEALTH AGGREGATION VIEW (daily summary)
-- ============================================================================

-- Create materialized view for daily aggregates (for fast dashboard queries)
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_telemetry_summary AS
SELECT
  "vehicleId",
  time_bucket('1 day', "timestamp") as day,
  AVG(soc) as avg_soc,
  MAX(soc) as max_soc,
  MIN(soc) as min_soc,
  AVG(speed) as avg_speed,
  MAX(speed) as max_speed,
  AVG(power) as avg_power,
  MAX(power) as max_power,
  COUNT(*) as sample_count
FROM telemetry_points
GROUP BY "vehicleId", time_bucket('1 day', "timestamp");

-- Create index on materialized view
CREATE INDEX IF NOT EXISTS idx_daily_summary_vehicle_day 
  ON daily_telemetry_summary ("vehicleId", day DESC);

-- ============================================================================
-- FINAL VERIFICATION AND HEALTH CHECK
-- ============================================================================

DO $$
DECLARE
  v_table_size TEXT;
  v_hypertable_count INT;
  v_chunk_count INT;
  v_compressed_chunks INT;
BEGIN
  -- Get table size
  SELECT pg_size_pretty(pg_total_relation_size('telemetry_points')) 
  INTO v_table_size;
  
  -- Count hypertables
  SELECT COUNT(*) INTO v_hypertable_count
  FROM timescaledb_information.hypertables;
  
  -- Count chunks
  SELECT COUNT(*) INTO v_chunk_count
  FROM timescaledb_information.chunks
  WHERE hypertable_name = 'telemetry_points';
  
  -- Count compressed chunks
  SELECT COUNT(*) INTO v_compressed_chunks
  FROM timescaledb_information.chunks
  WHERE hypertable_name = 'telemetry_points'
    AND is_compressed = TRUE;

  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE '  🎯 TIMESCALEDB INITIALIZATION COMPLETE';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE '  📊 Hypertables configured: %', v_hypertable_count;
  RAISE NOTICE '  📦 Chunks created: %', v_chunk_count;
  RAISE NOTICE '  ⚙️  Compressed chunks: %', v_compressed_chunks;
  RAISE NOTICE '  💾 Table size: %', v_table_size;
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
END $$;
