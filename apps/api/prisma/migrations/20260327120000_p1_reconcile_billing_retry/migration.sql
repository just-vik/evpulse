-- P1: two-phase trip reconcile + billing sync retry queue

ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "reconcile_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "trips_reconcile_at_idx" ON "trips"("reconcile_at");

ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "billing_sync_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "billing_next_sync_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "charging_sessions_billing_next_sync_at_idx" ON "charging_sessions"("billing_next_sync_at");
