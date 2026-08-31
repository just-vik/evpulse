-- Migration: charging_efficiency
-- Adds chargingEfficiency to charging_sessions.
-- Formula: energyAddedKwh / ((endSoc - startSoc) / 100 × detectedCapacity)
-- e.g. 0.87 means 87% efficiency (13% lost as heat during DC fast charging).
-- Typical ranges: AC home 0.90–0.96, DC fast 0.85–0.93.

ALTER TABLE "charging_sessions"
  ADD COLUMN IF NOT EXISTS "chargingEfficiency" DOUBLE PRECISION;

COMMENT ON COLUMN "charging_sessions"."chargingEfficiency"
  IS 'Ratio of energy added (charger-side) to theoretical battery energy gain. < 1.0 = losses. Typical: AC ~0.93, DC ~0.88.';
