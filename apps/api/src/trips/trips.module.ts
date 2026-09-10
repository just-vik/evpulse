import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { BatteryModule } from '../battery/battery.module';
import { GeocodingModule } from '../geocoding/geocoding.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { InfraModule } from '../infra/infra.module';
import { MapsModule } from '../maps/maps.module';
import { EnergyAnalyticsService } from '../analytics/energy-analytics.service';
import { TripDetectorService } from './trip-detector.service';
import { TripBuilderService } from './trip-builder.service';
import { TripCleanupService } from './trip-cleanup.service';
import { TripReconcilerService } from './trip-reconciler.service';
import { TripsController } from './trips.controller';
import { TripBackfillService } from './trip-backfill.service';
import { TripPostProcessorService } from './trip-post-processor.service';
import { TripGapRecoveryService } from './trip-gap-recovery.service';
import { TripPatternService } from './trip-pattern.service';
import { TripMaintenanceService } from './trip-maintenance.service';
import { KalmanGpsFilter } from './kalman-gps.filter';
import { MlModule } from '../ml/ml.module';
import { DistributedLockService } from '../common/services/distributed-lock.service';
import { TariffResolverService, TARIFF_RESOLVER_CONFIG, TariffResolverConfig } from '../charging/tariff-resolver.service';

@Module({
  imports: [PrismaModule, BillingModule, VehiclesModule, BatteryModule, GeocodingModule, WebsocketsModule, InfraModule, MapsModule, MlModule, EventsModule],
  controllers: [TripsController],
  providers: [
    KalmanGpsFilter, TripBuilderService, TripDetectorService, TripBackfillService, TripCleanupService, TripReconcilerService, TripPostProcessorService, TripGapRecoveryService, TripPatternService, TripMaintenanceService, EnergyAnalyticsService, DistributedLockService,
    TariffResolverService,
    {
      provide: TARIFF_RESOLVER_CONFIG,
      // Same provisional values as ChargingModule/AnalyticsModule's registration
      // -- see docs/calculations/tariff-resolver.md §10. This module doesn't
      // import TeslaFleetModule, so this instance's superchargerPricing/teslaOAuth
      // deps resolve to undefined (@Optional() on TariffResolverService itself) --
      // harmless: neither TripDetectorService nor TripGapRecoveryService ever
      // calls resolve() with a chargerType/location, so the catalog tier is
      // never reached.
      useValue: { canonicalDefaultRate: 0.35, canonicalCurrency: 'EUR' } satisfies TariffResolverConfig,
    },
  ],
  exports: [KalmanGpsFilter, TripBuilderService, TripDetectorService, TripBackfillService, TripCleanupService, TripReconcilerService, TripPostProcessorService, TripGapRecoveryService, TripPatternService, TripMaintenanceService],
})
export class TripsModule {}
