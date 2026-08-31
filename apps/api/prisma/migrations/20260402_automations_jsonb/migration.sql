-- Migration: reshape automations table to support rich conditions/actions/schedule
--
-- The original schema stored trigger and action as plain strings (legacy).
-- This migration replaces them with JSONB columns so the frontend can store
-- structured AutomationCondition[], AutomationAction[], and a schedule object.

-- 1. Add new columns (nullable first so existing rows don't fail)
ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS "vehicleId"    TEXT,
  ADD COLUMN IF NOT EXISTS "description"  TEXT,
  ADD COLUMN IF NOT EXISTS "conditions"   JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "actions"      JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "schedule"     JSONB NOT NULL DEFAULT '{"type":"always"}',
  ADD COLUMN IF NOT EXISTS "lastRunAt"    TIMESTAMPTZ;

-- 2. Migrate existing rows: pack legacy trigger/action strings into JSONB
UPDATE automations
SET
  "conditions" = COALESCE(
    CASE WHEN trigger IS NOT NULL AND trigger <> ''
    THEN jsonb_build_array(jsonb_build_object('field', 'batteryLevel', 'operator', '<', 'value', trigger))
    ELSE '[]'::jsonb
    END, '[]'::jsonb
  ),
  "actions" = COALESCE(
    CASE WHEN action IS NOT NULL AND action <> ''
    THEN jsonb_build_array(jsonb_build_object('type', 'notification', 'target', 'push', 'parameters', jsonb_build_object('message', action)))
    ELSE '[]'::jsonb
    END, '[]'::jsonb
  )
WHERE "conditions" = '[]'::jsonb;

-- 3. Drop legacy string columns
ALTER TABLE automations
  DROP COLUMN IF EXISTS "trigger",
  DROP COLUMN IF EXISTS "action";

-- 4. FK: vehicleId → vehicles(id) ON DELETE SET NULL
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'automations_vehicleId_fkey'
  ) THEN
    ALTER TABLE automations
      ADD CONSTRAINT "automations_vehicleId_fkey"
      FOREIGN KEY ("vehicleId") REFERENCES vehicles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 5. Indexes
CREATE INDEX IF NOT EXISTS "automations_vehicleId_idx" ON automations ("vehicleId");
