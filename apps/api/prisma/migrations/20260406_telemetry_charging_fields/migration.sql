-- Add charging_state and chargeEnergyAdded to telemetry_points
-- These fields are stored from fleet telemetry / REST API for use by
-- charging detector, watchdog, and post-processor without raw payload joins.

ALTER TABLE telemetry_points
  ADD COLUMN IF NOT EXISTS "chargingState"     TEXT,
  ADD COLUMN IF NOT EXISTS "chargeEnergyAdded" DOUBLE PRECISION;

-- Index for watchdog queries: find latest telemetry with charging state
CREATE INDEX IF NOT EXISTS idx_telemetry_charging_state
  ON telemetry_points ("vehicleId", "chargingState")
  WHERE "chargingState" IS NOT NULL;
