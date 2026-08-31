import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TeslaFleetService } from './tesla-fleet.service';
import { TeslaOAuthService } from './tesla-oauth.service';
import { VehicleSyncService } from './vehicle-sync.service';
import { isWorkerRole } from '../runtime/runtime-role';

@Injectable()
export class TelemetryHealthService {
  private readonly logger = new Logger(TelemetryHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly teslaFleet: TeslaFleetService,
    private readonly teslaOAuth: TeslaOAuthService,
    private readonly vehicleSync: VehicleSyncService,
  ) {}

  /**
   * Every 6h: for each connected vehicle check fleet telemetry config.
   * - If not configured → re-run configureFleetTelemetryAfterSync
   * - Log key_paired status so ops can track which users still need Virtual Key
   */
  @Cron('0 */6 * * *')
  async checkAll(): Promise<void> {
    if (!isWorkerRole()) return;

    const accounts = await this.prisma.teslaAccount.findMany({
      include: {
        vehicleLinks: {
          include: { vehicle: { select: { id: true, vin: true } } },
        },
      },
    });

    let checked = 0;
    let reconfigured = 0;
    let unpaired = 0;

    for (const account of accounts) {
      let token: string;
      try {
        token = await this.teslaOAuth.getValidAccessToken(account.userId);
      } catch (e: any) {
        this.logger.warn(`[TelemetryHealth] Cannot get token for user ${account.userId}: ${e.message}`);
        continue;
      }

      for (const link of account.vehicleLinks) {
        const vin = link.vehicle.vin;
        if (!vin) continue;
        checked++;

        try {
          const cfg = await this.teslaFleet.getFleetTelemetryConfig(vin, token);

          if (!cfg) {
            this.logger.log(`[TelemetryHealth] ${vin}: not configured — reconfiguring`);
            await this.vehicleSync.configureFleetTelemetryAfterSync(account.userId);
            reconfigured++;
          } else {
            if (!cfg.key_paired) {
              this.logger.warn(`[TelemetryHealth] ${vin}: key NOT paired (user still needs Virtual Key)`);
              unpaired++;
            } else {
              this.logger.debug(`[TelemetryHealth] ${vin}: OK — key_paired=${cfg.key_paired} synced=${cfg.synced}`);
            }
          }
        } catch (e: any) {
          this.logger.error(`[TelemetryHealth] Failed to check ${vin}: ${e.message}`);
        }
      }
    }

    this.logger.log(
      `[TelemetryHealth] Done — checked=${checked}, reconfigured=${reconfigured}, unpaired=${unpaired}`,
    );
  }
}
