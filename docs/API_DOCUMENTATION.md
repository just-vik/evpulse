# EVPulse API Documentation

Complete REST API reference for production Tesla analytics platform.

## Authentication

All endpoints require JWT bearer token authentication.

### Login
```bash
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}

Response 200:
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "xyz123",
    "email": "user@example.com",
    "role": "user"
  }
}
```

### Headers for all requests
```
Authorization: Bearer {access_token}
Content-Type: application/json
```

## Telemetry Endpoints

### Get Latest Telemetry Point
```bash
GET /telemetry/{vehicleId}/latest
Authorization: Bearer {token}

Response 200:
{
  "id": "point123",
  "vehicleId": "vehicle456",
  "timestamp": "2026-03-09T10:30:00Z",
  "soc": 85.5,
  "speed": 65,
  "power": 8.5,
  "latitude": 37.7749,
  "longitude": -122.4194,
  "odometer": 25100,
  "batteryTemp": 22.5,
  "outsideTemp": 18.0
}
```

### Get Telemetry History
```bash
GET /telemetry/{vehicleId}/history
  ?startDate=2026-03-01&endDate=2026-03-09&downsample=false

Query Parameters:
  - startDate: ISO8601 date (default: 24h ago)
  - endDate: ISO8601 date (default: now)
  - downsample: boolean (default: false)
    - true: returns data every 10 seconds
    - false: returns all points

Response 200:
{
  "data": [
    {
      "id": "point123",
      "timestamp": "2026-03-09T10:00:00Z",
      "soc": 85,
      "speed": 0,
      ...
    },
    ...
  ],
  "count": 1440
}
```

### Get Telemetry Statistics
```bash
GET /telemetry/{vehicleId}/stats
  ?startDate=2026-03-08&endDate=2026-03-09

Response 200:
{
  "period": {
    "startTime": "2026-03-08T00:00:00Z",
    "endTime": "2026-03-09T00:00:00Z"
  },
  "pointCount": 1440,
  "battery": {
    "avg": 75.2,
    "min": 45.0,
    "max": 95.0
  },
  "speed": {
    "avg": 35.2,
    "min": 0,
    "max": 125
  },
  "power": {
    "avg": 2.1,
    "min": -12.5,
    "max": 10.0
  },
  "temp": {
    "avg": 22.1,
    "min": 18.0,
    "max": 28.5
  }
}
```

### Ingest Telemetry Point
```bash
POST /telemetry/{vehicleId}/ingest
Authorization: Bearer {token}
Content-Type: application/json

{
  "soc": 85.5,
  "speed": 65,
  "power": 8.5,
  "current": 120,
  "voltage": 350,
  "latitude": 37.7749,
  "longitude": -122.4194,
  "batteryTemp": 22.5,
  "outsideTemp": 18.0,
  "insideTemp": 21.0,
  "odometer": 25100,
  "heading": 180,
  "timestamp": "2026-03-09T10:30:00Z"
}

Response 201:
{
  "id": "point789",
  "vehicleId": "vehicle456",
  "timestamp": "2026-03-09T10:30:00Z",
  "soc": 85.5,
  ...
}
```

## Trips Endpoints

### Get Trips for Vehicle
```bash
GET /trips/vehicle/{vehicleId}
  ?limit=30

Query Parameters:
  - limit: number (default: 30, max: 100)

Response 200:
{
  "data": [
    {
      "id": "trip123",
      "vehicleId": "vehicle456",
      "startTime": "2026-03-09T10:00:00Z",
      "endTime": "2026-03-09T11:15:00Z",
      "startLocation": "37.7749,-122.4194",
      "endLocation": "37.7851,-122.4039",
      "startSoc": 85,
      "endSoc": 72,
      "distanceKm": 12.5,
      "energyUsedKwh": 2.8,
      "efficiencyWhkm": 224,
      "stats": {
        "avgSpeed": 45.2,
        "maxSpeed": 95,
        "regenEnergyKwh": 0.8,
        "elevationGain": 120,
        "drivingStyle": "normal"
      }
    }
  ],
  "count": 12
}
```

### Get Trip Statistics
```bash
GET /trips/vehicle/{vehicleId}/stats
  ?days=30

Query Parameters:
  - days: number (default: 30)

Response 200:
{
  "totalTrips": 48,
  "totalDistance": 1240.5,
  "averageDistance": 25.8,
  "totalEnergy": 285.2,
  "averageEnergy": 5.9,
  "averageEfficiency": 229,
  "period": {
    "startDate": "2026-02-07T00:00:00Z",
    "endDate": "2026-03-09T00:00:00Z"
  }
}
```

## Charging Endpoints

### Get Charging Sessions
```bash
GET /charging/vehicle/{vehicleId}/sessions
  ?limit=30

Response 200:
{
  "data": [
    {
      "id": "session123",
      "vehicleId": "vehicle456",
      "startTime": "2026-03-09T20:00:00Z",
      "endTime": "2026-03-09T23:30:00Z",
      "startSoc": 45,
      "endSoc": 95,
      "energyAddedKwh": 45.2,
      "maxPowerKw": 11.0,
      "chargerType": "wall_connector",
      "location": "Home",
      "cost": 5.87
    }
  ],
  "count": 24
}
```

### Get Charging Statistics
```bash
GET /charging/vehicle/{vehicleId}/stats
  ?days=30

Response 200:
{
  "totalSessions": 12,
  "totalEnergyAdded": 480.5,
  "averageEnergyPerSession": 40.0,
  "totalCost": 62.4,
  "averageCostPerSession": 5.2,
  "mostUsedCharger": "supercharger",
  "period": {
    "startDate": "2026-02-07T00:00:00Z",
    "endDate": "2026-03-09T00:00:00Z"
  }
}
```

