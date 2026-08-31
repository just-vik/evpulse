import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { TeslaFleetService } from './tesla-fleet.service'
import { TeslaOAuthService } from './tesla-oauth.service'
import { VehicleSpecsService } from './vehicle-specs.service'

@Injectable()
export class VehicleSyncService {

  private readonly logger = new Logger(VehicleSyncService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly teslaFleet: TeslaFleetService,
    private readonly teslaOAuth: TeslaOAuthService,
    private readonly vehicleSpecs: VehicleSpecsService,
    private readonly config: ConfigService,
  ) { }

  /**
   * Sync Tesla vehicles into local DB.
   * For each vehicle:
   *  1. Upsert Vehicle + TeslaVehicleLink rows.
   *  2. Attempt to fetch /vehicle_data (with let_it_sleep=true) to get vehicle_config,
   *     which contains trim_badging, motor_type, car_type — needed for accurate spec detection.
   *     Falls back to VIN-only detection when the car is asleep (null response).
   *  3. Run ensureVehicleSpecForVehicle with the richest available payload.
   */
  async syncVehiclesForUser(userId: string): Promise<number> {

    const accessToken = await this.teslaOAuth.getValidAccessToken(userId)

    const apiVehicles = await this.teslaFleet.getVehicles(accessToken)

    if (!apiVehicles.length) {
      this.logger.warn(`No vehicles returned from Tesla API for user ${userId}`)
      return 0
    }

    const account = await this.prisma.teslaAccount.findUnique({
      where: { userId }
    })

    if (!account) {
      throw new Error(`TeslaAccount not found for user ${userId}`)
    }

    let synced = 0

    for (const v of apiVehicles) {

      const teslaVehicleId = v.id?.toString()
      const vin = v.vin

      if (!vin || !teslaVehicleId) {
        this.logger.warn(`Skipping vehicle without VIN or ID`)
        continue
      }

      const model = this.normalizeModel(v)

      let vehicleRecord: any

      await this.prisma.$transaction(async (tx) => {

        const vehicle = await tx.vehicle.upsert({
          where: { vin },
          create: {
            userId,
            vin,
            teslaId: teslaVehicleId,
            model,
            year: v.year ?? null,
            status: 'active',
          },
          update: {
            teslaId: teslaVehicleId,
            model,
            year: v.year ?? undefined,
            status: 'active',
          },
        })

        vehicleRecord = vehicle

        await tx.teslaVehicleLink.upsert({
          where: { teslaVehicleId },
          create: {
            vehicleId: vehicle.id,
            teslaAccountId: account.id,
            teslaVehicleId,
          },
          update: {
            teslaAccountId: account.id,
          },
        })

      })

      if (vehicleRecord) {
        // Attempt to enrich the basic /vehicles payload with full /vehicle_data.
        // This provides vehicle_config (trim_badging, motor_type, car_type) required
        // for accurate battery/spec detection.  let_it_sleep=true avoids waking the car;
        // on a sleeping car the endpoint returns null and we fall back to VIN-only detection.
        let richVehicle = v
        try {
          const vd = await this.teslaFleet.getVehicleData(
            teslaVehicleId, accessToken,
            { endpoints: ['vehicle_config', 'vehicle_state'] },
          )
          if (vd) {
            // Merge top-level fields; vehicle_config comes from /vehicle_data root
            richVehicle = { ...v, ...vd }
            this.logger.debug(
              `vehicle_data enrichment OK for ${vin}: car_type=${vd.vehicle_config?.car_type}, ` +
              `trim=${vd.vehicle_config?.trim_badging}`,
            )
          } else {
            this.logger.debug(`vehicle_data returned null for ${vin} — car may be sleeping, using VIN-only detection`)
          }
        } catch (err) {
          this.logger.debug(`vehicle_data fetch failed for ${vin}: ${(err as Error).message} — using VIN-only detection`)
        }

        try {
          await this.vehicleSpecs.ensureVehicleSpecForVehicle(vehicleRecord.id, richVehicle)
        } catch (err) {
          this.logger.warn(`Failed to attach specs for vehicle ${vin}: ${(err as Error).message}`)
        }
      }

      this.logger.log(`Synced vehicle ${vin} (teslaId=${teslaVehicleId}) for user ${userId}`)
      synced++
    }

    return synced
  }

  /**
   * Configure Fleet Telemetry for all vehicles belonging to a user.
   * Called by the sync processor AFTER vehicles are in the DB, fixing the
   * race condition where configureTelemetry was called before sync completed.
   */
  async configureFleetTelemetryAfterSync(userId: string): Promise<void> {
    try {
      const accessToken = await this.teslaOAuth.getValidAccessToken(userId)
      const account = await this.prisma.teslaAccount.findUnique({
        where: { userId },
        include: { vehicleLinks: { include: { vehicle: true } } },
      })
      if (!account) return

      const vins = account.vehicleLinks
        .map((l: any) => l.vehicle?.vin)
        .filter(Boolean) as string[]

      if (!vins.length) {
        this.logger.warn(`configureFleetTelemetryAfterSync: no VINs found for user ${userId}`)
        return
      }

      const hostname = (
        this.config.get<string>('FLEET_TELEMETRY_HOSTNAME') ??
        this.config.get<string>('API_PUBLIC_URL') ??
        'api.evpulse.app'
      ).replace(/^https?:\/\//, '').replace(/\/$/, '')

      await this.teslaFleet.configureTelemetry(accessToken, { vins, hostname })
      this.logger.log(`Fleet telemetry configured for ${vins.join(',')} (post-sync)`)
    } catch (err) {
      this.logger.warn(`configureFleetTelemetryAfterSync failed for user ${userId}: ${(err as Error).message}`)
    }
  }

  /**
   * Normalize Tesla model name.
   */
  private normalizeModel(v: any): string {
    if (v.display_name?.startsWith('Model')) return v.display_name

    const map: Record<string, string> = {
      model3:     'Model 3',
      model3p:    'Model 3',   // Highland
      modely:     'Model Y',
      modely2:    'Model Y',   // Juniper
      models:     'Model S',
      models2:    'Model S',
      models3:    'Model S',   // Plaid-era
      modelx:     'Model X',
      modelx2:    'Model X',   // Plaid-era
      cybertruck: 'Cybertruck',
    }
    const key = v.vehicle_config?.car_type?.toLowerCase()
    if (key && map[key]) return map[key]

    return v.display_name ?? 'Tesla'
  }
}
