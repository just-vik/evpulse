-- Multi-tenant foundation: add tenantId to key tables.
-- All existing rows default to 'selfhosted' (single-tenant / self-hosted mode).
-- Backfill is handled by DEFAULT; no data loss.

ALTER TABLE users               ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'selfhosted';
ALTER TABLE vehicles            ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'selfhosted';
ALTER TABLE trips               ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'selfhosted';
ALTER TABLE charging_sessions   ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'selfhosted';
ALTER TABLE notification_rules  ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'selfhosted';
ALTER TABLE audit_events        ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'selfhosted';

-- Indexes for efficient tenant-scoped listing queries.
CREATE INDEX IF NOT EXISTS "users_tenantId_idx"    ON users("tenantId");
CREATE INDEX IF NOT EXISTS "vehicles_tenantId_idx" ON vehicles("tenantId");
