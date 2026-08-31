import { Processor, Process } from '@nestjs/bull';
import { Logger, Injectable } from '@nestjs/common';
import { Job } from 'bull';
import { VEHICLE_SYNC_QUEUE } from './queues.constants';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleSyncService } from '../tesla-fleet/vehicle-sync.service';

@Processor(VEHICLE_SYNC_QUEUE)
@Injectable()
export class VehicleSyncProcessor {
  private readonly logger = new Logger(VehicleSyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleSync: VehicleSyncService,
  ) {}

  /**
   * Sync vehicles for a single user (triggered right after OAuth).
   * After vehicles are in the DB, configure Fleet Telemetry — this fixes the
   * race condition where the old callback code called configureTelemetry before
   * the Bull queue worker had actually written vehicles to the DB.
   */
  @Process('sync-vehicles')
  async handleSyncVehicles(job: Job<{ userId: string }>) {
    const { userId } = job.data;
    this.logger.log(`Syncing vehicles for user ${userId}`);
    try {
      const count = await this.vehicleSync.syncVehiclesForUser(userId);
      this.logger.log(`Synced ${count} vehicles for user ${userId}`);

      // Configure fleet telemetry AFTER vehicles exist in DB (race-condition fix)
      if (count > 0) {
        await this.vehicleSync.configureFleetTelemetryAfterSync(userId);
      }

      return { synced: count };
    } catch (error) {
      this.logger.error(`Vehicle sync failed for user ${userId}: ${error.message}`);
      throw error; // allow Bull retry
    }
  }

  /**
   * Batch sync: enqueue per-user sync for every Tesla account.
   * Runs every hour via TelemetryQueueService.scheduledVehicleSync().
   */
  @Process('batch-sync-vehicles')
  async handleBatchSyncVehicles(_job: Job) {
    this.logger.log('Batch vehicle sync started');

    const accounts = await this.prisma.teslaAccount.findMany({
      select: { userId: true },
    });

    let ok = 0;
    let fail = 0;
    for (const account of accounts) {
      try {
        await this.vehicleSync.syncVehiclesForUser(account.userId);
        ok++;
      } catch (error) {
        this.logger.error(`Vehicle sync failed for user ${account.userId}: ${error.message}`);
        fail++;
      }
    }

    this.logger.log(`Batch vehicle sync complete: ${ok} ok, ${fail} failed`);
    return { ok, fail };
  }
}
