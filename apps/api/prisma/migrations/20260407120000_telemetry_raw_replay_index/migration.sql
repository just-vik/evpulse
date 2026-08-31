-- Keyset pagination for pipeline raw replay (ORDER BY receivedAt ASC, id ASC).
-- Complements existing (vehicleId, receivedAt DESC) index used for other queries.
CREATE INDEX IF NOT EXISTS "telemetry_raw_vehicleId_receivedAt_id_idx"
  ON "telemetry_raw" ("vehicleId", "receivedAt", "id");
