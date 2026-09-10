import { HttpStatus } from '@nestjs/common';
import { TeslaCommandsController } from '../src/tesla-fleet/tesla-commands.controller';

/**
 * Minimal in-memory stand-in for the raw ioredis client, just enough to
 * exercise the NX-claim / replay / release semantics withIdempotency()
 * relies on. TTL (EX) is intentionally not modeled — sizing the window is
 * a separate concern from the dedup logic under test here.
 */
class FakeRedis {
  private store = new Map<string, string>();

  async set(key: string, value: string, ...args: any[]): Promise<'OK' | null> {
    const nx = args.includes('NX');
    if (nx && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

function makeController(overrides: { lockVehicle?: jest.Mock } = {}) {
  const lockVehicle = overrides.lockVehicle ?? jest.fn().mockResolvedValue({ ok: true });

  const teslaFleet = { lockVehicle } as any;
  const teslaOAuth = { getValidAccessToken: jest.fn().mockResolvedValue('tok') } as any;
  const prisma = {
    teslaVehicleLink: {
      findUnique: jest.fn().mockResolvedValue({
        vehicleId: 'v1',
        teslaVehicleId: 'tv1',
        teslaAccount: { userId: 'u1' },
      }),
    },
  } as any;
  const redis = {} as any; // RedisService wrapper — unused on the lock() path
  const stateMachine = {} as any;
  const telemetryFetcher = {} as any;
  const commandsService = { recordHistory: jest.fn().mockResolvedValue(undefined) } as any;
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) } as any;
  const rawRedis = new FakeRedis() as any;
  const apiUsage = { trackCommand: jest.fn().mockResolvedValue(undefined) } as any;

  const controller = new TeslaCommandsController(
    teslaFleet,
    teslaOAuth,
    prisma,
    redis,
    stateMachine,
    telemetryFetcher,
    commandsService,
    auditLog,
    rawRedis,
    apiUsage,
  );

  return { controller, lockVehicle, rawRedis };
}

const req = { user: { id: 'u1' } };

describe('TeslaCommandsController — Idempotency-Key dedup', () => {
  it('вызывает Tesla ровно один раз при повторе с тем же ключом', async () => {
    const { controller, lockVehicle } = makeController();

    const first = await controller.lock('v1', req, 'key-abc');
    const second = await controller.lock('v1', req, 'key-abc');

    expect(lockVehicle).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('вызывает Tesla повторно, если Idempotency-Key другой', async () => {
    const { controller, lockVehicle } = makeController();

    await controller.lock('v1', req, 'key-1');
    await controller.lock('v1', req, 'key-2');

    expect(lockVehicle).toHaveBeenCalledTimes(2);
  });

  it('вызывает Tesla при каждом запросе, если Idempotency-Key не передан', async () => {
    const { controller, lockVehicle } = makeController();

    await controller.lock('v1', req, undefined);
    await controller.lock('v1', req, undefined);

    expect(lockVehicle).toHaveBeenCalledTimes(2);
  });

  it('отвечает 409 и не зовёт Tesla второй раз, пока первый запрос с тем же ключом ещё выполняется', async () => {
    const { controller, lockVehicle, rawRedis } = makeController();
    let releaseFirst!: (v: unknown) => void;
    lockVehicle.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));

    const firstCall = controller.lock('v1', req, 'in-flight');
    // Flush the microtask/macrotask queue so the NX claim inside
    // withIdempotency() has actually landed before we race the second call.
    await new Promise((r) => setTimeout(r, 0));

    await expect(controller.lock('v1', req, 'in-flight')).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
    });
    expect(lockVehicle).toHaveBeenCalledTimes(1);

    releaseFirst({ ok: true });
    await expect(firstCall).resolves.toEqual({ success: true, result: { ok: true } });

    // Claim resolved to 'done' — a later request with the same key now replays it.
    const third = await controller.lock('v1', req, 'in-flight');
    expect(lockVehicle).toHaveBeenCalledTimes(1);
    expect(third).toEqual({ success: true, result: { ok: true } });
    void rawRedis; // kept for readability of the fixture; no direct assertions on internals
  });

  it('освобождает ключ при ошибке, чтобы повтор реально дошёл до Tesla', async () => {
    const lockVehicle = jest.fn()
      .mockRejectedValueOnce(new Error('vehicle asleep'))
      .mockResolvedValueOnce({ ok: true });
    const { controller } = makeController({ lockVehicle });

    await expect(controller.lock('v1', req, 'retry-key')).rejects.toBeTruthy();
    const retried = await controller.lock('v1', req, 'retry-key');

    expect(lockVehicle).toHaveBeenCalledTimes(2);
    expect(retried).toEqual({ success: true, result: { ok: true } });
  });
});
