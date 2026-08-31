import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  Req,
  Logger,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TeslaFleetService } from './tesla-fleet.service';
import { TeslaOAuthService } from './tesla-oauth.service';
import { TelemetryFetcherService } from './telemetry-fetcher.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { VehicleCommandThrottleGuard } from '../common/guards/vehicle-command-throttle.guard';
import { VehicleStateMachineService } from './vehicle-state-machine.service';
import { ApiUsageService } from '../billing/api-usage.service';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { CommandsService } from '../commands/commands.service';
import { AuditLogService } from '../events/audit-log.service';

/**
 * Tesla Commands Controller
 *
 * REST endpoints for vehicle control.
 * Routes:
 * - POST /vehicles/:id/commands/lock
 * - POST /vehicles/:id/commands/unlock
 * - POST /vehicles/:id/commands/start-charging
 * - POST /vehicles/:id/commands/stop-charging
 * - POST /vehicles/:id/commands/charge-limit
 * - POST /vehicles/:id/commands/climate
 * - POST /vehicles/:id/commands/flash-lights
 * - POST /vehicles/:id/commands/honk
 * - POST /vehicles/:id/commands/frunk
 * - POST /vehicles/:id/commands/trunk
 * - POST /vehicles/:id/commands/windows             { action: vent|close }
 * - POST /vehicles/:id/commands/sentry              { on: boolean }
 * - POST /vehicles/:id/commands/charging-amps       { amps: 0-48 }
 * - POST /vehicles/:id/commands/seat-heater         { seat: 0-5, level: 0-3 }
 * - POST /vehicles/:id/commands/overheat-protection { on: boolean, fanOnly?: boolean }
 * - POST /vehicles/:id/commands/scheduled-charging  { enabled: boolean, timeMinutes: 0-1439 }
 * - POST /vehicles/:id/commands/scheduled-departure { enabled: boolean, departureTimeMinutes: 0-1439 }
 * - POST /vehicles/:id/commands/wake
 * - GET  /vehicles/:id/commands/status
 */
@Controller('vehicles')
export class TeslaCommandsController {
  private readonly logger = new Logger(TeslaCommandsController.name);

  constructor(
    private teslaFleet: TeslaFleetService,
    private teslaOAuth: TeslaOAuthService,
    private prisma: PrismaService,
    private redis: RedisService,
    private stateMachine: VehicleStateMachineService,
    private telemetryFetcher: TelemetryFetcherService,
    private commandsService: CommandsService,
    private auditLog: AuditLogService,
    @Inject(REDIS_CLIENT) private rawRedis: Redis,
    @Optional() private apiUsage?: ApiUsageService,
  ) {}

  /**
   * Map a Tesla / network error message to an appropriate HTTP status.
   * Vehicle-asleep / unavailable errors should be 503, not 400.
   */
  private commandHttpStatus(error: any): HttpStatus {
    // Already an HttpException — keep its status
    if (error instanceof HttpException) return error.getStatus() as HttpStatus;

    const msg: string = (error?.message ?? '').toLowerCase();

    if (msg.includes('circuit open'))                         return HttpStatus.SERVICE_UNAVAILABLE;
    if (msg.includes('asleep') || msg.includes('sleep'))     return HttpStatus.SERVICE_UNAVAILABLE;
    if (msg.includes('unavailable') || msg.includes('offline')) return HttpStatus.SERVICE_UNAVAILABLE;
    if (msg.includes('timeout') || msg.includes('timed out')) return HttpStatus.GATEWAY_TIMEOUT;
    if ((error?.status ?? 0) === 408)                        return HttpStatus.GATEWAY_TIMEOUT;

    return HttpStatus.BAD_REQUEST;
  }

