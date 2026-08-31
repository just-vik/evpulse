import { DlqReplayCronService } from '../src/queues/dlq-replay.cron';

describe('DlqReplayCronService', () => {
  it('должен реплеить записи из унифицированного dlq:jobs:telemetry', async () => {
    const redis = {
      llen: jest.fn().mockResolvedValue(1),
      lrange: jest.fn().mockResolvedValue([
        JSON.stringify({
          jobName: 'pipeline:trip-detector',
          data: { vehicleId: 'veh-1', data: { timestamp: '2026-03-20T10:00:00.000Z', soc: 50 } },
          error: 'boom',
          retryCount: 0,
          nextRetryAt: 0,
          firstFailedAt: Date.now(),
        }),
      ]),
      lrem: jest.fn().mockResolvedValue(1),
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
      rpush: jest.fn().mockResolvedValue(1),
    };
    const pipeline = {
      processBatch: jest.fn().mockResolvedValue(undefined),
    };

    const service = new DlqReplayCronService(redis as any, pipeline as any);
    await service.replayDlq();

    expect(redis.llen).toHaveBeenCalledWith('dlq:jobs:telemetry');
    expect(pipeline.processBatch).toHaveBeenCalledWith(
      'veh-1',
      [{ timestamp: '2026-03-20T10:00:00.000Z', soc: 50 }],
      'fleet_telemetry',
      expect.stringContaining('dlq-replay-'),
    );
    expect(redis.lrem).toHaveBeenCalled();
  });
});
