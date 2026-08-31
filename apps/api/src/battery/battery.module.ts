import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { BatteryAnalyticsService } from './battery-analytics.service';
import { BatteryController } from './battery.controller';
import { BatteryHealthService } from './battery-health.service';

@Module({
  imports: [PrismaModule, VehiclesModule],
  controllers: [BatteryController],
  providers: [BatteryAnalyticsService, BatteryHealthService],
  exports: [BatteryAnalyticsService, BatteryHealthService],
})
export class BatteryModule {}
