import { forwardRef, Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { BatteryModule } from '../battery/battery.module';
import { RedisModule } from '../redis/redis.module';
import { TeslaFleetModule } from '../tesla-fleet/tesla-fleet.module';
import { EnergyAnalyticsService } from '../analytics/energy-analytics.service';
import { ChargingDetectorService } from './charging-detector.service';
import { ChargingCostService } from './charging-cost.service';
import { ChargingReconcilerService } from './charging-reconciler.service';
import { SuperchargerPricingService } from './supercharger-pricing.service';
import { ChargingController } from './charging.controller';

@Module({
  imports: [
    PrismaModule,
    BillingModule,
    VehiclesModule,
    BatteryModule,
    RedisModule,
    EventsModule,
    forwardRef(() => TeslaFleetModule),
  ],
  controllers: [ChargingController],
  providers: [
    ChargingDetectorService,
    ChargingCostService,
    ChargingReconcilerService,
    SuperchargerPricingService,
    EnergyAnalyticsService,
  ],
  exports: [ChargingDetectorService, ChargingCostService, ChargingReconcilerService, SuperchargerPricingService],
})
export class ChargingModule {}
