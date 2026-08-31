-- Add shiftState column to telemetry_points for accurate backfill/rebuild
-- Previously shift_state was used only in-flight during live detection and never persisted.
-- Without this, rebuild/backfill could not use shift_state='P' to split trips.
ALTER TABLE "telemetry_points" ADD COLUMN IF NOT EXISTS "shiftState" TEXT;
