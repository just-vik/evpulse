-- Migration: 20260323000001_telemetry_raw_and_state_version
-- 1. Add optimistic-lock version to vehicle_states
-- 2. Create telemetry_raw table (immutable event store for replay/debug)

-- ── 1. Optimistic locking ────────────────────────────────────────────────────
ALTER TABLE "vehicle_states"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- ── 2. Raw telemetry event store ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "telemetry_raw" (
  "id"          TEXT        NOT NULL,
  "vehicleId"   TEXT        NOT NULL,
  "source"      TEXT        NOT NULL,
  "receivedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "payload"     JSONB       NOT NULL,
  "payloadHash" TEXT,

  -- Composite PK required by TimescaleDB: partitioning column (receivedAt)
  -- must be part of the primary key constraint.
  CONSTRAINT "telemetry_raw_pkey" PRIMARY KEY ("id", "receivedAt")
);

CREATE INDEX IF NOT EXISTS "telemetry_raw_vehicleId_receivedAt_idx"
  ON "telemetry_raw" ("vehicleId", "receivedAt" DESC);

CREATE INDEX IF NOT EXISTS "telemetry_raw_vehicleId_payloadHash_idx"
  ON "telemetry_raw" ("vehicleId", "payloadHash")
  WHERE "payloadHash" IS NOT NULL;

-- NOTE: create_hypertable intentionally NOT called here.
-- TimescaleDB DDL lives in prisma/migrations_manual/timescale.sql
-- and is executed by entrypoint.sh AFTER prisma migrate deploy.
-- Mixing TimescaleDB calls into Prisma migrations causes:
--   TS103: cannot create unique index without partitioning column
