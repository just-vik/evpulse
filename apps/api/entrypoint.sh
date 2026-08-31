#!/bin/sh
# =============================================================================
# EVPulse API — Application Entrypoint
# =============================================================================
#
# Schema migrations (Prisma + TimescaleDB setup) no longer run here — they run
# once via the one-shot `db-migrate` compose service (see migrate.sh) before
# api/api-worker start. This avoids two containers racing to run migrations
# simultaneously, and removes any network dependency from this startup path.
# =============================================================================

set -e

echo "[entrypoint] Starting NestJS application..."
exec node dist/main.js
