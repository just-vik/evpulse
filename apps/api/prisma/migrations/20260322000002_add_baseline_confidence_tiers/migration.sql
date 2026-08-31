-- Add dual-confidence baseline columns (HIGH and MEDIUM tiers)
ALTER TABLE "vehicles"
  ADD COLUMN IF NOT EXISTS "batteryBaselineHighKwh"        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "batteryBaselineHighLockedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "batteryBaselineMediumKwh"      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "batteryBaselineMediumLockedAt" TIMESTAMP(3);
