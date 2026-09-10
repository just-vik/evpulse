import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { RedisModule } from '../redis/redis.module';
import { BatteryModule } from '../battery/battery.module';
import { EnergyAnalyticsService } from './energy-analytics.service';
import { AnalyticsController } from './analytics.controller';
import { VehicleAnalyticsService } from './vehicle-analytics.service';
import { VehicleAnalyticsController } from './vehicle-analytics.controller';
import { AnalyticsJobsService } from './analytics-jobs.service';
import { EfficiencyDatasetService } from './efficiency-dataset.service';
import { EfficiencyPredictorService } from './efficiency-predictor.service';
import { CostForecastService } from './cost-forecast.service';
import { TariffResolverService, TARIFF_RESOLVER_CONFIG, TariffResolverConfig } from '../charging/tariff-resolver.service';

@Module({
  imports: [PrismaModule, VehiclesModule, TelemetryModule, RedisModule, BatteryModule],
  controllers: [AnalyticsController, VehicleAnalyticsController],
  providers: [
    EnergyAnalyticsService,
    VehicleAnalyticsService,
    AnalyticsJobsService,
    EfficiencyDatasetService,
    EfficiencyPredictorService,
    CostForecastService,
    TariffResolverService,
    {
      provide: TARIFF_RESOLVER_CONFIG,
      // Same provisional values as ChargingModule's registration -- see
      // docs/calculations/tariff-resolver.md §10. This module doesn't
      // import ChargingModule/TeslaFleetModule, so this instance's
      // superchargerPricing/teslaOAuth deps resolve to undefined
      // (@Optional()) -- harmless: no consumer in this module calls
      // resolve() with a `location`, so the catalog tier is never reached.
      useValue: { canonicalDefaultRate: 0.35, canonicalCurrency: 'EUR' } satisfies TariffResolverConfig,
    },
  ],
  exports: [
    EnergyAnalyticsService,
    VehicleAnalyticsService,
    EfficiencyDatasetService,
    EfficiencyPredictorService,
    CostForecastService,
  ],
})
export class AnalyticsModule {}
