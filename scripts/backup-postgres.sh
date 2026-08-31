#!/bin/sh
# PostgreSQL backup script — runs inside db-backup container.
# Uses pg_dump custom format (-Fc): already compressed, selective restore-friendly.
# Retention: removes dumps older than BACKUP_KEEP_DAYS (default 7).
set -e

# Dumps contain full DB content (PII, credentials in some tables) — restrict to
# owner-only (600) at creation time rather than relying on a chmod pass afterward.
umask 077

BACKUP_DIR="/backups"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/tesla_${TIMESTAMP}.dump"

# Connection: PGHOST/PGPORT/PGUSER/PGDATABASE from environment;
# password from DB_PASSWORD (set via secrets/.env).
export PGPASSWORD="${DB_PASSWORD}"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Backup starting → ${BACKUP_FILE}"

pg_dump \
  --host="${PGHOST:-timescaledb}" \
  --port="${PGPORT:-5432}" \
  --username="${PGUSER:-tesla}" \
  --dbname="${PGDATABASE:-tesla}" \
  --format=custom \
  --no-password \
  --verbose \
  --file="${BACKUP_FILE}" 2>&1

SIZE=$(du -sh "${BACKUP_FILE}" 2>/dev/null | cut -f1)
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Backup complete: ${BACKUP_FILE} (${SIZE})"

# Rotate: delete dumps older than KEEP_DAYS
DELETED=$(find "${BACKUP_DIR}" -name "tesla_*.dump" -mtime "+${KEEP_DAYS}" -print)
if [ -n "${DELETED}" ]; then
  find "${BACKUP_DIR}" -name "tesla_*.dump" -mtime "+${KEEP_DAYS}" -delete
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Rotated old backups (>${KEEP_DAYS}d):"
  echo "${DELETED}"
fi

# Keep an index of current backups for quick health checks
ls -lh "${BACKUP_DIR}"/tesla_*.dump 2>/dev/null | \
  awk '{print $5, $9}' > "${BACKUP_DIR}/index.txt"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Done. Backups on disk:"
cat "${BACKUP_DIR}/index.txt"
