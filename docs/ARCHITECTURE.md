# EVPulse Architecture
**Last updated:** 2026-08-17
**State:** Personal-use, production-hardened, single-tenant (selfhosted)

---

## Services (Docker Compose)

12 services across two isolated bridge networks:

```
evpulse_backend (internal — no internet access except fleet-telemetry)
├── tesla-timescale    TimescaleDB 2.x on PostgreSQL 16    :5432 (localhost only)
├── tesla-redis        Redis 7.4                           :6379 (localhost only)
├── tesla-mqtt         Eclipse Mosquitto 2.0               :1883 (internal only)
├── evpulse-api        NestJS API + HTTP server            :4000 (localhost only)
├── evpulse-api-worker NestJS worker-role (crons, queues)  no HTTP
├── evpulse-db-backup  pg_dump cron → db_backups volume    no ports
├── tesla-osrm         OSRM map-matching (Hessen OSM)      :5000 (localhost only)
├── tesla-vehicle-proxy tesla-vehicle-command proxy        :4443 (localhost only)
├── tesla-fleet-telemetry fleet-telemetry push receiver   :443  (public)
├── evpulse-tempo      Grafana Tempo (traces)              :4317 (localhost only)
└── evpulse-grafana    Grafana dashboards                  :3001 (localhost only)

evpulse_frontend (DMZ — only reaches api via backend-net bridge)
└── evpulse-frontend   Next.js 15 standalone              :3000 (localhost only)
```

**Network rules:**
- `frontend` container is on `evpulse_frontend` only — cannot reach TimescaleDB, Redis, MQTT directly
- `evpulse-api` bridges both networks (ingress from frontend, egress to all backend services)
- Only `tesla-fleet-telemetry` binds to `0.0.0.0:443` (external)
- All other ports bound to `127.0.0.1` or internal networks only

---

## Security Hardening

All containers run with:
```yaml
security_opt: ["no-new-privileges:true"]
cap_drop: ["ALL"]
```

Per-service capability additions:
| Service | `cap_add` | Reason |
|---------|-----------|--------|
| fleet-telemetry | `NET_BIND_SERVICE` | binds port 443 (< 1024) |
| tesla-proxy | `DAC_READ_SEARCH` | reads root-owned 600 TLS key |
| timescaledb, redis, mqtt | none | gosu/su-exec need host caps, not container caps |

`evpulse-frontend` additionally: `user: "1001:1001"`, `read_only: true`, `tmpfs: ["/tmp"]`

Secrets in `secrets/.env` (gitignored, chmod 600, env_file injected at compose start).

---

## Telemetry Pipeline

### Push path (fleet-telemetry) — high-frequency
```
Tesla vehicle
  → TLS :443 (tesla-fleet-telemetry)
  → MQTT (tesla-mqtt) via protobuf → JSON
  → Redis Stream (telemetry:raw)
  → evpulse-api-worker (stream consumer)
  → telemetry_points (TimescaleDB)
```
Typical volume: thousands of points/day per vehicle.
**Note:** This path was down Jun 16 → Aug 17 2026 due to expired TLS cert (see INCIDENT_2026_TLS_CERT.md).

### REST polling path — low-frequency fallback
```
evpulse-api-worker (TelemetryPollCronService, every 5 min)
  → Tesla Fleet REST API
  → telemetry_points (TimescaleDB)
```
Typical volume: 100–600 points/day. Active when push path is unavailable or vehicle is sleeping.

### Downstream processing (evpulse-api-worker)
```
telemetry_points write
  → TripDetectorService     (start/end detection via state machine)
  → ChargingDetectorService (session tracking)
  → VampireDrainService     (sleep-gap SOC loss, every 6h)
  → BatteryHealthService    (capacity estimation, daily 03:30 UTC)
  → WebSocket broadcast     (Socket.io → frontend)
```

---

## Database Schema

**44 tables** in TimescaleDB (PostgreSQL 16). Current dump: `schema_dump.sql`.

```
Users & Auth          (5)   users, user_settings, user_sessions,
                             tesla_accounts, tesla_vehicle_links

Vehicles              (5)   vehicles, vehicle_settings, vehicle_state,
                             vehicle_state_snapshots, vehicle_locations

Telemetry             (3)   telemetry_points*, telemetry_raw*, telemetry_1hour*
                             (* = TimescaleDB hypertables)

Trips                 (3)   trips, trip_points, trip_stats

Charging              (3)   charging_sessions, charging_points, charging_cost_settings

Battery Analytics     (3)   battery_health_logs, vampire_drain_logs, battery_raw_readings

Energy Analytics      (3)   daily_energy, monthly_energy, energy_cost_history

Notifications         (3)   notifications, notification_rules, push_subscriptions

Maintenance / Ops     (4)   gap_recovery_jobs, system_health_logs, audit_logs, ...

Automations / Billing (12)  automations, subscriptions, invoices, ...
```

