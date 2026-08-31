import { Controller, Get, Headers, Res, UnauthorizedException } from '@nestjs/common';
import { Response } from 'express';
import { MetricsService } from './metrics.service';

/** Prometheus scrape endpoint — strict secret policy (fail-closed). */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(@Headers('x-metrics-secret') secret: string | undefined, @Res() res: Response) {
    const expected = process.env.METRICS_SECRET;
    if (!expected || expected === 'change-me') {
      throw new UnauthorizedException('Metrics secret is not configured');
    }
    if (secret !== expected) {
      throw new UnauthorizedException('Invalid metrics secret');
    }
    res.set('Content-Type', this.metrics.contentType());
    res.send(await this.metrics.getMetrics());
  }
}