  /**
   * Thin wrapper: verify ownership + get token + run command + handle errors uniformly.
   * Also records command history on success/failure.
   */
  private async runCmd(
    vehicleId: string,
    userId: string,
    label: string,
    fn: (teslaVehicleId: string, accessToken: string) => Promise<any>,
    params?: any,
    presetId?: string,
  ): Promise<any> {
    try {
      const { teslaVehicleId } = await this.verifyVehicleOwnership(vehicleId, userId);
      const accessToken = await this.teslaOAuth.getValidAccessToken(userId);
      const result = await fn(teslaVehicleId, accessToken);
      this.logger.log(`[${label}] OK vehicle=${vehicleId} user=${userId}`);
      this.commandsService.recordHistory({ userId, vehicleId, presetId, command: label, params, status: 'success', result }).catch(() => {});
      void this.apiUsage?.trackCommand(vehicleId).catch(() => {});
      this.auditLog.record({
        userId,
        type: 'vehicle.command',
        action: `vehicle.command.${label}`,
        targetType: 'vehicle',
        targetId: vehicleId,
        metadata: params ? { params } : undefined,
      });
      return { success: true, result };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      const msg: string = error?.message ?? 'Unknown error';
      this.logger.error(`[${label}] FAILED vehicle=${vehicleId}: ${msg}`);
      this.commandsService.recordHistory({ userId, vehicleId, presetId, command: label, params, status: 'failed', error: msg }).catch(() => {});
      this.auditLog.record({
        userId,
        type: 'vehicle.command',
        action: `vehicle.command.${label}.failed`,
        targetType: 'vehicle',
        targetId: vehicleId,
        metadata: { error: msg, ...(params ? { params } : {}) },
      });
      throw new HttpException(msg, this.commandHttpStatus(error));
    }
  }

  /**
   * Verify user owns vehicle and return mapping to Tesla vehicleId.
   */
  private async verifyVehicleOwnership(
    vehicleId: string,
    userId: string,
  ): Promise<{ vehicleId: string; teslaVehicleId: string }> {
    const link = await this.prisma.teslaVehicleLink.findUnique({
      where: {
        vehicleId,
      },
      include: {
        teslaAccount: {
          select: { userId: true },
        },
      },
    });

    if (!link || link.teslaAccount.userId !== userId) {
      throw new HttpException(
        'Vehicle not found or not owned by user',
        HttpStatus.FORBIDDEN,
      );
    }

    if (!link.teslaVehicleId) {
      throw new HttpException(
        'Vehicle is not linked to a Tesla vehicleId',
        HttpStatus.BAD_REQUEST,
      );
    }

    return { vehicleId: link.vehicleId, teslaVehicleId: link.teslaVehicleId };
  }

  @Post(':id/commands/lock')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  lock(@Param('id') v: string, @Req() req: any) {
    return this.runCmd(v, req.user.id, 'lock', (id, tok) => this.teslaFleet.lockVehicle(id, tok));
  }

  @Post(':id/commands/unlock')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  unlock(@Param('id') v: string, @Req() req: any) {
    return this.runCmd(v, req.user.id, 'unlock', (id, tok) => this.teslaFleet.unlockVehicle(id, tok));
  }

  @Post(':id/commands/start-charging')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  startCharging(@Param('id') v: string, @Req() req: any) {
    return this.runCmd(v, req.user.id, 'start-charging', (id, tok) => this.teslaFleet.startCharging(id, tok));
  }

  @Post(':id/commands/stop-charging')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  stopCharging(@Param('id') v: string, @Req() req: any) {
    return this.runCmd(v, req.user.id, 'stop-charging', (id, tok) => this.teslaFleet.stopCharging(id, tok));
  }

  @Post(':id/commands/charge-limit')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  async setChargeLimit(
    @Param('id') v: string,
    @Body() dto: { percent: number },
    @Req() req: any,
  ) {
    if (dto.percent < 0 || dto.percent > 100) {
      throw new HttpException('Charge limit must be between 0 and 100', HttpStatus.BAD_REQUEST);
    }
    return this.runCmd(v, req.user.id, 'charge-limit', (id, tok) =>
      this.teslaFleet.setChargeLimit(id, dto.percent, tok),
    );
  }

