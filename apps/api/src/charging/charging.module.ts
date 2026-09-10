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
import { TariffResolverService, TARIFF_RESOLVER_CONFIG, TariffResolverConfig } from './tariff-resolver.service';

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
    TariffResolverService,
    {
      provide: TARIFF_RESOLVER_CONFIG,
      // PROVISIONAL — see docs/calculations/tariff-resolver.md §10. Neither
      // value is a ratified product decision yet; both are placeholders
      // chosen to match the codebase's existing, already-pervasive
      // convention (EUR everywhere; €0.35 is the one rate every settings
      // declaration agrees on) rather than inventing a new number. Only
      // reached when a VehicleSettings row is entirely missing, which
      // VehiclesService's "always ensure VehicleSettings exist" guarantee
      // makes practically unreachable today (charging.md).
      useValue: { canonicalDefaultRate: 0.35, canonicalCurrency: 'EUR' } satisfies TariffResolverConfig,
    },
  ],
  exports: [ChargingDetectorService, ChargingCostService, ChargingReconcilerService, SuperchargerPricingService],
})
export class ChargingModule {}
