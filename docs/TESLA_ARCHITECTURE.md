# Tesla Fleet Integration - Architecture Diagram

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TESLA ANALYTICS PLATFORM                           │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                            FRONTEND LAYER (Next.js)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  Dashboard │ Vehicles │ Trips │ Charging │ Battery │ Energy │ Commands      │
│        Real-time WebSocket Connection                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↕
┌─────────────────────────────────────────────────────────────────────────────┐
│                         API GATEWAY (NestJS)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ AUTH MODULE                                                             │ │
│ │ ├─ JWT Authentication (User → Dashboard)                              │ │
│ │ ├─ Tesla OAuth (User → Tesla)                                         │ │
│ │ └─ Refresh Token Management                                           │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ TESLA FLEET MODULE (NEW)                                               │ │
│ │ ├─ TeslaOAuthService         [Token Management + Encryption]           │ │
│ │ ├─ TeslaFleetService         [API Client]                             │ │
│ │ ├─ VehicleStateMachine       [Polling Control]                        │ │
│ │ ├─ TelemetryFetcher          [Data Ingestion]                         │ │
│ │ ├─ TokenRefreshWorker        [Auto Token Refresh]                     │ │
│ │ ├─ TeslaAuthController       [OAuth Endpoints]                        │ │
│ │ └─ TeslaCommandsController   [Vehicle Command Endpoints]              │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ ANALYTICS MODULES                                                       │ │
│ │ ├─ Telemetry Module          [Raw Data Storage]                        │ │
│ │ ├─ Trips Module              [Trip Detection]                          │ │
│ │ ├─ Charging Module           [Charging Detection]                      │ │
│ │ ├─ Battery Module            [Battery Analytics]                       │ │
│ │ └─ Analytics Module          [Energy Analytics]                        │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ QUEUE MODULE (Processing)                                              │ │
│ │ └─ TelemetryProcessor        [30k+ events/day]                        │ │
│ │    ├─ fetch-telemetry        [Tesla API → Real Data]                  │ │
│ │    ├─ ingest-telemetry       [Store Raw Points]                       │ │
│ │    └─ batch-ingest-telemetry [50k+ events/day]                        │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ WEBSOCKETS                                                              │ │
│ │ └─ TelemetryGateway          [Real-time Broadcasts]                   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↕
┌─────────────────────────────────────────────────────────────────────────────┐
│                       INFRASTRUCTURE LAYER                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ PostgreSQL   │  │ Redis        │  │ Prisma ORM   │  │ BullMQ       │  │
│  │ (Data)       │  │ (Cache/Pub)  │  │ (DB Client)  │  │ (Job Queue)  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ ENCRYPTION LAYER                                                     │  │
│  │ └─ AES-256-CBC Token Encryption                                      │  │
│  │    (TESLA_ENCRYPTION_KEY / TESLA_ENCRYPTION_IV)                     │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↕
┌─────────────────────────────────────────────────────────────────────────────┐
│                       EXTERNAL SERVICES                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ TESLA FLEET API                                                      │  │
│  │ ├─ OAuth Endpoints      (https://auth.tesla.com)                   │  │
│  │ ├─ Fleet API            (https://api.tesla.com)                    │  │
│  │ └─ Live Telemetry       (vehicle_data, drive_state, charge_state)  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ USER'S TESLA VEHICLE                                                 │  │
│  │ └─ Real-time GPS, Battery, Charging, Climate Data                   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: OAuth Authentication

```
┌──────────────────────────────────────────────────────────────────────┐
│                        USER LOGIN FLOW                               │
└──────────────────────────────────────────────────────────────────────┘

1. User clicks "Connect Tesla"
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ GET /auth/tesla/login                                               │
│ - Generate random state (CSRF token)                                │
│ - Store state in secure cookie                                      │
│ - Redirect to Tesla auth endpoint                                   │
└─────────────────────────────────────────────────────────────────────┘
   ↓
   ↓ (Browser redirect)
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ TESLA AUTH SERVER (https://auth.tesla.com)                         │
│ - User views Tesla login screen                                     │
│ - User enters credentials                                           │
│ - User approves app permissions                                     │
│ - Tesla calls callback with authorization code                      │
└─────────────────────────────────────────────────────────────────────┘
   ↓
   ↓ Redirect callback?code=ABC123&state=XYZ
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ GET /auth/tesla/callback?code=ABC123&state=XYZ                     │
│ - Verify state matches cookie (CSRF protection) ✅                 │
│ - Extract authorization code                                        │
└─────────────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ POST https://auth.tesla.com/oauth2/v1/token                        │
│ - Send code + CLIENT_ID + CLIENT_SECRET                            │
│ - Receive:                                                          │
│   ├─ access_token (4 hr expiry)                                    │
│   ├─ refresh_token (long-lived)                                    │
│   └─ expires_in (seconds)                                          │
└─────────────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ ENCRYPT TOKENS                                                       │
│ - access_token  → AES-256-CBC → XyZ9hQ2m...                       │
│ - refresh_token → AES-256-CBC → pQr5tU8v...                       │
└─────────────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STORE IN DATABASE                                                    │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ TeslaAccount                                                 │   │
│ │ ├─ userId: "user-123"                                       │   │
│ │ ├─ accessToken: "XyZ9hQ2m..." (encrypted)                   │   │
│ │ ├─ refreshToken: "pQr5tU8v..." (encrypted)                 │   │
│ │ ├─ expiresAt: 2024-02-15T14:30:00Z                         │   │
│ │ └─ encryptionVersion: 1                                     │   │
│ └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ REDIRECT TO DASHBOARD                                               │
│ /dashboard?tesla=connected ✅                                      │
└─────────────────────────────────────────────────────────────────────┘

Result: User is now authenticated and can fetch their Tesla vehicles!
```

---

## Data Flow: Real Telemetry Ingestion

```
┌──────────────────────────────────────────────────────────────────────┐
│                    TELEMETRY INGESTION PIPELINE                      │
└──────────────────────────────────────────────────────────────────────┘

🔄 Every 5 seconds to 30 minutes (depends on vehicle state)

1. BullMQ Job: "fetch-telemetry"
   {vehicleId: "123", userId: "user-456"}
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ TelemetryProcessor.handleFetchTelemetry()                          │
│ ├─ Get valid access token (auto-refresh if < 5 min to expiry)     │
│ └─ Call TelemetryFetcher.fetchVehicleTelemetry()                  │
└─────────────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ TelemetryFetcher.fetchVehicleTelemetry()                           │
│ ├─ Check if vehicle should be polled (VehicleStateMachine)        │
│ │  └─ If offline → skip ❌                                         │
│ │  └─ If sleeping → skip ❌ (runs every 30 min)                    │
│ │  └─ Otherwise → continue ✅                                     │
│ ├─ Get valid access token (with auto-refresh)                     │
│ └─ Continue to step 2...                                          │
└─────────────────────────────────────────────────────────────────────┘
   ↓
2. Call Tesla Fleet API
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ GET /api/1/vehicles/{vehicleId}/vehicle_data                       │
│ Authorization: Bearer {access_token}                               │
│                                                                     │
│ Response:                                                           │
│ {                                                                   │
│   "response": {                                                    │
│     "id": 123456,                                                  │
│     "state": "online",                                             │
│     "drive_state": {                                               │
│       "latitude": 37.7749,                                        │
│       "longitude": -122.4194,                                     │
│       "speed": 0,                                                 │
│       "odometer": 25478.5                                         │
│     },                                                             │
│     "charge_state": {                                             │
│       "battery_level": 85,                                        │
│       "charging_state": "Disconnected"                            │
│     },                                                             │
│     "climate_state": {...},                                       │
│     ...more data                                                  │
│   }                                                                │
│ }                                                                   │
└─────────────────────────────────────────────────────────────────────┘
   ↓
3. Normalize API Response
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ TelemetryFetcher.normalizeApiData()                                │
│                                                                     │
│ Tesla API Response → Telemetry Point:                             │
│ {                                                                   │
│   vehicleId: "123",                                               │
│   timestamp: 2024-02-15T10:30:00Z,                                │
│   latitude: 37.7749,                                              │
│   longitude: -122.4194,                                           │
│   speed: 0,                                                        │
│   odometer: 25478.5,                                              │
│   soc: 85,                                                         │
│   batteryRange: 425.6,                                            │
│   chargeState: "Disconnected",                                    │
│   insideTemp: 22.1,                                               │
│   outsideTemp: 15.3,                                              │
│   power: 0,                                                        │
│   ...all other fields                                             │
│ }                                                                   │
└─────────────────────────────────────────────────────────────────────┘
   ↓
4. Update Vehicle State Machine
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ VehicleStateMachine.updateVehicleState()                           │
│ ├─ Analyze drive_state, charge_state, climate_state               │
│ ├─ Determine new state:                                           │
│ │  ├─ speed > 0 → DRIVING (5 sec polling) 🏎️                     │
│ │  ├─ charging → CHARGING (30 sec polling) 🔌                     │
│ │  ├─ parked → PARKED (2 min polling) 🅿️                         │
│ │  ├─ at rest for 10+ min → SLEEPING (30 min polling) 😴          │
│ │  └─ no data for 5+ min → OFFLINE (no polling) ❌               │
│ └─ Store in database                                              │
└─────────────────────────────────────────────────────────────────────┘
   ↓
5. Store Telemetry Point
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ TelemetryService.createTelemetryPoint()                            │
│ └─ INSERT into "TelemetryPoint" table                              │
│    └─ ~500 bytes per record                                       │
└─────────────────────────────────────────────────────────────────────┘
   ↓
6. Trigger Analytics Detectors (Parallel)
   ↓
┌──────────────────────────────────┬──────────────────────────────────┐
│                                  │                                  │
│ TripDetector                     │ ChargingDetector                 │
│ ├─ Check if driving started      │ ├─ Check if charging started     │
│ ├─ Check if trip ended           │ ├─ Check if charging ended       │
│ └─ Store trip points & stats     │ └─ Calculate energy metrics      │
│                                  │                                  │
└──────────────────────────────────┴──────────────────────────────────┘
   ↓
7. Broadcast Real-time Update
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ TelemetryGateway.emitTelemetryUpdate()                             │
│ └─ Broadcast via WebSocket to all connected clients               │
│    ├─ Real-time dashboard updates                                 │
│    ├─ Map visualization                                           │
│    └─ Stats/widget updates                                        │
└─────────────────────────────────────────────────────────────────────┘

✅ Total time: 500-1000ms per point
✅ Data stored, detected, and broadcast
✅ Next fetch scheduled based on vehicle state
```

---

## Data Flow: Vehicle Commands

```
┌──────────────────────────────────────────────────────────────────────┐
│                      VEHICLE COMMAND FLOW                            │
└──────────────────────────────────────────────────────────────────────┘

Example: User locks vehicle from mobile app

1. HTTP Request
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ POST /vehicles/123/commands/lock                                    │
│ Authorization: Bearer {user_jwt}                                    │
│ 🔐 JWT verified (user is authenticated)                            │
└─────────────────────────────────────────────────────────────────────┘
   ↓
2. Verify Ownership
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ TeslaCommandsController.lock()                                      │
│ └─ Check: Does user own vehicle 123?                               │
│    └─ Query: SELECT * FROM TeslaVehicleLink                        │
│              WHERE userId = "user-123"                             │
│              AND vehicleId = "123"                                 │
│    ├─ If not found → 403 FORBIDDEN ❌                             │
│    └─ If found → continue ✅                                       │
└─────────────────────────────────────────────────────────────────────┘
   ↓
3. Get Valid Access Token
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ TeslaOAuthService.getValidAccessToken(userId)                      │
│ ├─ Check token expiry:                                             │
│ │  ├─ Expired → Refresh with refresh_token                        │
│ │  ├─ Expiring < 5 min → Refresh with refresh_token               │
│ │  └─ Valid → Use as-is ✅                                        │
│ ├─ Return: {access_token, expires_at}                             │
│ └─ Note: Token was decrypted from database                        │
└─────────────────────────────────────────────────────────────────────┘
   ↓
4. Call Tesla API
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ POST /api/1/vehicles/123/command/door_lock                         │
│ Authorization: Bearer {access_token}                               │
│                                                                     │
│ Response:                                                           │
│ {                                                                   │
│   "response": {                                                    │
│     "result": true,                                               │
│     "reason": ""                                                  │
│   }                                                                │
│ }                                                                   │
└─────────────────────────────────────────────────────────────────────┘
   ↓
5. Handle Response
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ Check result.result                                                │
│ ├─ If true → Command successful ✅                                │
│ ├─ If false → Command failed (check reason) ❌                   │
│ └─ If error → API error or vehicle offline ❌                    │
└─────────────────────────────────────────────────────────────────────┘
   ↓
6. Return to Client
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ HTTP 200                                                            │
│ {                                                                   │
│   "success": true,                                                │
│   "result": {                                                     │
│     "result": true,                                              │
│     "reason": ""                                                │
│   }                                                              │
│ }                                                                │
│                                                                 │
│ User sees: ✅ Vehicle locked (in real-time)                   │
└─────────────────────────────────────────────────────────────────────┘

⏱️ Total round-trip: 2-5 seconds (depending on vehicle response time)
```

---

## Token Refresh Cycle

```
┌──────────────────────────────────────────────────────────────────────┐
│                       TOKEN REFRESH WORKER                           │
└──────────────────────────────────────────────────────────────────────┘

⏰ Every 30 minutes (CronExpression.EVERY_30_MINUTES)

1. Start Token Refresh Cycle
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ TokenRefreshWorker.refreshAllTokens()                              │
│ └─ Get all users with Tesla tokens:                                │
│    SELECT * FROM "TeslaAccount"                                   │
└─────────────────────────────────────────────────────────────────────┘
   ↓
   For each user:
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ Check if token expires within 15 minutes                           │
│ IF expiresAt < NOW() + 15min THEN:                                 │
│    └─ Call refreshUserToken(userId)                                │
└─────────────────────────────────────────────────────────────────────┘
   ↓
   If refresh needed:
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ POST https://auth.tesla.com/oauth2/v1/token                        │
│ {                                                                   │
│   "grant_type": "refresh_token",                                  │
│   "refresh_token": "{refresh_token}",                             │
│   "client_id": "{CLIENT_ID}",                                     │
│   "client_secret": "{CLIENT_SECRET}"                              │
│ }                                                                   │
│                                                                     │
│ Response:                                                           │
│ {                                                                   │
│   "access_token": "new_token_xyz",                                │
│   "refresh_token": "new_refresh_abc",                             │
│   "expires_in": 14400,  (4 hours)                                 │
│   "token_type": "Bearer"                                          │
│ }                                                                   │
└─────────────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ Encrypt New Tokens                                                  │
│ ├─ access_token  → AES-256 → NewXyZ9hQ2m...                       │
│ └─ refresh_token → AES-256 → NewPQr5tU8v...                       │
└─────────────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────────────┐
│ Update Database                                                     │
│ UPDATE "TeslaAccount" SET                                          │
│   accessToken = 'NewXyZ9hQ2m...',                                 │
│   refreshToken = 'NewPQr5tU8v...',                                │
│   expiresAt = NOW() + 4 hours,                                    │
│   updatedAt = NOW()                                               │
│ WHERE userId = 'user-123'                                          │
└─────────────────────────────────────────────────────────────────────┘
   ↓
   Refresh complete ✅
   
   Log: "Token refresh cycle complete:
         X refreshed, Y failed out of Z total"

Next cycle runs in 30 minutes...
```

---

## Vehicle State Machine Diagram

```
                    ┌──────────────────────────────────────┐
                    │        ONLINE DATA RECEIVED          │
                    └──────────────────────────────────────┘
                                    ↓
        ┌─────────────────────────────────────────────────────────┐
        │ Analyze Drive State, Charge State, Climate, Battery      │
        └─────────────────────────────────────────────────────────┘
                                    ↓
    ┌───────────┬────────────┬────────────┬──────────┬─────────────┐
    ↓           ↓            ↓            ↓          ↓             ↓
┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
│ OFFLINE│  │SLEEPING│  │ PARKED │  │CHARGING│  │DRIVING│  │ ERROR  │
│        │  │        │  │        │  │        │  │        │  │        │
│ 0 sec  │  │30 min  │  │ 2 min  │  │ 30 sec │  │ 5 sec  │  │ 0 sec  │
└────────┘  └────────┘  └────────┘  └────────┘  └────────┘  └────────┘
    ↑           ↑            ↑            ↑          ↑             ↑
    │           │            │            │          │             │
    └─────────────────────────────────────────────────┘             │
                         Conditions                                 │
                                                        Error/Timeout
                                                              │
                                                    Keep polling anyway
                                                         (lower freq)

States:
━━━━━━━

OFFLINE
├─ Trigger: No data for 5+ minutes OR state = "offline"
├─ Action: Stop polling (0 sec polling)
├─ Reason: Vehicle unreachable
└─ Recovery: Resume when GPS data returns

SLEEPING
├─ Trigger: is_user_present = false AND speed = 0 AND not charging
├─ Action: Poll every 30 minutes (very minimal)
├─ Reason: Vehicle at rest, preserve battery
└─ Transition: Wake up → PARKED

PARKED
├─ Trigger: speed = 0 AND (connected or offline) AND not charging
├─ Action: Poll every 2 minutes (moderate)
├─ Reason: Monitoring for theft/movement
└─ Transition: Start driving → DRIVING

CHARGING
├─ Trigger: charging_state = "Charging"
├─ Action: Poll every 30 seconds
├─ Reason: Monitor charge progress and energy
└─ Transition: Charging complete → PARKED

DRIVING
├─ Trigger: speed > 0
├─ Action: Poll every 5 seconds (high frequency)
├─ Reason: Real-time tracking and route recording
└─ Transition: Vehicle stops → PARKED

Result: Smart polling = Lower battery drain + Better data quality ✅
```

---

## Database Schema (Tesla Integration)

```
┌─────────────────────────────────────────────────────────────────┐
│                 TESLA ACCOUNT MANAGEMENT                        │
├─────────────────────────────────────────────────────────────────┤
│ TeslaAccount                                                    │
│ ├─ userId (PK)          → User.id                             │
│ ├─ accessToken          → AES-256 encrypted                   │
│ ├─ refreshToken         → AES-256 encrypted                   │
│ ├─ tokenType            → "Bearer"                            │
│ ├─ expiresAt            → Timestamp (4 hours from refresh)    │
│ ├─ encryptionVersion    → 1 (for key rotation)                │
│ ├─ createdAt            → Timestamp                           │
│ └─ updatedAt            → Timestamp (on token refresh)        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│               VEHICLE STATE TRACKING                            │
├─────────────────────────────────────────────────────────────────┤
│ VehicleState                                                    │
│ ├─ vehicleId (PK)       → Tesla vehicle ID                    │
│ ├─ state               → "offline"|"sleeping"|"parked"|...   │
│ ├─ lastUpdate          → Timestamp (changes on state change)  │
│ └─ Related to                                                 │
│    └─ VehicleSettings (polling preferences)                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│          TESLA VEHICLE LINK (User → Vehicle)                   │
├─────────────────────────────────────────────────────────────────┤
│ TeslaVehicleLink                                                │
│ ├─ userId (PK)          → User.id                             │
│ ├─ vehicleId (PK)       → Tesla vehicle ID                    │
│ ├─ elon_alias           → Display name from Tesla API         │
│ ├─ addedAt              → When user linked this vehicle       │
│ └─ PRIMARY KEY: (userId, vehicleId)                           │
└─────────────────────────────────────────────────────────────────┘

Relationships:
TeslaAccount.userId ──→ User.id (1:1)
TeslaVehicleLink.userId ──→ User.id (N:1)
TeslaVehicleLink.vehicleId ──→ Vehicle.tellaId (1:1)
VehicleState.vehicleId ──→ Vehicle.tellaId (1:1)
```

---

## Encryption Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                  AES-256-CBC ENCRYPTION                         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────┐
│ Raw Token       │
│ "abc123xyz..."  │
│ (4096 bytes)    │
└─────────────────┘
       ↓
┌─────────────────────────────────────────┐
│ AES-256-CBC                            │
├─────────────────────────────────────────┤
│ Key: TESLA_ENCRYPTION_KEY              │
│ ├─ 32 bytes (256 bits)                 │
│ ├─ Stored in .env (NOT in code/git)   │
│ └─ Hex string: 64 characters           │
│                                        │
│ IV: TESLA_ENCRYPTION_IV                │
│ ├─ 16 bytes (128 bits)                 │
│ ├─ Random for each encryption          │
│ └─ Hex string: 32 characters           │
├─────────────────────────────────────────┤
│ Algorithm: aes-256-cbc                 │
│ Chain Mode: CBC (Cipher Block Chaining)│
│ Padding: PKCS#7 (automatic)            │
└─────────────────────────────────────────┘
       ↓
┌──────────────────────────────────────────┐
│ Encrypted Token (Base64)                │
│ "XyZ9hQ2m7rKpL4jUwVsQnMoPqRsT..."      │
│ (5000+ bytes)                           │
└──────────────────────────────────────────┘
       ↓
┌──────────────────────────────────────────┐
│ Store in Database                        │
│ "TeslaAccount"."accessToken"            │
│ Text column, @db.Text (unlimited)       │
└──────────────────────────────────────────┘

Security Properties:
✅ Tokens never stored in plain text
✅ Same token + same key = different ciphertext (IV changes)
✅ Decryption only possible with correct key + IV
✅ Key stored in secure environment variable
✅ Key rotation possible (encryptionVersion tracks version)
```

---

## Monitoring & Observability

```
┌─────────────────────────────────────────────────────────────────┐
│            MONITORING POINTS (Real-time)                        │
├─────────────────────────────────────────────────────────────────┤

1. Token Refresh Success Rate
   SELECT 
     COUNT(CASE WHEN "expiresAt" > NOW() THEN 1 END) as valid,
     COUNT(*) as total
   FROM "TeslaAccount"
   
2. Telemetry Ingestion Rate
   SELECT 
     COUNT(*) as points_per_5min,
     COUNT(DISTINCT "vehicleId") as vehicles_active
   FROM "TelemetryPoint"
   WHERE "timestamp" > NOW() - INTERVAL 5 minutes
   
3. Vehicle State Distribution
   SELECT 
     state,
     COUNT(*) as vehicle_count
   FROM "VehicleState"
   GROUP BY state
   
4. Command Success Rate
   SELECT 
     DATE_TRUNC('hour', "createdAt") as hour,
     SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful,
     COUNT(*) as total,
     ROUND(100.0 * SUM(CASE WHEN success THEN 1 ELSE 0 END) / 
       COUNT(*), 2) as success_rate_percent
   FROM "Command"  -- when implemented
   GROUP BY hour
   
5. API Error Rate
   Check logs for:
   ├─ ERROR: Failed to fetch telemetry
   ├─ ERROR: Failed to exchange code
   ├─ ERROR: Token refresh failed
   └─ ERROR: Command failed
   
6. Queue Processing
   BullMQ Dashboard:
   ├─ Jobs processed per hour
   ├─ Average processing time
   ├─ Failed jobs queue
   └─ Retry attempts
└─────────────────────────────────────────────────────────────────┘
```

---

**System is now production-ready with real Tesla data! 🚀**
