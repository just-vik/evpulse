import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { VehicleCommandThrottleGuard } from '../src/common/guards/vehicle-command-throttle.guard';

function makeContext(params: { id?: string } = { id: 'v1' }, user: { id?: string } | null = { id: 'u1' }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ params, user }),
    }),
  } as unknown as ExecutionContext;
}

describe('VehicleCommandThrottleGuard', () => {
  it('пропускает команду, когда лимит не превышен', async () => {
    const redis = { get: jest.fn().mockResolvedValue('3'), setex: jest.fn(), incr: jest.fn().mockResolvedValue(4) };
    const guard = new VehicleCommandThrottleGuard(redis as any);

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(redis.incr).toHaveBeenCalledWith('command-rate:v1:u1:count');
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('устанавливает окно при первой команде (count=0)', async () => {
    const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn(), incr: jest.fn() };
    const guard = new VehicleCommandThrottleGuard(redis as any);

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(redis.setex).toHaveBeenCalledWith('command-rate:v1:u1:count', 60, '1');
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('блокирует команду с 429, когда лимит (10/60с) превышен', async () => {
    const redis = { get: jest.fn().mockResolvedValue('10'), setex: jest.fn(), incr: jest.fn() };
    const guard = new VehicleCommandThrottleGuard(redis as any);

    await expect(guard.canActivate(makeContext())).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    // Превышение лимита не должно продлевать/увеличивать окно.
    expect(redis.setex).not.toHaveBeenCalled();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('блокирует команду с 503 (fail-closed), когда Redis недоступен', async () => {
    const redis = { get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')), setex: jest.fn(), incr: jest.fn() };
    const guard = new VehicleCommandThrottleGuard(redis as any);

    let caught: unknown;
    try {
      await guard.canActivate(makeContext());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    // Явно проверяем регрессию "fail-open": Redis-ошибка не должна пропускать команду.
    expect(caught).not.toBe(true);
  });

  it('блокирует команду с 503, когда incr на существующем окне падает', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue('5'),
      setex: jest.fn(),
      incr: jest.fn().mockRejectedValue(new Error('READONLY replica')),
    };
    const guard = new VehicleCommandThrottleGuard(redis as any);

    await expect(guard.canActivate(makeContext())).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });

  it('отвечает 400, если vehicleId или userId отсутствуют', async () => {
    const redis = { get: jest.fn(), setex: jest.fn(), incr: jest.fn() };
    const guard = new VehicleCommandThrottleGuard(redis as any);

    await expect(guard.canActivate(makeContext({ id: undefined }, { id: 'u1' }))).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    await expect(guard.canActivate(makeContext({ id: 'v1' }, null))).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    expect(redis.get).not.toHaveBeenCalled();
  });
});
