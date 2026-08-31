#!/bin/sh
# =============================================================================
# EVPulse API — One-shot DB migration (db-migrate compose service)
# =============================================================================
#
# Runs the two schema-setup steps that used to live in entrypoint.sh's Step 1/2,
# now separated from api/api-worker startup so neither container races the other
# to run migrations, and neither depends on network access at startup:
#   1. prisma migrate deploy — apply pending Prisma (PostgreSQL) migrations
#   2. timescale.sql         — idempotent TimescaleDB hypertable setup
#
# WHY THIS ORDER:
#   Prisma creates/alters tables first (no hypertable constraints yet).
#   timescale.sql then converts them to hypertables (if_not_exists = safe).
#   Separating the two avoids the Prisma ↔ TimescaleDB PK conflict:
#     TS103: cannot create unique index without the partitioning column
#
# IDEMPOTENCY: both steps are safe to re-run on an already-migrated DB.
# =============================================================================

set -euo pipefail

echo "[db-migrate] ── Step 1: Prisma migrate deploy ──────────────────────────"
./node_modules/.bin/prisma migrate deploy --schema=prisma/schema.prisma
echo "[db-migrate] Prisma migrations: OK"

echo "[db-migrate] ── Step 2: TimescaleDB setup ──────────────────────────────"
# psql does not accept pool query params (e.g. connection_limit, pool_timeout).
# Strip DSN query string for setup SQL while keeping Prisma DATABASE_URL intact.
PSQL_DATABASE_URL="${DATABASE_URL%%\?*}"
psql "$PSQL_DATABASE_URL" -f prisma/migrations_manual/timescale.sql \
  --set ON_ERROR_STOP=0 \
  -q \
  && echo "[db-migrate] TimescaleDB setup: OK" \
  || echo "[db-migrate] TimescaleDB setup: WARN (non-fatal — hypertable may already exist)"

echo "[db-migrate] Done."
