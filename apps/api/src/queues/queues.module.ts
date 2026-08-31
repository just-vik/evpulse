import { forwardRef, Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TelemetryQueueService } from './telemetry-queue.service';
import { TelemetryProcessor } from './telemetry.processor';
import { VehicleSyncProcessor } from './vehicle-sync.processor';
import { DlqReplayCronService } from './dlq-replay.cron';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TELEMETRY_QUEUE, VEHICLE_SYNC_QUEUE, ANALYTICS_QUEUE } from './queues.constants';
import { TeslaFleetModule } from '../tesla-fleet/tesla-fleet.module';
import { EMBEDDING_QUEUE } from '../ai/embedding.worker';
export { TELEMETRY_QUEUE, VEHICLE_SYNC_QUEUE, ANALYTICS_QUEUE };

@Global()
@Module({
  imports: [
    BullModule.registerQueue(
      {
        name: TELEMETRY_QUEUE,
        settings: { lockDuration: 120_000 },
        // Process up to 5 jobs concurrently from the telemetry queue
        limiter: { max: 50, duration: 1000 }, // 50 jobs/s max rate
      },
      { name: VEHICLE_SYNC_QUEUE },
      { name: ANALYTICS_QUEUE },
      { name: 'notifications' },
      { name: EMBEDDING_QUEUE },
    ),
    forwardRef(() => TelemetryModule),
    WebsocketsModule,
    PrismaModule,
    forwardRef(() => TeslaFleetModule),
  ],
  providers: [
    TelemetryQueueService,
    TelemetryProcessor,
    VehicleSyncProcessor,
    DlqReplayCronService,
  ],
  exports: [
    TelemetryQueueService,
    BullModule,
  ],
})
export class QueuesModule { }
