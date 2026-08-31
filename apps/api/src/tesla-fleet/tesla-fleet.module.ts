import { forwardRef, Module } from '@nestjs/common';
import { TeslaFleetService } from './tesla-fleet.service';
import { TeslaOAuthService } from './tesla-oauth.service';
import { TeslaAuthController } from './tesla-auth.controller';
import { TeslaCommandsController } from './tesla-commands.controller';
import { VehicleStateMachineService } from './vehicle-state-machine.service';
import { TelemetryFetcherService } from './telemetry-fetcher.service';
import { VehicleSyncService } from './vehicle-sync.service';
import { TokenRefreshWorker } from './token-refresh.worker';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { TripsModule } from '../trips/trips.module';
import { ChargingModule } from '../charging/charging.module';
import { GapRecoveryService } from './gap-recovery.service';
import { ChargingSyncService } from './charging-sync.service';
import { createTeslaHttpModule } from './tesla-http.config';
import { DistributedLockService } from '../common/services/distributed-lock.service';
import { VehicleCommandThrottleGuard } from '../common/guards/vehicle-command-throttle.guard';
import { QueuesModule } from '../queues/queues.module';
import { MqttModule } from '../mqtt/mqtt.module';
import { FleetTelemetryController } from './fleet-telemetry.controller';
import { FleetTelemetryService } from './fleet-telemetry.service';
import { TelemetryPollCronService } from './telemetry-poll.cron';
import { VehicleSpecsService } from './vehicle-specs.service';
import { FleetTelemetryWorker } from './fleet-telemetry.worker';
import { FleetTelemetryMqttSubscriber } from './fleet-telemetry-mqtt.subscriber';
import { HealthRecoveryService } from './health-recovery.service';
import { TelemetryHealthService } from './telemetry-health.service';
import { RedisModule } from '../redis/redis.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { CommandsModule } from '../commands/commands.module';
import { EventsModule } from '../events/events.module';
import { BillingModule } from '../billing/billing.module';

/**
 * Tesla Fleet Module
 * 
 * Integrates all Tesla Fleet API functionality
 * - OAuth authentication and token management
 * - Real telemetry ingestion from Tesla API
 * - Vehicle state machine (polling control)
 * - Vehicle commands (lock, unlock, charging, etc.)
 * - Automatic token refresh every 30 minutes
 */
@Module({
  imports: [
    createTeslaHttpModule(),
    forwardRef(() => TelemetryModule),
    TripsModule,
    forwardRef(() => ChargingModule),
    RedisModule,
    PrismaModule,
    forwardRef(() => QueuesModule),
    MqttModule,
    UsersModule,
    CommandsModule,
    EventsModule,
    BillingModule,
  ],
  controllers: [TeslaAuthController, TeslaCommandsController, FleetTelemetryController],
  providers: [
    DistributedLockService,
    VehicleCommandThrottleGuard,
    TeslaFleetService,
    TeslaOAuthService,
    VehicleStateMachineService,
    TelemetryFetcherService,
    VehicleSyncService,
    TokenRefreshWorker,
    GapRecoveryService,
    FleetTelemetryService,
    FleetTelemetryWorker,
    FleetTelemetryMqttSubscriber,
    TelemetryPollCronService,
    VehicleSpecsService,
    ChargingSyncService,
    HealthRecoveryService,
    TelemetryHealthService,
  ],
  exports: [
    DistributedLockService,
    VehicleCommandThrottleGuard,
    TeslaFleetService,
    TeslaOAuthService,
    VehicleStateMachineService,
    TelemetryFetcherService,
    VehicleSyncService,
    FleetTelemetryService,
    VehicleSpecsService,
    ChargingSyncService,
  ],
})
export class TeslaFleetModule {}
