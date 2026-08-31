import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';

@Injectable()
export class FleetTelemetryService {
  private readonly logger = new Logger(FleetTelemetryService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Mark fleet telemetry as live for this VIN (5-min TTL). REST polling will skip when live.
   *  Also clears any sleep-confirmed cache — if fleet data is arriving, the car is awake. */
  async markVehicleLive(vin: string): Promise<void> {
    await Promise.all([
      this.redis.set(`fleet:live:vin:${vin}`, '1', 'EX', 300),
      this.redis.del(`tesla:sleep-confirmed:vin:${vin}`),
    ]);
  }

  async handleIncomingPayload(payload: any) {
    const events = Array.isArray(payload) ? payload : [payload];

    for (const evt of events) {
      try {
        const payloadJson = JSON.stringify(evt);
        // Пишем событие в Redis Stream — FleetTelemetryWorker читает через XREADGROUP
        await this.redis.xadd('fleet:telemetry', '*', 'payload', payloadJson);
      } catch (error: any) {
        this.logger.error(
          `Failed to enqueue fleet telemetry payload: ${error.message}`,
        );
      }
    }
  }
}
