-- Add generation field to vehicle_specs (Juniper / Highland / null)
ALTER TABLE "vehicle_specs" ADD COLUMN IF NOT EXISTS "generation" TEXT;