  @Post(':id/commands/climate')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  async setClimate(
    @Param('id') v: string,
    @Body() dto: { driverTemp?: number; passengerTemp?: number; action?: string },
    @Req() req: any,
  ) {
    if (dto.action === 'start') {
      return this.runCmd(v, req.user.id, 'climate-start', (id, tok) => this.teslaFleet.startClimate(id, tok));
    }
    if (dto.action === 'stop') {
      return this.runCmd(v, req.user.id, 'climate-stop', (id, tok) => this.teslaFleet.stopClimate(id, tok));
    }
    if (dto.driverTemp != null || dto.passengerTemp != null) {
      const driverTemp    = dto.driverTemp    ?? 21;
      const passengerTemp = dto.passengerTemp ?? 21;
      if (driverTemp < 15 || driverTemp > 30 || passengerTemp < 15 || passengerTemp > 30) {
        throw new HttpException('Temperature must be between 15 and 30°C', HttpStatus.BAD_REQUEST);
      }
      return this.runCmd(v, req.user.id, 'climate-temp', (id, tok) =>
        this.teslaFleet.setClimate(id, driverTemp, passengerTemp, tok),
      );
    }
    throw new HttpException('Invalid climate parameters', HttpStatus.BAD_REQUEST);
  }

  @Post(':id/commands/flash-lights')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  flashLights(@Param('id') v: string, @Req() req: any) {
    return this.runCmd(v, req.user.id, 'flash-lights', (id, tok) => this.teslaFleet.flashLights(id, tok));
  }

  @Post(':id/commands/honk')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  honkHorn(@Param('id') v: string, @Req() req: any) {
    return this.runCmd(v, req.user.id, 'honk', (id, tok) => this.teslaFleet.honkHorn(id, tok));
  }

  @Post(':id/commands/frunk')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  frunk(@Param('id') v: string, @Req() req: any) {
    return this.runCmd(v, req.user.id, 'frunk', (id, tok) => this.teslaFleet.openFrunk(id, tok));
  }

  @Post(':id/commands/trunk')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  trunk(@Param('id') v: string, @Req() req: any) {
    return this.runCmd(v, req.user.id, 'trunk', (id, tok) => this.teslaFleet.openTrunk(id, tok));
  }

  @Post(':id/commands/windows')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  async windows(
    @Param('id') v: string,
    @Body() dto: { action: 'vent' | 'close' },
    @Req() req: any,
  ) {
    if (dto.action !== 'vent' && dto.action !== 'close') {
      throw new HttpException('action must be vent or close', HttpStatus.BAD_REQUEST);
    }
    return this.runCmd(v, req.user.id, `windows-${dto.action}`, (id, tok) =>
      dto.action === 'vent'
        ? this.teslaFleet.ventWindows(id, tok)
        : this.teslaFleet.closeWindows(id, tok),
    );
  }

  @Post(':id/commands/sentry')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  async sentry(
    @Param('id') v: string,
    @Body() dto: { on: boolean },
    @Req() req: any,
  ) {
    return this.runCmd(v, req.user.id, `sentry-${dto.on ? 'on' : 'off'}`, (id, tok) =>
      this.teslaFleet.setSentryMode(id, dto.on, tok),
    );
  }

  @Post(':id/commands/charging-amps')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  async chargingAmps(
    @Param('id') v: string,
    @Body() dto: { amps: number },
    @Req() req: any,
  ) {
    if (dto.amps < 0 || dto.amps > 48) {
      throw new HttpException('amps must be between 0 and 48', HttpStatus.BAD_REQUEST);
    }
    return this.runCmd(v, req.user.id, `charging-amps-${dto.amps}`, (id, tok) =>
      this.teslaFleet.setChargingAmps(id, dto.amps, tok),
    );
  }

