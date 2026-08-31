import { Module } from '@nestjs/common';
import { TelemetryGateway } from './telemetry.gateway';
import { AuthModule } from '../auth/auth.module';
import { VehiclesModule } from '../vehicles/vehicles.module';

@Module({
  imports: [AuthModule, VehiclesModule],
  providers: [TelemetryGateway],
  exports: [TelemetryGateway],
})
export class WebsocketsModule {}
