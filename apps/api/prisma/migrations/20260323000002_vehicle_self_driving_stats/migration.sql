-- Migration: vehicle_self_driving_stats
-- Adds self-driving and total-odometer tracking to the Vehicle model.
-- Fields are populated from Tesla fleet telemetry:
--   SelfDrivingMilesSinceReset → selfDrivingKmTotal (miles × 1.60934)
--   MilesSinceReset            → odometerKmSinceReset (miles × 1.60934)
-- Both are running totals since the last factory reset (not per-trip).

ALTER TABLE "vehicles"
  ADD COLUMN IF NOT EXISTS "selfDrivingKmTotal"    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "odometerKmSinceReset"  DOUBLE PRECISION;

COMMENT ON COLUMN "vehicles"."selfDrivingKmTotal"
  IS 'Cumulative km driven with FSD/Autopilot active (from fleet telemetry SelfDrivingMilesSinceReset, converted from miles)';

COMMENT ON COLUMN "vehicles"."odometerKmSinceReset"
  IS 'Total km since last factory reset (from fleet telemetry MilesSinceReset, converted from miles)';
