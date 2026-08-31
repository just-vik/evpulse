-- =============================================================================
-- EVPulse — TimescaleDB Manual Migrations
-- =============================================================================
--
-- PURPOSE: All TimescaleDB-specific DDL that Prisma cannot handle correctly.
--
-- WHY SEPARATE:
--   Prisma generates standard PostgreSQL DDL. TimescaleDB hypertables have
--   additional constraints (e.g. PRIMARY KEY must include the partitioning
--   column). Running Prisma migrations against a TimescaleDB table causes:
--     ERROR: cannot create a unique index without the column used in partitioning
--
-- HOW TO RUN:
--   This file is executed automatically by the one-shot `db-migrate` compose
--   service (apps/api/migrate.sh), AFTER prisma migrate deploy. All statements
--   are idempotent (if_not_exists => TRUE), so re-running never breaks anything.
--
-- RULE: Never put create_hypertable / add_retention_policy / compress_chunk
--       inside a Prisma migration. Put it here.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. telemetry_points  (primary time-series table)
-- ─────────────────────────────────────────────────────────────────────────────
-- Note: Prisma creates this table with @@index([vehicleId, timestamp]).
-- The @@unique([vehicleId, timestamp]) constraint already satisfies
-- TimescaleDB's partitioning requirement (timestamp is part of the unique key).

SELECT create_hypertable(
  'telemetry_points',
  'timestamp',
  if_not_exists       => TRUE,
  chunk_time_interval => INTERVAL '1 day',
  migrate_data        => TRUE
);

-- Auto-compress chunks older than 7 days (saves ~90% storage)
SELECT add_compression_policy(
  'telemetry_points',
  INTERVAL '7 days',
  if_not_exists => TRUE
);

-- Drop chunks older than 90 days (raw telemetry retention)
SELECT add_retention_policy(
  'telemetry_points',
  INTERVAL '90 days',
  if_not_exists => TRUE
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. telemetry_raw  (immutable event store / replay buffer)
-- ─────────────────────────────────────────────────────────────────────────────
-- PRIMARY KEY is (id, receivedAt) — composite key satisfies TimescaleDB.

SELECT create_hypertable(
  'telemetry_raw',
  'receivedAt',
  if_not_exists       => TRUE,
  chunk_time_interval => INTERVAL '1 day',
  migrate_data        => TRUE
);

-- Keep raw events for 30 days (replay window), then purge
SELECT add_retention_policy(
  'telemetry_raw',
  INTERVAL '30 days',
  if_not_exists => TRUE
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. telemetry_events  (discrete state-transition events)
-- ─────────────────────────────────────────────────────────────────────────────
-- NOTE: telemetry_events has PRIMARY KEY (id) without timestamp.
-- TimescaleDB requires the partitioning column to be part of the PRIMARY KEY.
-- Cannot convert to hypertable without dropping the PK and recreating as
-- a composite (id, timestamp) PK — deferred until next major migration.
-- This table is low-frequency (events only, not per-second telemetry),
-- so standard PostgreSQL B-tree indexes are sufficient for now.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. vehicle_locations  (GPS breadcrumbs)
-- ─────────────────────────────────────────────────────────────────────────────
-- NOTE: vehicle_locations has PRIMARY KEY (id) without timestamp.
-- Same constraint as telemetry_events — cannot be a hypertable until the
-- PK is rebuilt as composite (id, timestamp).
-- Standard PostgreSQL with @@index([vehicleId, timestamp]) is sufficient.


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. user_context_embeddings  (RAG vector store)
-- ─────────────────────────────────────────────────────────────────────────────
-- pgvector extension is enabled via Prisma migration 20260424130000_enable_pgvector.
-- Prisma cannot create HNSW indexes, so we do it here.
-- m=16 / ef_construction=64 is a balanced default for <100k rows.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'user_context_embeddings'
      AND indexname  = 'uce_embedding_hnsw_idx'
  ) THEN
    CREATE INDEX uce_embedding_hnsw_idx
      ON user_context_embeddings
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  END IF;
END
$$;
