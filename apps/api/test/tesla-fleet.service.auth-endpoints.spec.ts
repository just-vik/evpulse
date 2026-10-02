import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { TeslaFleetService } from '../src/tesla-fleet/tesla-fleet.service';

/**
 * Regression tests for the P1.4 fix: TESLA_TOKEN_URL/TESLA_AUTH_URL went from a `??`
 * fallback (silently defaulting to Tesla's deprecated auth.tesla.com/oauth2/v3/token
 * for server-side token exchange) to getOrThrow() — a misconfigured deployment must
 * fail to start, not quietly authenticate against the wrong endpoint. TeslaFleetService
 * had zero existing tests before this commit.
 */
describe('TeslaFleetService — Tesla auth endpoint configuration', () => {
  const DEPRECATED_TOKEN_URL = 'https://auth.tesla.com/oauth2/v3/token';
  const CORRECT_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
  const CORRECT_AUTH_URL = 'https://auth.tesla.com/oauth2/v3/authorize';

  function buildService(env: Record<string, string>) {
    const configService = new ConfigService(env);
    const httpService = { axiosRef: axios.create() } as any;
    const redis = {} as any;
    const metrics = { teslaApiRequestsTotal: { inc: jest.fn() } } as any;
    return () => new TeslaFleetService(httpService, configService, redis, metrics);
  }

  it('throws when TESLA_TOKEN_URL is missing (no silent fallback)', () => {
    const create = buildService({ TESLA_AUTH_URL: CORRECT_AUTH_URL });
    expect(create).toThrow();
  });

  it('throws when TESLA_AUTH_URL is missing (no silent fallback)', () => {
    const create = buildService({ TESLA_TOKEN_URL: CORRECT_TOKEN_URL });
    expect(create).toThrow();
  });

  it('constructs successfully when both are set, and uses the exact configured URLs', () => {
    const create = buildService({
      TESLA_TOKEN_URL: CORRECT_TOKEN_URL,
      TESLA_AUTH_URL: CORRECT_AUTH_URL,
      TESLA_CLIENT_ID: 'client-123',
    });

    let service!: TeslaFleetService;
    expect(() => { service = create(); }).not.toThrow();

    expect((service as any).tokenUrl).toBe(CORRECT_TOKEN_URL);
    expect((service as any).authUrl).toBe(CORRECT_AUTH_URL);

    // Public-API check for authUrl: getAuthorizationUrl() must build off the
    // exact configured value, not a default.
    const url = service.getAuthorizationUrl('state-abc');
    expect(url.startsWith(CORRECT_AUTH_URL)).toBe(true);
  });

  it('regression guard: omitting TESLA_TOKEN_URL never resolves to the deprecated auth.tesla.com endpoint', () => {
    // The actual defect this commit fixes: `?? 'https://auth.tesla.com/oauth2/v3/token'`
    // meant an unset TESLA_TOKEN_URL silently produced a *working-looking* service
    // pointed at the wrong endpoint. getOrThrow() means that path now throws instead
    // of ever assigning tokenUrl at all -- so there is no value to compare, which is
    // itself the guarantee: construction never completes, let alone with this value.
    const createMissing = buildService({ TESLA_AUTH_URL: CORRECT_AUTH_URL });
    expect(createMissing).toThrow();
  });

  it('getOrThrow does not second-guess an explicitly-configured value, even a wrong one', () => {
    // Confirms this fix is "require a value exists", not "validate which URL it is" --
    // that's a deliberate scope boundary (deployment config correctness is secrets/.env's
    // job, not this service's). An operator who explicitly sets the deprecated URL gets
    // exactly what they configured, same as before this fix.
    const create = buildService({
      TESLA_TOKEN_URL: DEPRECATED_TOKEN_URL,
      TESLA_AUTH_URL: CORRECT_AUTH_URL,
    });
    const service = create();
    expect((service as any).tokenUrl).toBe(DEPRECATED_TOKEN_URL);
  });
});
