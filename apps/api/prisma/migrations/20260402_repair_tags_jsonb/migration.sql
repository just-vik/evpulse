-- Migration: add structured repair_tags JSONB column to trips
-- Replaces the legacy pipe-delimited repair_reason string for scale.
--
-- repair_tags stores an array of {tag, source, ts} objects, e.g.:
--   [{"tag":"gap_recovery","source":"gap-recovery","ts":"2026-04-02T10:00:00Z"}]
--
-- GIN index enables fast containment queries:
--   WHERE repair_tags @> '[{"tag":"force_closed_stale_watchdog"}]'
--
-- The legacy repair_reason column is kept for backward compat during cutover.

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS repair_tags JSONB;

-- Structural integrity: repair_tags must always be a JSON array (or NULL).
-- CHECK with IS NULL guard lets existing rows remain NULL until backfilled.
ALTER TABLE trips
  ADD CONSTRAINT IF NOT EXISTS trips_repair_tags_is_array
  CHECK (repair_tags IS NULL OR jsonb_typeof(repair_tags) = 'array');

-- NOTE: The deeper jsonb_path_exists schema validation constraint was evaluated
-- and removed: it adds ~0.5ms per INSERT at high volume and is better enforced
-- at the application layer (appendRepairTag / appendRepairTags utilities always
-- include both tag and source fields).  Only the lightweight is_array check is kept.

-- GIN index for fast JSONB containment (@>) queries.
-- Prisma does not generate GIN indexes natively, so this is raw SQL.
-- Note: CONCURRENTLY cannot run inside a transaction; plain CREATE INDEX is used here.
CREATE INDEX IF NOT EXISTS idx_trips_repair_tags_gin
  ON trips USING GIN (repair_tags);

-- Backfill: convert existing pipe-delimited repair_reason to JSONB array.
-- Sets source='watchdog' and ts='1970-01-01' as best-effort for legacy rows.
UPDATE trips
SET repair_tags = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'tag',    trim(part),
      'source', 'watchdog',
      'ts',     '1970-01-01T00:00:00.000Z'
    )
  )
  FROM unnest(string_to_array(repair_reason, '|')) AS part
  WHERE trim(part) <> ''
)
WHERE repair_reason IS NOT NULL
  AND repair_reason <> 'ok'
  AND repair_tags IS NULL;