**Retention policies (TimescaleDB):**
| Table | Retention |
|-------|-----------|
| `telemetry_raw` | 30 days |
| `telemetry_points` | 90 days |
| `telemetry_1hour` | 5 years |

**Known data gap:** `telemetry_points` has no rows between 2026-06-16 and 2026-07-25 (push path cert expiry incident). Exclude this range from long-term battery/drain trend analysis.

---

## Monitoring & Self-Healing (HealthRecoveryService)

Runs every 60 seconds in `evpulse-api-worker`:

| Check | Frequency | Action |
|-------|-----------|--------|
| `checkRedisLocks` | every 60s | removes stuck rate-limit keys |
| `checkDlq` | every 60s | WARN ≥50 / CRITICAL ≥100 failed jobs in DLQ |
| `checkStaleness` | every 60s | restarts REST polling loop for stale vehicles (anti-thrash: 5 min) |
| `checkTelemetryFreshness` | every 60s | WARN if non-sleeping vehicle has 0 telemetry_points in 2h |
| `checkCertExpiry` | every 1h | TLS connects to `tesla-fleet-telemetry:443`; WARN ≤14d, CRITICAL if expired or unreachable |

Alerts via direct Telegram HTTP to `TELEGRAM_OPS_CHAT_ID`. Deduplication: 15 min cooldown per alert key.

---

## TLS Certificate Lifecycle (fleet-telemetry)

Cert: Let's Encrypt for `telemetry.evpulse.app` (90-day validity).

**Auto-renewal chain:**
```
systemd certbot.timer (twice daily)
  → certbot renew --dns-cloudflare (credentials: secrets/cloudflare.ini)
  → /etc/letsencrypt/renewal-hooks/deploy/evpulse-fleet-telemetry.sh
      copies fullchain.pem + privkey.pem → secrets/fleet-telemetry-certs/
      docker compose ... up -d --no-deps fleet-telemetry
```

Current cert: valid Jul 25 – Oct 23 2026.

---

## Project Structure

```
tesla-platform/
├── apps/
│   ├── api/               NestJS monorepo app (API + worker)
│   │   ├── prisma/        schema.prisma, migrations/
│   │   └── src/
│   │       ├── auth/
│   │       ├── battery/
│   │       ├── charging/
│   │       ├── maintenance/
│   │       ├── metrics/
│   │       ├── notifications/
│   │       ├── queues/
│   │       ├── runtime/       APP_ROLE gating (api / worker / all)
│   │       ├── telemetry/
│   │       ├── tesla-fleet/   fleet-telemetry, REST polling, health-recovery
│   │       ├── trips/
│   │       └── users/
│   ├── web/               Next.js 15 (standalone, read-only container)
│   └── mobile/            React Native / Expo
├── infra/
│   ├── fleet-telemetry/   Dockerfile + entrypoint (builds from source)
│   └── mosquitto/         MQTT config
├── secrets/               gitignored: .env, cloudflare.ini, certs
├── docs/
│   ├── ARCHITECTURE.md    this file
│   ├── INCIDENT_2026_TLS_CERT.md
│   └── ...
├── schema_dump.sql        live schema snapshot (44 tables, Aug 2026)
└── docker-compose.yml
```

---

## Runtime Roles (APP_ROLE)

The NestJS app supports three runtime roles via `APP_ROLE` env var:

| Role | HTTP server | Cron jobs | Use case |
|------|-------------|-----------|----------|
| `api` | yes | no | HTTP API container |
| `worker` | no | yes | background jobs container |
| `all` | yes | yes | single-container dev mode |

`evpulse-api` runs as `api`, `evpulse-api-worker` runs as `worker`. Swagger docs only served when `NODE_ENV !== 'production'`.

---

## Key Environment Variables

```env
# Secrets (secrets/.env — never committed)
DATABASE_URL=postgresql://tesla:<hash>@tesla-timescale:5432/tesla
REDIS_URL=redis://tesla-redis:6379
MQTT_USER / MQTT_PASSWORD
JWT_SECRET / JWT_EXPIRES_IN=15m
FLEET_INTERNAL_TOKEN
TELEGRAM_BOT_TOKEN / TELEGRAM_OPS_CHAT_ID
OPENAI_API_KEY          # stored in ~/.secrets_env on host, not in repo
```
