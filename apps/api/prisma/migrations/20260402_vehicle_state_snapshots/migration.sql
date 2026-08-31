-- Migration: add vehicle_state_snapshots table
--
-- Stores periodic + transition-triggered snapshots of the full vehicle state.
-- Used for:
--   1. Fast cold-start recovery (Redis is empty after restart → load latest snapshot)
--   2. Time-travel debugging (replay /api/v1/vehicles/:id/snapshots?before=...)
--   3. Historical state queries (when was the car last charging?)
--
-- Retention: 30 days (nightly purge cron in SnapshotService)

CREATE TABLE IF NOT EXISTS vehicle_state_snapshots (
  id           TEXT         NOT NULL,
  "vehicleId"  TEXT         NOT NULL,
  "snapshotAt" TIMESTAMPTZ  NOT NULL,
  trigger      TEXT         NOT NULL,  -- 'transition' | 'heartbeat' | 'cold_start' | 'pipeline'
  state        JSONB        NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY ("vehicleId") REFERENCES vehicles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vehicle_state_snapshots_vehicle_ts
  ON vehicle_state_snapshots ("vehicleId", "snapshotAt" DESC);

-- Optional: compress old snapshots via TimescaleDB (no-op on vanilla PG)
-- SELECT add_compression_policy('vehicle_state_snapshots', INTERVAL '7 days');
