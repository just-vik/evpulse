import { UnauthorizedException } from '@nestjs/common';
import { MetricsController } from '../src/metrics/metrics.controller';

describe('MetricsController security', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function makeRes() {
    return {
      set: jest.fn(),
      send: jest.fn(),
    };
  }

  it('должен отклонять запрос при незаданном METRICS_SECRET', async () => {
    delete process.env.METRICS_SECRET;
    const controller = new MetricsController({
      contentType: jest.fn().mockReturnValue('text/plain'),
      getMetrics: jest.fn().mockResolvedValue('ok'),
    } as any);

    await expect(controller.scrape(undefined, makeRes() as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('должен отклонять запрос с неверным secret', async () => {
    process.env.METRICS_SECRET = 'metrics-secret';
    const controller = new MetricsController({
      contentType: jest.fn().mockReturnValue('text/plain'),
      getMetrics: jest.fn().mockResolvedValue('ok'),
    } as any);

    await expect(controller.scrape('wrong', makeRes() as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('должен отдавать метрики при корректном secret', async () => {
    process.env.METRICS_SECRET = 'metrics-secret';
    const metrics = {
      contentType: jest.fn().mockReturnValue('text/plain'),
      getMetrics: jest.fn().mockResolvedValue('# metrics'),
    };
    const res = makeRes();
    const controller = new MetricsController(metrics as any);

    await controller.scrape('metrics-secret', res as any);

    expect(res.set).toHaveBeenCalledWith('Content-Type', 'text/plain');
    expect(res.send).toHaveBeenCalledWith('# metrics');
  });
});
