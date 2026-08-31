-- Index for fast battery health history queries:
--   WHERE "vehicleId" = $1 AND timestamp >= $2 ORDER BY timestamp ASC
-- Without this PostgreSQL does a seq-scan once the table grows past ~100k rows.
CREATE INDEX IF NOT EXISTS idx_battery_health_vehicle_time
  ON battery_health ("vehicleId", timestamp DESC);
