-- AlterTable: add battery baseline lock + cycle tracking to vehicles
ALTER TABLE "vehicles"
  ADD COLUMN "batteryCapacityBaseline"  DOUBLE PRECISION,
  ADD COLUMN "batteryBaselineLockedAt" TIMESTAMP(3),
  ADD COLUMN "batteryCyclesTotal"       DOUBLE PRECISION;
