-- Migration: daily_monthly_regen
-- Adds regenEnergyKwh to daily_energy and monthly_energy so regen
-- is stored as a proper aggregate (not re-computed via JOIN on every request).

ALTER TABLE "daily_energy"
  ADD COLUMN IF NOT EXISTS "regenEnergyKwh" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "monthly_energy"
  ADD COLUMN IF NOT EXISTS "regenEnergyKwh" DOUBLE PRECISION NOT NULL DEFAULT 0;
