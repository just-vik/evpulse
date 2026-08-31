-- Migration: command_presets, command_history, login_events tables
--            + conditions/actions JSONB columns on notification_rules
-- Date: 2026-05-18

-- ── 1. command_presets ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS command_presets (
  id          TEXT        NOT NULL PRIMARY KEY,
  "userId"    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "vehicleId" TEXT        REFERENCES vehicles(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  command     TEXT        NOT NULL,
  params      JSONB,
  icon        TEXT,
  "sortOrder" INTEGER     NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "command_presets_userId_idx"   ON command_presets ("userId");
CREATE INDEX IF NOT EXISTS "command_presets_vehicleId_idx" ON command_presets ("vehicleId");

-- ── 2. command_history ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS command_history (
  id           TEXT        NOT NULL PRIMARY KEY,
  "userId"     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "vehicleId"  TEXT        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  "presetId"   TEXT,
  command      TEXT        NOT NULL,
  params       JSONB,
  status       TEXT        NOT NULL DEFAULT 'pending',
  result       JSONB,
  error        TEXT,
  "executedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "command_history_userId_executedAt_idx"   ON command_history ("userId", "executedAt");
CREATE INDEX IF NOT EXISTS "command_history_vehicleId_executedAt_idx" ON command_history ("vehicleId", "executedAt");

-- ── 3. login_events ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_events (
  id           TEXT        NOT NULL PRIMARY KEY,
  "userId"     TEXT        REFERENCES users(id) ON DELETE SET NULL,
  email        TEXT        NOT NULL,
  ip           TEXT,
  "userAgent"  TEXT,
  device       TEXT,
  success      BOOLEAN     NOT NULL,
  "failReason" TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "login_events_userId_createdAt_idx" ON login_events ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "login_events_createdAt_idx"        ON login_events ("createdAt");

-- ── 4. notification_rules: add conditions + actions columns ───────────────
ALTER TABLE notification_rules
  ADD COLUMN IF NOT EXISTS conditions JSONB,
  ADD COLUMN IF NOT EXISTS actions    JSONB;
