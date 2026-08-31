# Incident: fleet-telemetry TLS Certificate Expiry
**Date:** 2026-06-16 → 2026-08-17 (62 days)
**Severity:** HIGH — fleet-telemetry push data stream silent for 62 days
**Status:** Resolved 2026-08-17

---

## Timeline

| Date | Event |
|------|-------|
| 2026-03-18 | TLS cert issued for `telemetry.evpulse.app` (Let's Encrypt, 90-day validity) |
| 2026-06-16 | Cert expired. Tesla vehicles stopped sending fleet telemetry push data |
| 2026-07-25 | Certbot renewed cert → stored in `/etc/letsencrypt/live/`. No deploy hook existed to copy it to fleet-telemetry-certs or restart the container |
| 2026-07-25 | REST polling resumed (new data in `telemetry_points` from this date) |
| 2026-08-17 | Incident discovered during production hardening audit. Cert confirmed expired via `openssl x509 -noout -enddate` |
| 2026-08-17 | Deploy hook installed, cert copied, fleet-telemetry restarted. Monitoring added |

---

## Root Cause

**Primary:** The certbot deploy hook was never created. Certbot renewed the cert on 2026-07-25 and stores it in `/etc/letsencrypt/live/`. The `fleet-telemetry` container reads certs from a separate directory (`/secrets/fleet-telemetry-certs/`). Without a deploy hook, the renewed cert was never copied there, and the container was never restarted.

**Contributing:** No monitoring existed for:
- The cert actually served by fleet-telemetry (vs the cert on disk in `/etc/letsencrypt/live/`)
- Whether telemetry_points rows were arriving while a vehicle was awake

The certbot systemd timer reported "success" on every run (it had a valid cert in its own directory) while the container continued to serve the expired cert.

---

## Impact

- **Known data gap:** 2026-06-16 → 2026-07-25 (38 days): **zero telemetry_points rows**
- **Degraded period:** 2026-07-25 → 2026-08-17 (23 days): **REST polling only** (~100–570 points/day vs thousands/day from push telemetry)
- `telemetry_raw` 30-day retention and `telemetry_points` 90-day retention have already purged the surrounding data; the gap in `telemetry_points` is permanent
- Analytics for this period (battery degradation trend, vampire drain classification, trip history) are incomplete and should be excluded from long-term trend calculations

### Affected analytics — exclude these date ranges

```sql
-- When querying degradation / vampire drain baselines, exclude:
WHERE date NOT BETWEEN '2026-06-16' AND '2026-08-17'

-- Or filter on data quality:
WHERE timestamp < '2026-06-16' OR timestamp > '2026-08-17'
```

---

## Fix

### Immediate (2026-08-17)
1. Copied renewed cert from `/etc/letsencrypt/live/telemetry.evpulse.app/` to `/secrets/fleet-telemetry-certs/`
2. Restarted fleet-telemetry container
3. Verified TLS: `notAfter=Oct 25 2026`

### Preventive

**Deploy hook** installed at `/etc/letsencrypt/renewal-hooks/deploy/evpulse-fleet-telemetry.sh`:
- Runs after every certbot renewal
- Copies `fullchain.pem` + `privkey.pem` with correct permissions
- Restarts fleet-telemetry container via `docker compose up -d --no-deps`

**Monitoring** added to `HealthRecoveryService` (`health-recovery.service.ts`):

| Check | Frequency | Alert condition |
|-------|-----------|----------------|
| `checkCertExpiry` | Hourly | TLS connects to `tesla-fleet-telemetry:443`; alerts CRITICAL if expired or container unreachable, WARN if ≤14 days to expiry |
| `checkTelemetryFreshness` | Every minute | Queries `telemetry_points`; alerts WARN if a non-sleeping vehicle has 0 rows in 2h |

---

## Lessons

1. **Ops config completeness:** Having certbot configured is not enough — the renewal lifecycle must be end-to-end (obtain → deploy hook → service restart → verify). Same class of problem as the db_backup config that existed but wasn't tested.
2. **Silent failures are worst:** fleet-telemetry appeared "running" (process alive, no crash loops), and certbot appeared "successful" (valid cert in its own directory). Neither surfaced the real problem. The only reliable signal would have been a TLS check against the actual served cert.
3. **Monitor data, not just infrastructure:** The data freshness check (`checkTelemetryFreshness`) is more valuable than checking if the container is up — it directly answers "is the pipeline delivering value?" not "is the process alive?".
