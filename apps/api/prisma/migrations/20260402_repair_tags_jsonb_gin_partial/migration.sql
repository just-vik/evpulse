-- Migration: replace full GIN index on repair_tags with a partial index.
--
-- A partial index (WHERE repair_tags IS NOT NULL) is smaller and faster because:
--   • NULL rows (the majority while backfill is in progress) are excluded from
--     the index entirely — less index bloat, faster writes, cheaper VACUUM.
--   • All useful JSONB containment queries (@>, ??) always include a
--     WHERE repair_tags IS NOT NULL predicate (implicitly or explicitly), so
--     PostgreSQL can still use the index for every real workload query.

-- Drop the old full index (created in 20260402_repair_tags_jsonb).
DROP INDEX IF EXISTS idx_trips_repair_tags_gin;

-- Create the replacement partial GIN index.
-- CONCURRENTLY not used here because Prisma wraps migrations in a transaction.
CREATE INDEX IF NOT EXISTS idx_trips_repair_tags_gin
  ON trips USING GIN (repair_tags)
  WHERE repair_tags IS NOT NULL;
