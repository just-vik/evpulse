# EVPulse — Tesla Analytics Platform

Production Tesla vehicle analytics: real-time telemetry, trip tracking, battery health, charging insights, AI-driven recommendations.

**Status**: Backend ✅ Production | Frontend ✅ Production | Overall 🟢 Running

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | NestJS 11, TypeScript |
| Frontend | Next.js 15, App Router, Tailwind v4, MapLibre GL, ECharts |
| Database | TimescaleDB (PostgreSQL + pgvector) |
| Cache / Queues | Redis 7, BullMQ |
| Messaging | MQTT (Mosquitto) |
| Map Matching | OSRM (Hessen region) |
| AI | Groq API — llama-3.3-70b-versatile |
| Observability | OpenTelemetry → Tempo + Grafana |
| Deploy | Docker Compose on Proxmox KVM (Ubuntu) |

---

## Repository Structure

```
tesla-platform/
├── apps/
│   ├── api/          # NestJS backend (APP_ROLE: api | worker | all)
│   └── web/          # Next.js 15 frontend
├── packages/
│   └── shared/       # Shared types and DTOs
├── infra/
│   ├── timescaledb/  # Custom TimescaleDB + pgvector image
│   ├── osrm/         # OSRM entrypoint (Hessen auto-download)
│   ├── fleet-telemetry/  # Tesla Fleet Telemetry server
│   ├── mqtt/         # Mosquitto config
│   ├── tempo/        # OTel Tempo config
│   └── grafana/      # Grafana provisioning
├── docs/             # Architecture, API, integration docs
├── secrets/          # .env and TLS certs (git-ignored)
└── docker-compose.yml
```

---

## Quick Start

### Prerequisites
- Docker & Docker Compose
- `secrets/.env` with credentials (see `docs/QUICKSTART.md`)

### Start

All Compose commands go through `./scripts/compose.sh` (wraps `docker compose --env-file
./secrets/.env ...`) — never call `docker compose` directly. Several values in
`docker-compose.yml` (e.g. `POSTGRES_PASSWORD`) are only resolved via `${VAR}`
interpolation from `secrets/.env`; running plain `docker compose up -d` will fail with a
clear `DB_PASSWORD is not set` error rather than deploying with an empty password.

> The repo-root `.env` file is legacy/deprecated — it predates `secrets/.env` covering
> the same variables and is not used for deployment. Do not add new variables there.

```bash
# Core services (DB, Redis, MQTT, OSRM, API, Worker, Frontend)
./scripts/compose.sh up -d

# With Fleet Telemetry (requires TLS certs in secrets/)
./scripts/compose.sh --profile fleet-telemetry up -d

# With Observability (Tempo + Grafana)
./scripts/compose.sh --profile observability up -d
```

First start: OSRM downloads and preprocesses Hessen OSM data (~323 MB, ~5 min).
Subsequent starts boot instantly from the `osrm_data` volume.

### URLs (local)
- API: `http://localhost:3000`
- Frontend: `http://localhost:3001`
- Grafana: `http://localhost:3002`

### Production domains
- `evpulse.app` — frontend
- `api.evpulse.app` — backend API
- `telemetry.evpulse.app` — fleet telemetry (TLS, port 443)

---

## Backend Roles (`apps/api`)

| `APP_ROLE` | What runs |
|-----------|-----------|
| `api` | HTTP server on port 3000 |
| `worker` | Bull workers, cron jobs, telemetry stream consumers |
| `all` | Both (default) |

---

## Key Features

- **Real-time telemetry** via Tesla Fleet API (streaming + REST polling)
- **Trip detection** — state machine with gap recovery, OSRM map matching
- **Charging sessions** — cost tracking, supercharger pricing, start-lag detection
- **Battery health** — degradation analysis, vampire drain, baseline auto-lock
- **AI insights** — Groq LLM + rule-based fallback; AIGuard for safe command execution
- **Notification rules** — JSONB conditions (time, location, vehicle), webhook actions
- **Vehicle commands** — via tesla-vehicle-command proxy, with history and presets
- **Multi-tenant foundation** — `tenantId` on 6 tables, AsyncLocalStorage, Prisma middleware
- **Audit log** — all auth, commands, and rule changes tracked
- **OTel tracing** — 4 manual spans, OTLP → Tempo

---

## Environment Variables

Key variables in `secrets/.env`:

```env
# Tesla
TESLA_CLIENT_ID=
TESLA_CLIENT_SECRET=
TESLA_REDIRECT_URI=https://api.evpulse.app/api/v1/auth/tesla/callback
FLEET_INTERNAL_TOKEN=

# Auth
JWT_SECRET=
JWT_REFRESH_SECRET=

# AI
GROQ_API_KEY=          # optional — rule-based fallback if not set

# Notifications
SMTP_HOST=
TELEGRAM_BOT_TOKEN=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
```

---

## Database Migrations

```bash
cd apps/api
npx prisma migrate deploy   # production
npx prisma generate
```

---

## Documentation

| File | Contents |
|------|----------|
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | Full setup guide |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design |
| [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md) | API reference |
| [docs/TESLA_INTEGRATION.md](docs/TESLA_INTEGRATION.md) | OAuth + Fleet API setup |
| [docs/TESLA_ARCHITECTURE.md](docs/TESLA_ARCHITECTURE.md) | Telemetry data flow |
| [docs/TESLA_QUICK_START.md](docs/TESLA_QUICK_START.md) | Tesla setup checklist |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Product roadmap |
| [docs/MOBILE_EXPO_TESTING.md](docs/MOBILE_EXPO_TESTING.md) | Testing `apps/mobile` on a real iPhone via Expo Go (LAN/tunnel) |
| [apps/web/README.md](apps/web/README.md) | Frontend notes |

---

## Health Check

```bash
curl http://localhost:3000/health | jq
```
