import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { RangePredictorService } from './range-predictor.service';
import { BatteryForecastService } from './battery-forecast.service';
import { SmartChargingService } from './smart-charging.service';
import { AnomalyDetectionService } from './anomaly.service';
import { FeatureBuilderService } from './feature-builder.service';
import { MlController } from './ml.controller';

/**
 * MlModule — rule-based analytics and heuristic prediction services.
 *
 * Production-ready (called by API endpoints):
 *   • AnomalyDetectionService  — efficiency/drain/charging anomalies
 *   • BatteryForecastService   — linear regression on BatteryHealth time-series
 *   • RangePredictorService    — temperature/weight/AC-adjusted range estimate
 *
 * Experimental (not yet exposed to users, no external callers):
 *   • SmartChargingService     — cheapest-hour charging optimizer (no tariff source yet)
 *   • FeatureBuilderService    — feature vectors for future ML pipeline
 *
 * Note: these are deterministic heuristics, not trained models.
 * A real ML pipeline (training, feature store, model serving) is out of scope
 * until the user base justifies it.
 */
@Module({
  imports: [PrismaModule, VehiclesModule],
  controllers: [MlController],
  providers: [
    RangePredictorService,
    BatteryForecastService,
    SmartChargingService,
    AnomalyDetectionService,
    FeatureBuilderService,
  ],
  exports: [
    RangePredictorService,
    BatteryForecastService,
    SmartChargingService,
    AnomalyDetectionService,
    FeatureBuilderService,
  ],
})
export class MlModule {}
