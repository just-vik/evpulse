import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TripMaintenanceService } from '../trips/trip-maintenance.service';
import { isWorkerRole } from '../runtime/runtime-role';

/**
 * SystemMaintenanceCronService — central cron for non-time-critical maintenance.
 *
 * Owns two domain-agnostic jobs that were previously scattered across individual services:
 *   • Gap recovery  (every 15 min)  — was in TripGapRecoveryService.autoRecover()
 *   • Endtime repair (every hour)   — was in TripCleanupService.repairBloatedEndTimesAuto()
 *
 * Time-critical domain crons stay in their own services:
 *   • TripCleanupService  — 1 min / 10 min / 20 min / 6 h crons (trip/charging watchdogs)
 *   • HealthRecoveryService — 1 min (polling loop staleness)
 *   • DlqReplayCronService  — 2 min (DLQ replay with backoff)
 *   • ProductMetricsCronService — 5 min (Prometheus metrics)
 *   • TelemetryHealthService — 6 h (fleet telemetry config health)
 *   • InsightsBatchService   — daily 08:00 (nightly AI insights)
 */
@Injectable()
export class SystemMaintenanceCronService {
  private readonly logger = new Logger(SystemMaintenanceCronService.name);

  constructor(private readonly trips: TripMaintenanceService) {}

  /**
   * Light maintenance — every 15 minutes.
   * Recovers trips missed during Tesla sleep/polling gaps in the last 6 hours.
   */
  @Cron('*/15 * * * *')
  async lightMaintenance(): Promise<void> {
    if (!isWorkerRole()) return;
    const days = 6 / 24; // 6 hours
    const { recovered } = await this.trips.recoverGaps(undefined, days);
    if (recovered > 0) {
      this.logger.log(`[SystemMaintenance] Gap recovery: ${recovered} trip(s) recovered`);
    }
  }

  /**
   * Heavy maintenance — every hour.
   * Repairs trips where endTime is bloated (hours past the last GPS point).
   */
  @Cron('0 * * * *')
  async heavyMaintenance(): Promise<void> {
    if (!isWorkerRole()) return;
    const { repaired } = await this.trips.repairBloatedEndTimes(undefined, 3);
    if (repaired > 0) {
      this.logger.log(`[SystemMaintenance] Endtime repair: fixed ${repaired} trip(s)`);
    }
  }
}
