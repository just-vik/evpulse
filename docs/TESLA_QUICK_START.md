# Tesla Fleet Integration - Quick Start Checklist

## ✅ Pre-Requirements

- [ ] Node.js 18+ installed
- [ ] PostgreSQL 14+ running
- [ ] Redis 6+ running
- [ ] Tesla developer account (https://developer.tesla.com)
- [ ] Backend directory (`cd backend`)

## ✅ Phase 1: Registration (5 minutes)

- [ ] Go to https://developer.tesla.com
- [ ] Create new OAuth application
- [ ] Fill in app details:
  - [ ] Name: "Tesla Analytics" (or your app name)
  - [ ] Redirect URI: `http://localhost:4000/auth/tesla/callback`
- [ ] Select scopes:
  - [ ] `offline_access` (for refresh tokens)
  - [ ] `vehicle_device_data` (read vehicle data)
  - [ ] `vehicle_commands` (send commands)
  - [ ] `vehicle_location` (read location)
- [ ] Copy Client ID and Client Secret

## ✅ Phase 2: Setup (5 minutes)

- [ ] Run setup script
  ```bash
  chmod +x tesla-setup.sh
  ./tesla-setup.sh
  ```
  
- [ ] Update `.env` file with:
  ```env
  TESLA_CLIENT_ID=<your_client_id>
  TESLA_CLIENT_SECRET=<your_client_secret>
  TESLA_ENCRYPTION_KEY=<from_script>
  TESLA_ENCRYPTION_IV=<from_script>
  ```

- [ ] Verify database is running
  ```bash
  npx prisma db push
  ```

## ✅ Phase 3: Run (2 minutes)

- [ ] Install dependencies (if needed)
  ```bash
  npm install
  ```

- [ ] Start development server
  ```bash
  npm run start:dev
  ```

- [ ] Watch for "NestJS started successfully" message

## ✅ Phase 4: Test OAuth (3 minutes)

- [ ] Open browser: http://localhost:4000/auth/tesla/login
- [ ] You'll be redirected to Tesla login
- [ ] Sign in with your Tesla account
- [ ] Grant app permissions
- [ ] You'll be redirected back to dashboard
- [ ] Check tokens stored:
  ```sql
  SELECT * FROM "TeslaAccount" WHERE "userId" = '<your_user_id>';
  ```

## ✅ Phase 5: Test Real Telemetry (2 minutes)

- [ ] Verify telemetry is flowing
  ```sql
  SELECT COUNT(*) as point_count, 
         MAX("timestamp") as latest
  FROM "TelemetryPoint"
  WHERE "vehicleId" = '<vehicle_id>'
  AND "timestamp" > NOW() - INTERVAL 5 minutes;
  ```

- [ ] Should see recent data points (not mock data)

- [ ] Check vehicle state
  ```sql
  SELECT "vehicleId", state, "lastUpdate"
  FROM "VehicleState"
  WHERE "vehicleId" = '<vehicle_id>';
  ```

## ✅ Phase 6: Test Commands (5 minutes)

### Test Lock Command

```bash
# Get your JWT token (from login response)
JWT=<your_jwt_token>
VEHICLE_ID=<vehicle_id>

# Lock vehicle
curl -X POST http://localhost:4000/vehicles/$VEHICLE_ID/commands/lock \
  -H "Authorization: Bearer $JWT"

# Response should be:
# { "success": true, "result": { "result": true } }
```

### Test Status Query

```bash
curl http://localhost:4000/vehicles/$VEHICLE_ID/commands/status \
  -H "Authorization: Bearer $JWT"

# Response:
# {
#   "success": true,
#   "vehicle": {
#     "locked": true,
#     "charging": false,
#     "speed": 0,
#     "soc": 85,
#     "temp": 22
#   }
# }
```

### Test Set Charge Limit

```bash
curl -X POST http://localhost:4000/vehicles/$VEHICLE_ID/commands/charge-limit \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"percent": 80}'
```

## ✅ Phase 7: Verify Data Flow

Check database shows real data:

```sql
-- Are we getting different SOC values?
SELECT DISTINCT soc FROM "TelemetryPoint"
WHERE "vehicleId" = '<vehicle_id>'
ORDER BY soc DESC;

-- Are we getting different locations?
SELECT COUNT(DISTINCT latitude) as location_count
FROM "TelemetryPoint"
WHERE "vehicleId" = '<vehicle_id>'
AND "timestamp" > NOW() - INTERVAL 1 hour;

-- Check trip detection worked
SELECT COUNT(*) as trips
FROM "Trip"
WHERE "vehicleId" = '<vehicle_id>'
AND "startTime" > NOW() - INTERVAL 7 days;
```

## ✅ Phase 8: Monitor Background Jobs

Check token refresh is running:

```bash
# Watch logs for "Token refresh cycle"
# Should see every 30 minutes:
# "Token refresh cycle complete: X refreshed, Y failed"
```

Check telemetry fetch jobs:

```bash
# Visit Redis Dashboard (if configured)
# Or check BullMQ boards for queue status

# In Redis CLI:
# KEYS bullmq:telemetry:*
# Should see job entries
```

## ⚙️ Troubleshooting

### OAuth redirect not working?
- [ ] Check TESLA_REDIRECT_URI matches in .env
- [ ] Verify TESLA_CLIENT_SECRET is correct
- [ ] Clear browser cookies and try again

### "Vehicle is offline"?
- [ ] Normal if vehicle is sleeping
- [ ] Check VehicleState.state = "sleeping"
- [ ] Drive vehicle to wake it up

### No telemetry data?
- [ ] Check tesla_accounts table has entries
- [ ] Check vehicle state is not "offline"
- [ ] Check logs for API errors

### Commands failing with 401?
- [ ] Token may have expired
- [ ] Check token refresh is running
- [ ] Re-authenticate via /auth/tesla/login

## 📊 Monitoring Commands

```bash
# Check all tokens
psql
SELECT 
  at."userId",
  at."expiresAt",
  (at."expiresAt" - NOW()) as "time_until_expiry"
FROM "TeslaAccount" at
ORDER BY at."expiresAt" ASC;

# Check telemetry flow
SELECT 
  "vehicleId",
  COUNT(*) as point_count,
  MAX("timestamp") as latest,
  (NOW() - MAX("timestamp")) as age
FROM "TelemetryPoint"
WHERE "timestamp" > NOW() - INTERVAL 1 hour
GROUP BY "vehicleId"
ORDER BY latest DESC;

# Check state machine
SELECT 
  "vehicleId",
  state,
  (CASE state
    WHEN 'driving' THEN '5s'
    WHEN 'charging' THEN '30s'
    WHEN 'parked' THEN '2m'
    WHEN 'sleeping' THEN '30m'
    WHEN 'offline' THEN 'none'
    ELSE 'unknown'
  END) as polling_interval,
  "lastUpdate"
FROM "VehicleState"
ORDER BY "lastUpdate" DESC;
```

## 🎯 Success Criteria

Once all phases complete, you should have:

✅ Real Tesla data flowing into database (not mock)
✅ Vehicle state machine preventing vampire drain
✅ Token refresh running automatically every 30 minutes
✅ Lock/unlock and other commands working
✅ Telemetry points with real GPS coordinates
✅ Trip detection working on real data
✅ Charging detection working on real data
✅ WebSocket broadcasting real updates

## 📚 Next Steps

1. Build frontend dashboard (see QUICKSTART.md)
2. Set up push notifications
3. Create automations engine
4. Add billing integration
5. Deploy to production

## 💬 Support

Refer to:
- `TESLA_INTEGRATION.md` - Detailed API documentation
- `TESLA_IMPLEMENTATION_SUMMARY.md` - Technical overview
- `ARCHITECTURE.md` - System design
- `API_DOCUMENTATION.md` - All endpoints

---

**Estimated total time**: 20 minutes from registration to fully working Tesla integration ⚡
