import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT, 10) || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',

  jwt: {
    secret: process.env.JWT_SECRET || 'evpulse-super-secret-key-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'evpulse-refresh-secret-change-in-production',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD,
  },

  tesla: {
    clientId: process.env.TESLA_CLIENT_ID,
    clientSecret: process.env.TESLA_CLIENT_SECRET,
    redirectUri: process.env.TESLA_REDIRECT_URI || 'http://localhost:4000/api/v1/auth/tesla/callback',
    apiBaseUrl: process.env.TESLA_API_BASE_URL || 'https://owner-api.teslamotors.com',
    authUrl: process.env.TESLA_AUTH_URL || 'https://auth.tesla.com',
    // Adaptive REST polling intervals (milliseconds).
    // Only apply when fleet telemetry is NOT streaming (fleet live suppresses REST polls).
    // Tune via env to debug specific issues without code changes.
    polling: {
      drivingMs:    parseInt(process.env.TESLA_POLL_INTERVAL_DRIVING_MS  ?? '', 10) || 2 * 60_000,   // 2 min
      chargingMs:   parseInt(process.env.TESLA_POLL_INTERVAL_CHARGING_MS ?? '', 10) || 15 * 60_000,  // 15 min
      parkedMs:     parseInt(process.env.TESLA_POLL_INTERVAL_PARKED_MS   ?? '', 10) || 5 * 60_000,   // 5 min (was 30 min — reduced to catch charging start faster)
      forceFetchMs: parseInt(process.env.TESLA_FORCE_FETCH_AFTER_MS      ?? '', 10) || 30 * 60_000,  // 30 min staleness threshold
    },
  },

  database: {
    url: process.env.DATABASE_URL,
  },

  telemetry: {
    // Set OTEL_ENABLED=false to disable OpenTelemetry entirely (e.g. plain self-hosted without Tempo).
    enabled:     process.env.OTEL_ENABLED !== 'false',
    endpoint:    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://tempo:4318',
    serviceName: process.env.OTEL_SERVICE_NAME            ?? 'evpulse-api',
  },
}));
