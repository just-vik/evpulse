# Quick Start Guide - EVPulse Tesla Analytics

## 🚀 5-Minute Setup

### Prerequisites
- Node.js 18+ installed
- Docker & Docker Compose (OR PostgreSQL + Redis locally)
- Git

### Option 1: Docker Compose (Recommended)

```bash
# Clone/navigate to project
cd tesla-platform

# Start everything
docker-compose up -d

# Wait for services (10-15 seconds)
docker-compose logs -f backend

# API is ready at http://localhost:3000
```

### Option 2: Manual Setup

#### 1. Install Dependencies
```bash
cd backend
npm install
```

#### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your database credentials
```

#### 3. Start Database & Redis
```bash
# PostgreSQL (locally or container)
docker run -d \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  postgres:16-alpine

# Redis (locally or container)
docker run -d \
  -p 6379:6379 \
  redis:7-alpine
```

#### 4. Initialize Database
```bash
npm run prisma:generate
npm run prisma:migrate dev
```

#### 5. Start Server
```bash
npm run start:dev
```

Server ready at: **http://localhost:3000**

---

## 🧪 Test It Out

### 1. Health Check
```bash
curl http://localhost:3000/health
# Response: 200 OK
```

### 2. Register User
```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "test123",
    "firstName": "Test",
    "lastName": "User"
  }'

# Save access_token from response
```

### 3. Use Token (from now on)
```bash
export TOKEN="your-access-token-here"
```

### 4. Create Vehicle
```bash
curl -X POST http://localhost:3000/vehicles \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "vin": "5YJ3E1EAXPF123456",
    "model": "Model 3",
    "trim": "Standard Range Plus",
    "year": 2023
  }'

# Save vehicleId from response
export VEHICLE_ID="vehicle-id-here"
```

### 5. Ingest Telemetry
```bash
curl -X POST http://localhost:3000/telemetry/$VEHICLE_ID/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "soc": 85,
    "speed": 60,
    "power": 8.5,
    "latitude": 37.7749,
    "longitude": -122.4194,
    "odometer": 25000,
    "batteryTemp": 22,
    "outsideTemp": 18,
    "timestamp": "2026-03-09T10:30:00Z"
  }'
```

### 6. Get Latest Telemetry
```bash
curl http://localhost:3000/telemetry/$VEHICLE_ID/latest \
  -H "Authorization: Bearer $TOKEN"

# Response: latest telemetry point
```

### 7. Get Telemetry Statistics
```bash
curl 'http://localhost:3000/telemetry/'$VEHICLE_ID'/stats?startDate=2026-03-01&endDate=2026-03-09' \
  -H "Authorization: Bearer $TOKEN"

# Response: aggregated statistics
```

### 8. View in Swagger
Open browser: **http://localhost:3000/api/docs**

---

## 📊 Example API Calls

### Get Trip Statistics (after trip ends)
```bash
curl http://localhost:3000/trips/vehicle/$VEHICLE_ID/stats?days=7 \
  -H "Authorization: Bearer $TOKEN"
```

### Get Battery Degradation
```bash
curl http://localhost:3000/battery/vehicle/$VEHICLE_ID/degradation?days=30 \
  -H "Authorization: Bearer $TOKEN"
```

### Get Charging History
```bash
curl http://localhost:3000/charging/vehicle/$VEHICLE_ID/sessions \
  -H "Authorization: Bearer $TOKEN"
```

### Get Energy Analytics
```bash
curl http://localhost:3000/analytics/vehicle/$VEHICLE_ID/energy-history?days=30 \
  -H "Authorization: Bearer $TOKEN"
```

---

## 🔌 WebSocket Real-Time Updates

### Connect with JavaScript
```javascript
import io from 'socket.io-client';

const socket = io('http://localhost:3000', {
  auth: {
    token: 'your-access-token'
  }
});

// Listen for telemetry updates
socket.on('telemetry:update', (data) => {
  console.log('Telemetry:', data);
});

// Listen for trip events
socket.on('trip:started', (trip) => {
  console.log('Trip started:', trip);
});

socket.on('trip:ended', (trip) => {
  console.log('Trip ended:', trip);
});

// Listen for charging events
socket.on('charging:started', (session) => {
  console.log('Charging started:', session);
});

socket.on('charging:stopped', (session) => {
  console.log('Charging stopped:', session);
});
```

---

## 📚 Useful Commands

### View Database
```bash
npm run prisma:studio
# Opens browser UI at http://localhost:5555
```

### Run Migrations
```bash
npm run prisma:migrate dev
# Creates new migration

npm run prisma:migrate deploy
# Runs migrations in production
```

### View Logs
```bash
# Docker
docker-compose logs -f backend

# Development
npm run start:dev
```

### Reset Database (dev only)
```bash
npm run prisma:migrate reset
# WARNING: Deletes all data!
```

---

## 🧪 Load Testing

### Simulate Telemetry Stream
```bash
# Create a script to stream telemetry
for i in {1..100}; do
  curl -X POST http://localhost:3000/telemetry/$VEHICLE_ID/ingest \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "soc": '$(( 50 + $i % 50 ))',
      "speed": '$(( $i % 100 ))',
      "power": '$((5 + $i % 10))'.5,
      "latitude": 37.7749,
      "longitude": -122.4194,
      "odometer": '$((25000 + $i * 5))',
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    }'
  sleep 0.1
done
```

---

## 🐛 Troubleshooting

### Port Already in Use
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Or use different port
PORT=3001 npm run start:dev
```

### Database Connection Error
```bash
# Check PostgreSQL is running
psql $DATABASE_URL

# Or check Docker
docker ps | grep postgres
```

### Redis Connection Error
```bash
# Check Redis is running
redis-cli ping
# Response: PONG

# Or check Docker
docker ps | grep redis
```

### Prisma Migration Error
```bash
# Reset and retry
npm run prisma:migrate reset
npm run prisma:migrate dev
```

### Queue Issues
```bash
# Check BullMQ admin panel
curl http://localhost:3000/admin/queues
```

---

## 💡 Pro Tips

1. **Real-Time Dashboard**: Use WebSocket for live updates instead of polling
2. **Downsampling**: Add `?downsample=true` to telemetry endpoints for better mobile performance
3. **Batch Ingestion**: Send multiple telemetry points at once for better throughput
4. **Caching**: Use ETags for efficient client-side caching
5. **Rate Limiting**: Be aware of 100 req/60s limit per IP

---

## 📖 Documentation

- **Architecture**: See [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **API Reference**: See [`API_DOCUMENTATION.md`](API_DOCUMENTATION.md)
- **Database Schema**: See [`backend/prisma/schema.prisma`](backend/prisma/schema.prisma)
- **Implementation Details**: See [`IMPLEMENTATION_SUMMARY.md`](IMPLEMENTATION_SUMMARY.md)

---

## 🆘 Need Help?

- Check logs: `docker-compose logs backend`
- Review schema: `npm run prisma:studio`
- Test endpoints: http://localhost:3000/api/docs
- Check migrations: `npm run prisma:migrate status`

---

## 🚀 Deploy to Production

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for production deployment guide.

---

Happy tracking! 🚗💨
