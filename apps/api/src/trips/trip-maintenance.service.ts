import { Injectable } from '@nestjs/common';
import { TripBackfillService } from './trip-backfill.service';
import { TripCleanupService } from './trip-cleanup.service';
import { TripGapRecoveryService } from './trip-gap-recovery.service';

/**
 * TripMaintenanceService — single entry point for manual trip-maintenance operations.
 *
 * Groups the manual-trigger methods from three underlying services into one facade:
 *   • TripBackfillService  → rebuild, backfill, geocode addresses
 *   • TripCleanupService   → phantom cleanup, endTime repair
 *   • TripGapRecoveryService → recover missing trips from odometer gaps
 *
 * The underlying services keep their own cron schedules and internal logic unchanged.
 * Controllers should inject this service instead of the three separately.
 */
@Injectable()
export class TripMaintenanceService {
  constructor(
    private readonly backfill: TripBackfillService,
    private readonly cleanup: TripCleanupService,
    private readonly gapRecovery: TripGapRecoveryService,
  ) {}

  rebuildTrips(vehicleId: string, from: Date, to: Date, opts?: { dryRun?: boolean }) {
    return this.backfill.rebuildTrips(vehicleId, from, to, opts);
  }

  backfillVehicleTrips(vehicleId: string, from: Date, to: Date) {
    return this.backfill.backfillVehicleTrips(vehicleId, from, to);
  }

  backfillAddresses(vehicleId: string) {
    return this.backfill.backfillAddresses(vehicleId);
  }

  cleanupPhantoms(vehicleId?: string) {
    return this.cleanup.runManual(vehicleId);
  }

  repairBloatedEndTimes(vehicleId?: string, days = 3) {
    return this.cleanup.repairBloatedEndTimes(vehicleId, days);
  }

  recoverGaps(vehicleId?: string, days = 3) {
    return this.gapRecovery.runManual(vehicleId, days);
  }
}
