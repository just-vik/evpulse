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

    const guard = new StartupConfigGuard();
    expect(() => guard.onModuleInit()).toThrow('[startup-config] Missing or insecure METRICS_SECRET');
  });

  it('должен проходить при валидных секретах', () => {
    process.env.TESLA_FLEET_WEBHOOK_SECRET = 'whsec-123';
    process.env.FLEET_INTERNAL_TOKEN = 'internal-123';
    process.env.METRICS_SECRET = 'metrics-123';

    const guard = new StartupConfigGuard();
    expect(() => guard.onModuleInit()).not.toThrow();
  });
});
