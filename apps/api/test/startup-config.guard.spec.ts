import { StartupConfigGuard } from '../src/config/startup-config.guard';

describe('StartupConfigGuard', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('должен падать при незаданном обязательном секрете', () => {
    process.env.TESLA_FLEET_WEBHOOK_SECRET = 'ok';
    process.env.FLEET_INTERNAL_TOKEN = '';
    process.env.METRICS_SECRET = 'ok';

    const guard = new StartupConfigGuard();
    expect(() => guard.onModuleInit()).toThrow('[startup-config] Missing or insecure FLEET_INTERNAL_TOKEN');
  });

  it('должен падать при дефолтном change-me', () => {
    process.env.TESLA_FLEET_WEBHOOK_SECRET = 'ok';
    process.env.FLEET_INTERNAL_TOKEN = 'ok';
    process.env.METRICS_SECRET = 'change-me';
    process.env.TESLA_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
    process.env.TESLA_AUTH_URL = 'https://auth.tesla.com/oauth2/v3/authorize';

    const guard = new StartupConfigGuard();
    expect(() => guard.onModuleInit()).toThrow('[startup-config] Missing or insecure METRICS_SECRET');
  });

  // P1.4 (Oct 2026): TESLA_TOKEN_URL/TESLA_AUTH_URL added as required startup config —
  // Tesla's auth endpoints are deployment configuration, not application defaults, and
  // TESLA_TOKEN_URL in particular must never silently fall back to Tesla's deprecated
  // auth.tesla.com/oauth2/v3/token (see tesla-fleet.service.ts).
  it('должен падать при незаданном TESLA_TOKEN_URL', () => {
    process.env.TESLA_FLEET_WEBHOOK_SECRET = 'ok';
    process.env.FLEET_INTERNAL_TOKEN = 'ok';
    process.env.METRICS_SECRET = 'ok';
    process.env.TESLA_TOKEN_URL = '';
    process.env.TESLA_AUTH_URL = 'https://auth.tesla.com/oauth2/v3/authorize';

    const guard = new StartupConfigGuard();
    expect(() => guard.onModuleInit()).toThrow('[startup-config] Missing or insecure TESLA_TOKEN_URL');
  });

  it('должен падать при незаданном TESLA_AUTH_URL', () => {
    process.env.TESLA_FLEET_WEBHOOK_SECRET = 'ok';
    process.env.FLEET_INTERNAL_TOKEN = 'ok';
    process.env.METRICS_SECRET = 'ok';
    process.env.TESLA_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
    process.env.TESLA_AUTH_URL = '';

    const guard = new StartupConfigGuard();
    expect(() => guard.onModuleInit()).toThrow('[startup-config] Missing or insecure TESLA_AUTH_URL');
  });

  it('должен проходить при валидных секретах и Tesla auth endpoints', () => {
    process.env.TESLA_FLEET_WEBHOOK_SECRET = 'whsec-123';
    process.env.FLEET_INTERNAL_TOKEN = 'internal-123';
    process.env.METRICS_SECRET = 'metrics-123';
    process.env.TESLA_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
    process.env.TESLA_AUTH_URL = 'https://auth.tesla.com/oauth2/v3/authorize';

    const guard = new StartupConfigGuard();
    expect(() => guard.onModuleInit()).not.toThrow();
  });
});
