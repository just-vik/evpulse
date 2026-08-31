-- AlterTable: charging-side cycle counter on vehicles
ALTER TABLE "vehicles"
  ADD COLUMN IF NOT EXISTS "batteryCycleChargeTotal" DOUBLE PRECISION;

-- AlterTable: snapshot cycle count in each BatteryHealth record
ALTER TABLE "battery_health"
  ADD COLUMN IF NOT EXISTS "cycles" DOUBLE PRECISION;