  @Post(':id/commands/seat-heater')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  async seatHeater(
    @Param('id') v: string,
    @Body() dto: { seat: number; level: number },
    @Req() req: any,
  ) {
    if (dto.seat < 0 || dto.seat > 5) {
      throw new HttpException('seat must be 0-5 (0=driver, 1=passenger, 2-5=rear)', HttpStatus.BAD_REQUEST);
    }
    if (dto.level < 0 || dto.level > 3) {
      throw new HttpException('level must be 0-3 (0=off, 1-3=heat intensity)', HttpStatus.BAD_REQUEST);
    }
    return this.runCmd(v, req.user.id, `seat-heater-${dto.seat}-${dto.level}`, (id, tok) =>
      this.teslaFleet.setSeatHeater(id, dto.seat, dto.level, tok),
    );
  }

  @Post(':id/commands/overheat-protection')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  async overheatProtection(
    @Param('id') v: string,
    @Body() dto: { on: boolean; fanOnly?: boolean },
    @Req() req: any,
  ) {
    return this.runCmd(v, req.user.id, `cop-${dto.on ? 'on' : 'off'}`, (id, tok) =>
      this.teslaFleet.setCabinOverheatProtection(id, dto.on, dto.fanOnly ?? false, tok),
    );
  }

  @Post(':id/commands/scheduled-charging')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  async scheduledCharging(
    @Param('id') v: string,
    @Body() dto: { enabled: boolean; timeMinutes: number },
    @Req() req: any,
  ) {
    if (dto.timeMinutes < 0 || dto.timeMinutes > 1439) {
      throw new HttpException('timeMinutes must be 0-1439 (minutes from midnight)', HttpStatus.BAD_REQUEST);
    }
    return this.runCmd(v, req.user.id, `scheduled-charging`, (id, tok) =>
      this.teslaFleet.setScheduledCharging(id, dto.enabled, dto.timeMinutes, tok),
    );
  }

  @Post(':id/commands/scheduled-departure')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  async scheduledDeparture(
    @Param('id') v: string,
    @Body() dto: { enabled: boolean; departureTimeMinutes: number },
    @Req() req: any,
  ) {
    if (dto.departureTimeMinutes < 0 || dto.departureTimeMinutes > 1439) {
      throw new HttpException('departureTimeMinutes must be 0-1439 (minutes from midnight)', HttpStatus.BAD_REQUEST);
    }
    return this.runCmd(v, req.user.id, `scheduled-departure`, (id, tok) =>
      this.teslaFleet.setScheduledDeparture(id, dto.enabled, dto.departureTimeMinutes, tok),
    );
  }

  @Post(':id/commands/wake')
  @UseGuards(AuthGuard('jwt'), VehicleCommandThrottleGuard)
  async wake(@Param('id') vehicleId: string, @Req() req: any) {
    const userId = req.user.id;
    try {
      const { teslaVehicleId } = await this.verifyVehicleOwnership(vehicleId, userId);

      // Set Redis hint + state-machine BEFORE the actual wake call so the
      // dashboard immediately shows "waking" even if the car is slow to respond.
      const wakeHintKey = `tesla:wake-hint:${vehicleId}`;
      await this.redis.set(wakeHintKey, new Date().toISOString(), 'EX', 180);
      await this.stateMachine.setWaking(vehicleId);

      const accessToken = await this.teslaOAuth.getValidAccessToken(userId);
      const result = await this.teslaFleet.wakeVehicle(teslaVehicleId, accessToken);

      // Invalidate status cache so next frontend poll returns fresh data immediately
      await this.rawRedis.del(`vehicle:status:${vehicleId}`);

      // Restart adaptive polling with a short interval so data is fetched within 15s
      this.telemetryFetcher.stopAdaptivePolling(vehicleId);
      this.telemetryFetcher.startAdaptivePolling(vehicleId, userId);

      this.logger.log(`[wake] OK vehicle=${vehicleId} user=${userId}`);
      return { success: true, result };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      const msg: string = error?.message ?? 'Unknown error';
      this.logger.error(`[wake] FAILED vehicle=${vehicleId}: ${msg}`);
      throw new HttpException(msg, this.commandHttpStatus(error));
    }
  }

