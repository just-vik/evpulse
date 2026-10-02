import { AIExecutorService } from '../src/ai/ai-executor.service';

/**
 * Regression tests for the P1.5a fail-closed fix (Oct 2026 AI authorization audit).
 * Before this commit, a Redis error in any of the four safety checks below was
 * swallowed (`catch { logger.warn(...) }`) and execution continued as if the check
 * had passed — the opposite of VehicleCommandThrottleGuard's existing fail-closed
 * contract for the equivalent human REST path. AIExecutorService had zero existing
 * tests before this commit.
 *
 * 'door_lock' is used as the test command throughout: it's in both COMMAND_MAP and
 * COMMAND_DOMAIN (domain 'doors', cooldown 30s), so all four checks are actually
 * exercised (a domain-less command would skip the cooldown check entirely).
 */
describe('AIExecutorService.execute — fail-closed safety checks', () => {
  function buildService(overrides: {
    redisGet?: jest.Mock;
    redisSetIfNotExists?: jest.Mock;
    redisGetNumber?: jest.Mock;
  } = {}) {
    const prisma = {
      vehicle: { findUnique: jest.fn().mockResolvedValue({ userId: 'user-1' }) },
      teslaVehicleLink: { findUnique: jest.fn().mockResolvedValue({ teslaVehicleId: 'TESLA123' }) },
      $executeRaw: jest.fn().mockResolvedValue(undefined),
    };
    const teslaOAuth = { getTokenForVehicle: jest.fn().mockResolvedValue('token-abc') };
    const teslaFleet = { lockVehicle: jest.fn().mockResolvedValue({ result: true }) };
    const redis = {
      get: overrides.redisGet ?? jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      setIfNotExists: overrides.redisSetIfNotExists ?? jest.fn().mockResolvedValue(true),
      getNumber: overrides.redisGetNumber ?? jest.fn().mockResolvedValue(0),
    };
    const service = new AIExecutorService(prisma as any, teslaOAuth as any, teslaFleet as any, redis as any);
    return { service, prisma, teslaOAuth, teslaFleet, redis };
  }

  it('happy path: all checks pass → command executes', async () => {
    const { service, teslaFleet } = buildService();
    const result = await service.execute('veh-1', 'user-1', 'door_lock', 'auto');
    expect(result).toEqual({ executed: true });
    expect(teslaFleet.lockVehicle).toHaveBeenCalledWith('TESLA123', 'token-abc');
  });

  it('circuit breaker: Redis error → fail-closed, not silently allowed', async () => {
    const redisGet = jest.fn().mockImplementation((key: string) =>
      key.startsWith('ai:block:') ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(null),
    );
    const { service, teslaFleet } = buildService({ redisGet });
    const result = await service.execute('veh-1', 'user-1', 'door_lock', 'auto');
    expect(result).toEqual({ executed: false, reason: 'safety check unavailable: circuit breaker' });
    expect(teslaFleet.lockVehicle).not.toHaveBeenCalled();
  });

  it('domain cooldown: Redis error → fail-closed, not silently allowed', async () => {
    const redisGet = jest.fn().mockImplementation((key: string) =>
      key.startsWith('ai:cooldown:') ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(null),
    );
    const { service, teslaFleet } = buildService({ redisGet });
    const result = await service.execute('veh-1', 'user-1', 'door_lock', 'auto');
    expect(result).toEqual({ executed: false, reason: 'safety check unavailable: domain cooldown' });
    expect(teslaFleet.lockVehicle).not.toHaveBeenCalled();
  });

  it('state lock: Redis error → fail-closed, not silently allowed', async () => {
    const redisSetIfNotExists = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { service, teslaFleet } = buildService({ redisSetIfNotExists });
    const result = await service.execute('veh-1', 'user-1', 'door_lock', 'auto');
    expect(result).toEqual({ executed: false, reason: 'safety check unavailable: state lock' });
    expect(teslaFleet.lockVehicle).not.toHaveBeenCalled();
  });

  it('hourly rate limit: Redis error → fail-closed, not silently allowed', async () => {
    const redisGetNumber = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { service, teslaFleet } = buildService({ redisGetNumber });
    const result = await service.execute('veh-1', 'user-1', 'door_lock', 'auto');
    expect(result).toEqual({ executed: false, reason: 'safety check unavailable: hourly rate limit' });
    expect(teslaFleet.lockVehicle).not.toHaveBeenCalled();
  });

  it('a safety-check failure never throws — callers get a normal typed result', async () => {
    // Important beyond "it blocks": AIAgentService's insight loop calls execute()
    // without its own try/catch around it — if this ever threw, one blocked
    // insight would abort processing of every other insight in the batch.
    const redisGet = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { service } = buildService({ redisGet });
    await expect(service.execute('veh-1', 'user-1', 'door_lock', 'auto')).resolves.toMatchObject({
      executed: false,
    });
  });
});
