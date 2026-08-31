import { forwardRef, Module } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { TelemetryController } from './telemetry.controller';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { TripsModule } from '../trips/trips.module';
import { ChargingModule } from '../charging/charging.module';
import { MqttModule } from '../mqtt/mqtt.module';
import { TeslaFleetModule } from '../tesla-fleet/tesla-fleet.module';
import { RedisModule } from '../redis/redis.module';
import { GeocodingModule } from '../geocoding/geocoding.module';
import { TelemetryStreamWorker } from './telemetry-stream.worker';
import { TelemetryBufferService } from './telemetry-buffer.service';
import { TelemetryPipelineService } from './telemetry-pipeline.service';
import { TelemetrySanitizerService } from './telemetry-sanitizer.service';
import { StreamWatchdogService } from './stream-watchdog.service';
import { VampireDrainService } from './vampire-drain.service';
import { TeslaV1StreamingService } from './tesla-v1-streaming.service';
import { ElevationEnrichmentService } from './elevation-enrichment.service';
import { HttpModule } from '@nestjs/axios';
import { WebsocketsModule } from '../websockets/websockets.module';
import { TripEngineV2Service } from './trip-engine-v2.service';
import { StreamHealthService } from './stream-health.service';
import { TelemetryEventEngine } from './telemetry-event-engine.service';
import { TelemetryReplayController } from './telemetry-replay.controller';
import { MlModule } from '../ml/ml.module';
import { MetricsModule } from '../metrics/metrics.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    VehiclesModule,
    TripsModule,
    ChargingModule,
    MqttModule,
    RedisModule,
    GeocodingModule,
    HttpModule,
    WebsocketsModule,
    MlModule,
    MetricsModule,
    EventsModule,
    forwardRef(() => TeslaFleetModule),
  ],
  controllers: [TelemetryController, TelemetryReplayController],
  // TripDetectorService and ChargingDetectorService come from TripsModule and ChargingModule
  // imports above — no need to redeclare them here (would create duplicate instances with
  // separate in-memory caches, causing state machine desync between the pipeline and fetcher).
  providers: [
    TelemetryService,
    TelemetryStreamWorker,
    TelemetryBufferService,
    TelemetrySanitizerService,
    TelemetryPipelineService,
    StreamWatchdogService,
    VampireDrainService,
    TeslaV1StreamingService,
    ElevationEnrichmentService,
    TripEngineV2Service,
    StreamHealthService,
    TelemetryEventEngine,
  ],
  exports: [TelemetryService, TelemetryBufferService, TelemetryPipelineService, VampireDrainService, StreamHealthService],
})
export class TelemetryModule {}