  /**
   * Get command status
   */
  @Get(':id/commands/status')
  @UseGuards(AuthGuard('jwt'))
  async getStatus(
    @Param('id') vehicleId: string,
    @Req() req: any,
  ): Promise<any> {
    try {
      const userId = req.user.id;
      const { teslaVehicleId } = await this.verifyVehicleOwnership(vehicleId, userId);

      const accessToken = await this.teslaOAuth.getValidAccessToken(userId);
      const vehicleData = await this.teslaFleet.getVehicleData(
        teslaVehicleId,
        accessToken,
      );

      return {
        success: true,
        vehicle: {
          locked: vehicleData.vehicle_state?.locked,
          charging: vehicleData.charge_state?.charging_state === 'Charging',
          speed: vehicleData.drive_state?.speed || 0,
          soc: vehicleData.charge_state?.battery_level,
          temp: vehicleData.climate_state?.inside_temp,
        },
      };
    } catch (error: any) {
      this.logger.error(`Get status failed: ${error.message}`);
      throw new HttpException(
        `Failed to get status: ${error.message}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * GET /api/v1/vehicles/debug/polling
   *
   * Diagnostic endpoint: shows circuit breaker state, active polling loops,
   * and staleness per vehicle. Use when data stops updating.
   */
  @Get('debug/polling')
  @UseGuards(AuthGuard('jwt'))
  async getPollingDiagnostics(@Req() req: any) {
    return this.telemetryFetcher.getPollingDiagnostics(req.user.id);
  }

  /**
   * POST /api/v1/vehicles/debug/reset-polling
   *
   * Emergency reset:
   *   1. Deletes all stuck tesla:req:* rate-limit keys (root cause of "data stops updating")
   *   2. Stops and restarts adaptive polling loop for every vehicle owned by the user
   *
   * Safe to call at any time — no data is lost.
   */
  @Post('debug/reset-polling')
  @UseGuards(AuthGuard('jwt'))
  async resetPolling(@Req() req: any) {
    const userId = req.user.id;

    // 1. Clear stuck rate-limit keys
    const rateKeys = await this.rawRedis.keys('tesla:req:*');
    if (rateKeys.length > 0) {
      await this.rawRedis.del(...rateKeys);
    }

    // 2. Get all vehicles linked to this user
    const account = await this.prisma.teslaAccount.findUnique({
      where: { userId },
      include: { vehicleLinks: { select: { vehicleId: true } } },
    });
    const vehicleIds = account?.vehicleLinks.map((l) => l.vehicleId) ?? [];

    // 3. Restart polling loops (stop → start re-initializes the setTimeout chain)
    for (const vehicleId of vehicleIds) {
      this.telemetryFetcher.stopAdaptivePolling(vehicleId);
      this.telemetryFetcher.startAdaptivePolling(vehicleId, userId);
    }

    this.logger.log(
      `[DebugReset] user=${userId}: cleared ${rateKeys.length} rate keys, restarted ${vehicleIds.length} polling loop(s)`,
    );

    return {
      success: true,
      clearedRateKeys: rateKeys.length,
      rateKeys,
      restartedLoops: vehicleIds.length,
      vehicleIds,
    };
  }

  /**
   * GET /api/v1/vehicles/debug/dlq
   *
   * Returns the last N entries from the Dead Letter Queue.
   * Use when you suspect pipeline failures are dropping telemetry silently.
   */
  @Get('debug/dlq')
  @UseGuards(AuthGuard('jwt'))
  async getDlq() {
    const depth = await this.rawRedis.llen('dlq:jobs:telemetry');
    const raw = await this.rawRedis.lrange('dlq:jobs:telemetry', 0, 19); // last 20
    const entries = raw.map((s) => {
      try { return JSON.parse(s); } catch { return { raw: s }; }
    });
    return { depth, entries };
  }
}

