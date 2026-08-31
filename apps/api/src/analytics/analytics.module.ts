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
