# Tesla Fleet API Integration

Complete guide for integrating Tesla's Fleet API into the Tesla Analytics platform.

## Overview

The Tesla Platform uses the official Tesla Fleet API to fetch real vehicle data and send commands. This replaces all mock telemetry with production-ready real data.

### Architecture

```
User OAuth Login
    ↓
Tesla Auth Server (auth.tesla.com)
    ↓
Authorization Code
    ↓
POST /auth/tesla/callback
    ↓
Exchange Code → Get Tokens
    ↓
AES-256 Encrypt Tokens
    ↓
Store in tesla_accounts Table
    ↓
Token Refresh Worker (every 30 min)
    ↓
TelemetryFetcher → Tesla Fleet API
    ↓
Vehicle Data
    ↓
TelemetryProcessor
    ↓
Trip Detection + Charging Detection
    ↓
Analytics + WebSocket Broadcast
```

## Setup Instructions

### 1. Register Your App with Tesla

1. Go to [Tesla Developer Portal](https://developer.tesla.com)
2. Create a new OAuth Application:
   - Name: "EV Analytics" (or your app name)
   - Redirect URI: `http://localhost:4000/auth/tesla/callback` (for development)
   - Scopes: Select all (vehicle_device_data, vehicle_commands, vehicle_location, offline_access)
3. Copy your Client ID and Client Secret

### 2. Generate Encryption Keys

The system uses AES-256-CBC to encrypt Tesla OAuth tokens at rest. Generate keys:

```bash
cd backend
npx ts-node -e "
const crypto = require('crypto');
const key = crypto.randomBytes(32).toString('hex');
const iv = crypto.randomBytes(16).toString('hex');
console.log('TESLA_ENCRYPTION_KEY=' + key);
console.log('TESLA_ENCRYPTION_IV=' + iv);
"
```

Save these values to `.env`:

```env
TESLA_ENCRYPTION_KEY=<your_key>
TESLA_ENCRYPTION_IV=<your_iv>
```

### 3. Configure Environment Variables

```env
# Tesla Developer App
TESLA_CLIENT_ID=<your_client_id>
TESLA_CLIENT_SECRET=<your_client_secret>
TESLA_REDIRECT_URI=http://localhost:4000/auth/tesla/callback

# Tesla API (default URLs, no need to change)
TESLA_API_BASE_URL=https://api.tesla.com
TESLA_AUTH_URL=https://auth.tesla.com

# Token Encryption
TESLA_ENCRYPTION_KEY=<generated_key>
TESLA_ENCRYPTION_IV=<generated_iv>
```

### 4. Start OAuth Flow

1. User visits `/auth/tesla/login`
2. Redirects to Tesla auth endpoint
3. User approves app
4. Callback to `/auth/tesla/callback` with authorization code
5. Exchange code for tokens
6. Encrypt and store tokens in database

## OAuth Flow Details

### Login Endpoint: `GET /auth/tesla/login`

Generates authorization URL and redirects user to Tesla auth server.

**Response**: Redirects to Tesla auth endpoint

### Callback Endpoint: `GET /auth/tesla/callback?code=XXX&state=YYY`

Handles OAuth callback after user approves app.

**Process**:
1. Validates CSRF token (state parameter)
2. Exchanges authorization code for access/refresh tokens
3. Encrypts tokens with AES-256
4. Stores in `tesla_accounts` table
5. Redirects to dashboard

**Security**:
- CSRF protection via state parameter
- Tokens encrypted before storage
- HttpOnly cookies for session
- Secure flag for HTTPS only

### Disconnect Endpoint: `POST /auth/tesla/disconnect`

Revokes Tesla authentication and removes tokens.

**Auth**: Requires JWT token
**Response**:
```json
{ "success": true }
```

### Status Endpoint: `GET /auth/tesla/status`

Check if user has active Tesla connection.

**Auth**: Requires JWT token
**Response**:
```json
{
  "connected": true,
  "expiresAt": "2024-02-15T10:30:00Z"
}
```

## Real Telemetry Ingestion

### Architecture: Vehicle State Machine

The system uses a state machine to control polling frequency and prevent vampire drain:

```
OFFLINE (0 sec polling)
   ↓
SLEEPING (1800 sec / 30 min)
   ↓
PARKED (120 sec / 2 min)
   ↓
CHARGING (30 sec)
   ↓
DRIVING (5 sec)
```

### State Determination Logic

From Tesla API response:
1. **OFFLINE**: No data received for 5+ minutes
2. **SLEEPING**: is_user_present=false, speed=0, not charging
3. **CHARGING**: charging_state includes "Charging"
4. **DRIVING**: speed > 0
5. **PARKED**: Default (at rest, connected)

### Data Fetching Process

1. Check if vehicle should be polled (not offline)
2. Get valid access token (refresh if < 5 min to expiry)
3. Call `vehicle_data` endpoint (let_it_sleep=true, no wake)
4. Normalize API response to telemetry point
5. Store telemetry point in database
6. Trigger trip detection
7. Trigger charging detection
8. Broadcast via WebSocket

### Telemetry Point Schema

```typescript
{
  vehicleId: string;
  timestamp: Date;
  
  // Location
  latitude: number;
  longitude: number;
  heading: number;
  
  // Speed & Distance
  speed: number;
  odometer: number;
  
  // Battery/Charge
  soc: number; // State of Charge %
  batteryRange: number; // km
  estimatedBatteryRange: number;
  chargeRateKmph: number;
  chargeState: string; // "Charging" | "Complete" | "Disconnected"
  chargePortOpen: boolean;
  chargeStartSoc: number;
  chargeStartRangeKm: number;
  chargerPower: number; // kW
  chargeLimitSoc: number; // %
  chargerVoltage: number; // Volts
  chargerCurrent: number; // Amps
  
  // Climate
  insideTemp: number; // °C
  outsideTemp: number; // °C
  driverTempSetting: number;
  passengerTempSetting: number;
  isClimateOn: boolean;
  isFrontDefrosterOn: boolean;
  isRearDefrosterOn: boolean;
  
  // Battery Health
  lowBatteryWarning: boolean;
  batteryHeaterOn: boolean;
  
  // Power Calculation
  power: number; // kW = voltage * current / 1000
}
```

## Vehicle Commands

Control vehicle remotely via REST API.

### Endpoints

All endpoints require JWT authentication and vehicle ownership.

#### Lock: `POST /vehicles/:id/commands/lock`

Lock the vehicle doors.

```bash
curl -X POST http://localhost:4000/vehicles/123/commands/lock \
  -H "Authorization: Bearer <your_jwt>"
```

**Response**:
```json
{
  "success": true,
  "result": {
    "result": true,
    "reason": ""
  }
}
```

#### Unlock: `POST /vehicles/:id/commands/unlock`

Unlock the vehicle doors.

```bash
curl -X POST http://localhost:4000/vehicles/123/commands/unlock \
  -H "Authorization: Bearer <your_jwt>"
```

#### Start Charging: `POST /vehicles/:id/commands/start-charging`

Start charging the vehicle.

```bash
curl -X POST http://localhost:4000/vehicles/123/commands/start-charging \
  -H "Authorization: Bearer <your_jwt>"
```

#### Stop Charging: `POST /vehicles/:id/commands/stop-charging`

Stop charging the vehicle.

```bash
curl -X POST http://localhost:4000/vehicles/123/commands/stop-charging \
  -H "Authorization: Bearer <your_jwt>"
```

#### Set Charge Limit: `POST /vehicles/:id/commands/charge-limit`

Set battery charge limit (0-100%).

```bash
curl -X POST http://localhost:4000/vehicles/123/commands/charge-limit \
  -H "Authorization: Bearer <your_jwt>" \
  -H "Content-Type: application/json" \
  -d '{ "percent": 80 }'
```

#### Climate Control: `POST /vehicles/:id/commands/climate`

Start/stop climate control or set temperatures.

```bash
# Start climate
curl -X POST http://localhost:4000/vehicles/123/commands/climate \
  -H "Authorization: Bearer <your_jwt>" \
  -H "Content-Type: application/json" \
  -d '{ "action": "start" }'

# Set temperatures (both driver and passenger)
curl -X POST http://localhost:4000/vehicles/123/commands/climate \
  -H "Authorization: Bearer <your_jwt>" \
  -H "Content-Type: application/json" \
  -d '{ "driverTemp": 22.5, "passengerTemp": 22.5 }'
```

#### Flash Lights: `POST /vehicles/:id/commands/flash-lights`

Flash vehicle lights.

```bash
curl -X POST http://localhost:4000/vehicles/123/commands/flash-lights \
  -H "Authorization: Bearer <your_jwt>"
```

#### Honk Horn: `POST /vehicles/:id/commands/honk`

Honk the vehicle horn.

```bash
curl -X POST http://localhost:4000/vehicles/123/commands/honk \
  -H "Authorization: Bearer <your_jwt>"
```

#### Frunk: `POST /vehicles/:id/commands/frunk`

Open the front trunk (frunk).

```bash
curl -X POST http://localhost:4000/vehicles/123/commands/frunk \
  -H "Authorization: Bearer <your_jwt>"
```

#### Trunk: `POST /vehicles/:id/commands/trunk`

Open the rear trunk.

```bash
curl -X POST http://localhost:4000/vehicles/123/commands/trunk \
  -H "Authorization: Bearer <your_jwt>"
```

#### Command Status: `GET /vehicles/:id/commands/status`

Get current vehicle status (locked, charging, speed, SOC, temp).

```bash
curl http://localhost:4000/vehicles/123/commands/status \
  -H "Authorization: Bearer <your_jwt>"
```

**Response**:
```json
{
  "success": true,
  "vehicle": {
    "locked": true,
    "charging": false,
    "speed": 0,
    "soc": 85,
    "temp": 22
  }
}
```

## Token Management

### Token Storage

Tokens are stored in the `tesla_accounts` table with encryption:

```prisma
model TeslaAccount {
  userId            String    @id
  accessToken       String    @db.Text // AES-256 encrypted
  refreshToken      String    @db.Text // AES-256 encrypted
  tokenType         String    // "Bearer"
  expiresAt         DateTime
  encryptionVersion Int       // For key rotation
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  
  user              User      @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

### Token Refresh

Tokens are automatically refreshed:
- **Trigger**: Every 30 minutes or within 5 minutes of expiry
- **Process**: Use refresh_token to get new access_token
- **Storage**: Encrypted and re-stored
- **Retry**: Automatic retry on failure (up to 3 times)

### Token Revocation

When user disconnects Tesla:
1. Remove tokens from database
2. Tesla marks tokens as revoked (optional - Tesla may not support)
3. Future API calls will fail with unauthorized

## Error Handling

### API Errors

Common Tesla API error responses:

```json
{
  "error": "invalid_grant",
  "error_description": "Invalid authorization code"
}

{
  "error": "invalid_token",
  "error_description": "Invalid token"
}

{
  "result": false,
  "reason": "Vehicle is offline"
}
```

### Retry Strategy

For transient failures:
- **Network errors**: Retry up to 3 times with exponential backoff (1s, 2s, 4s)
- **Vehicle offline**: Skip polling for that cycle
- **Invalid token**: Trigger token refresh and retry once
- **Rate limit (429)**: Back off for 30 seconds

## Monitoring & Debugging

### Enable Debug Logging

```bash
export DEBUG=tesla-platform:*
npm run start:dev
```

### Check Token Status

```bash
curl http://localhost:4000/auth/tesla/status \
  -H "Authorization: Bearer <your_jwt>"
```

### Monitor Data Flow

Check telemetry in database:

```sql
SELECT * FROM "TelemetryPoint"
WHERE "vehicleId" = '123'
ORDER BY "timestamp" DESC
LIMIT 10;
```

### Check Polling Frequency

```sql
SELECT 
  "vehicleId",
  state,
  "lastUpdate",
  (((24*3600) / 
    CASE state
      WHEN 'driving' THEN 5
      WHEN 'charging' THEN 30
      WHEN 'parked' THEN 120
      WHEN 'sleeping' THEN 1800
      ELSE 999999
    END)::int) as "pointsPerDay"
FROM "VehicleState"
ORDER BY "vehicleId";
```

## Data Privacy & Security

### Encryption

- **Tokens**: AES-256-CBC encrypted before storage
- **Encryption Keys**: Should be stored in secrets manager (AWS Secrets Manager, HashiCorp Vault)
- **Database**: Should be encrypted at rest

### Access Control

- **OAuth scopes**: Limited to required vehicle data and commands only
- **Vehicle ownership**: Verified before every command
- **User authentication**: JWT with 7-day expiry + 30-day refresh

### Audit Logging

All commands are logged with:
- User ID
- Vehicle ID
- Command type
- Timestamp
- Success/failure

### Rate Limiting

- **OAuth callback**: 10 per minute per IP
- **Vehicle commands**: 10 per minute per vehicle
- **Telemetry fetch**: Respects Tesla's API limits (calls don't count against rate limits)

## Troubleshooting

### "Invalid authorization code"

**Cause**: Authorization code expired (valid for 10 minutes)
**Solution**: Restart OAuth flow

### "Invalid token"

**Cause**: Token is expired or revoked
**Solution**: User must re-authenticate via `/auth/tesla/login`

### "Vehicle is offline"

**Cause**: Vehicle is sleeping or no cellular connection
**Solution**: Normal - will re-poll when vehicle wakes up

### Tokens not encrypting/decrypting

**Cause**: Wrong encryption keys or version mismatch
**Solution**: 
```bash
# Check encryption key is set
echo $TESLA_ENCRYPTION_KEY
echo $TESLA_ENCRYPTION_IV

# Regenerate if needed
npx ts-node -e "
const crypto = require('crypto');
const key = crypto.randomBytes(32).toString('hex');
const iv = crypto.randomBytes(16).toString('hex');
console.log('TESLA_ENCRYPTION_KEY=' + key);
console.log('TESLA_ENCRYPTION_IV=' + iv);
"
```

### API calls failing with 401

**Cause**: Token refresh failed
**Solution**: 
1. Check TESLA_CLIENT_SECRET is correct
2. Verify token refresh is running
3. Check database for tesla_accounts record

## References

- [Tesla Fleet API Documentation](https://developer.tesla.com/docs/fleet-api)
- [OAuth 2.0 Specification](https://tools.ietf.org/html/rfc6749)
- [AES-256 Encryption](https://en.wikipedia.org/wiki/Advanced_Encryption_Standard)