## Battery Endpoints

### Get Battery Degradation Trend
```bash
GET /battery/vehicle/{vehicleId}/degradation
  ?days=90

Response 200:
{
  "vehicleId": "vehicle456",
  "period": {
    "startDate": "2025-12-09T00:00:00Z",
    "endDate": "2026-03-09T00:00:00Z",
    "days": 90
  },
  "samples": 15,
  "latestCapacity": 71.8,
  "latestDegradation": 4.3,
  "minCapacity": 71.2,
  "maxCapacity": 72.0,
  "degradationTrend": 0.1,
  "data": [
    {
      "timestamp": "2025-12-09T00:00:00Z",
      "capacity": 72.0,
      "degradation": 4.0,
      "method": "trip"
    }
  ]
}
```

### Get Charge Cycles
```bash
GET /battery/vehicle/{vehicleId}/cycles

Response 200:
{
  "vehicleId": "vehicle456",
  "estimatedFullCycles": 285.5,
  "estimatedCharges": 340,
  "averageChargePer": 84
}
```

### Detect Vampire Drain
```bash
GET /battery/vehicle/{vehicleId}/vampire-drain
  ?hours=8

Response 200:
{
  "vehicleId": "vehicle456",
  "detectedSessions": 6,
  "averageDrainPerHour": 0.2,
  "totalDrainThisWeek": 8.5,
  "events": [
    {
      "timestamp": "2026-03-08T08:00:00Z",
      "drain": 1.5,
      "drainPerHour": 0.19
    }
  ]
}
```

## Analytics Endpoints

### Get Energy History
```bash
GET /analytics/vehicle/{vehicleId}/energy-history
  ?days=30

Response 200:
{
  "vehicleId": "vehicle456",
  "period": {
    "startDate": "2026-02-07T00:00:00Z",
    "endDate": "2026-03-09T00:00:00Z",
    "days": 30
  },
  "dailyStats": [
    {
      "date": "2026-03-09T00:00:00Z",
      "distanceKm": 45.2,
      "energyUsedKwh": 8.5,
      "energyAddedKwh": 0,
      "efficiencyWhkm": 188
    }
  ],
  "summary": {
    "totalDistance": 1240.5,
    "totalEnergyUsed": 285.2,
    "totalEnergyAdded": 480.5,
    "averageEnergyPerDay": 9.5,
    "averageEfficiency": 230
  }
}
```

### Get Charging Costs
```bash
GET /analytics/vehicle/{vehicleId}/charging-costs
  ?rate=0.13

Query Parameters:
  - rate: number (USD per kWh, default: 0.13)

Response 200:
{
  "vehicleId": "vehicle456",
  "period": {
    "startDate": "2026-02-07T00:00:00Z",
    "endDate": "2026-03-09T00:00:00Z"
  },
  "electricityRate": 0.13,
  "totalEnergyAdded": 480.5,
  "estimatedCost": 62.47,
  "costPerKwh": 0.13,
  "chargerBreakdown": {
    "supercharger": {
      "count": 4,
      "energy": 200.5
    },
    "wall_connector": {
      "count": 8,
      "energy": 280.0
    }
  },
  "sessions": 12
}
```

## Error Responses

### 400 Bad Request
```json
{
  "statusCode": 400,
  "message": "Invalid request parameters",
  "error": "Bad Request"
}
```

### 401 Unauthorized
```json
{
  "statusCode": 401,
  "message": "Unauthorized",
  "error": "Unauthorized"
}
```

### 404 Not Found
```json
{
  "statusCode": 404,
  "message": "Vehicle not found",
  "error": "Not Found"
}
```

### 429 Too Many Requests
```json
{
  "statusCode": 429,
  "message": "Too many requests, please try again later",
  "error": "Too Many Requests"
}
```

### 500 Internal Server Error
```json
{
  "statusCode": 500,
  "message": "Internal server error",
  "error": "Internal Server Error"
}
```

## Rate Limiting

- **Limit**: 100 requests per 60 seconds per IP
- **Headers**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

## Pagination

List endpoints support pagination:
```
GET /endpoint?limit=50&offset=0
```

- `limit`: max 100 (default: 30)
- `offset`: pagination offset

Response:
```json
{
  "data": [...],
  "count": 150,
  "limit": 50,
  "offset": 0
}
```

## WebSocket Events

Connect to `/socket.io` with JWT token:

```javascript
const socket = io('http://localhost:3000', {
  auth: {
    token: 'your-jwt-token'
  }
});

// Subscribe to vehicle telemetry
socket.on('telemetry:update', (data) => {
  console.log('New telemetry:', data);
});

// Trip events
socket.on('trip:started', (trip) => {
  console.log('Trip started:', trip);
});

socket.on('trip:ended', (trip) => {
  console.log('Trip ended:', trip);
});

// Charging events
socket.on('charging:started', (session) => {
  console.log('Charging started:', session);
});

socket.on('charging:stopped', (session) => {
  console.log('Charging stopped:', session);
});
```

## Webhook Events (for SaaS)

```bash
POST /webhooks/events

{
  "event": "vehicle.telemetry",
  "vehicleId": "vehicle456",
  "data": {...},
  "timestamp": "2026-03-09T10:30:00Z"
}
```

Supported webhook events:
- `vehicle.telemetry`
- `trip.started`
- `trip.completed`
- `charging.started`
- `charging.completed`
- `battery.degradation_alert`
- `vampire_drain.detected`
