import { Controller, Get, Post, Body, Param, Query, UseGuards, Request, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { TelemetryService } from './telemetry.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { VampireDrainService } from './vampire-drain.service';
import { TelemetryFetcherService } from '../tesla-fleet/telemetry-fetcher.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateTelemetryPointDto } from './dto/telemetry.dto';
import { StreamHealthService } from './stream-health.service';

@ApiTags('telemetry')
@Controller('telemetry')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class TelemetryController {
  constructor(
    private readonly telemetryService: TelemetryService,
    private readonly vehiclesService: VehiclesService,
    private readonly vampireDrainService: VampireDrainService,
    private readonly telemetryFetcher: TelemetryFetcherService,
    private readonly streamHealth: StreamHealthService,
  ) {}

  /**
   * Get latest telemetry point for a vehicle
   */
  @Get(':vehicleId/latest')
  @ApiOperation({ summary: 'Get latest telemetry for a vehicle' })
  async getLatest(@Param('vehicleId') vehicleId: string, @Request() req) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const point = await this.telemetryService.getLatestPoint(vehicleId);
    if (!point) {
      return {
        vehicleId,
        soc: null,
        batteryRangeKm: null,
        speed: null,
        power: null,
        current: null,
        voltage: null,
        latitude: null,
        longitude: null,
        elevationM: null,
        batteryTemp: null,
        outsideTemp: null,
        insideTemp: null,
        odometer: null,
        heading: null,
        timestamp: null,
      };
    }
    return point;
  }

  /**
   * Get telemetry history with optional downsampling
   */
  @Get(':vehicleId/history')
  @ApiOperation({ summary: 'Get telemetry history for a vehicle' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  @ApiQuery({ name: 'downsample', required: false, type: Boolean })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max points to return (default 2000, max 10000)' })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getHistory(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('downsample') downsample?: boolean,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    const take = Math.min(parseInt(limit ?? '2000', 10) || 2000, 10_000);
    const skip = parseInt(offset ?? '0', 10) || 0;

    if (downsample) {
      return this.telemetryService.getDownsampledPoints(vehicleId, start, end);
    }

    return this.telemetryService.getPointsInRange(vehicleId, start, end, take, skip);
  }

  /**
   * Get telemetry statistics for a period
   */
  @Get(':vehicleId/stats')
  @ApiOperation({ summary: 'Get aggregated stats for a vehicle' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async getStats(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    return this.telemetryService.getStatistics(vehicleId, start, end);
  }

  /**
   * Get vampire drain stats for a vehicle
   */
  @Get(':vehicleId/vampire-drain')
  @ApiOperation({ summary: 'Get vampire drain stats for a vehicle' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async getVampireDrain(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('days') days = '30',
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.vampireDrainService.getStats(vehicleId, +days);
  }

  /**
   * Backfill vampire drain from historical telemetry.
   * Useful after first deploy or when cron has missed data.
   */
  @Post(':vehicleId/vampire-drain/backfill')
  @ApiOperation({ summary: 'Backfill vampire drain from historical telemetry' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async backfillVampireDrain(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('days') days = '60',
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.vampireDrainService.runBackfill(vehicleId, +days);
  }

  /**
   * Live mini-chart endpoint: last N telemetry points in a short time window.
   * Intended for the vehicle detail page real-time chart.
   *
   * GET /telemetry/:vehicleId/live?minutes=30&limit=120
   * Returns compact {t, spd, pwr, soc, outsideTemp} objects.
   */
  @Get(':vehicleId/live')
  @ApiOperation({ summary: 'Get recent telemetry points for a live mini-chart' })
  @ApiQuery({ name: 'minutes', required: false, type: Number, description: 'Lookback window in minutes (default 30, max 120)' })
  @ApiQuery({ name: 'limit',   required: false, type: Number, description: 'Max points to return (default 120, max 300)' })
  async getLivePoints(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('minutes') minutes?: string,
    @Query('limit')   limit?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const windowMin = Math.min(Math.max(1, parseInt(minutes ?? '30', 10) || 30), 120);
    const take      = Math.min(Math.max(1, parseInt(limit   ?? '120', 10) || 120), 300);
    const since     = new Date(Date.now() - windowMin * 60_000);
    const points    = await this.telemetryService.getPointsInRange(vehicleId, since, new Date(), take);
    return {
      vehicleId,
      windowMinutes: windowMin,
      points: points.map(p => ({
        t:           p.timestamp.toISOString(),
        spd:         p.speed         ?? null,
        pwr:         p.power         ?? null,
        soc:         p.soc           ?? null,
        outsideTemp: p.outsideTemp   ?? null,
      })),
    };
  }

  /**
   * Wake-poll: perform one immediate Tesla API poll for fresh data.
   * Called by frontend when the user opens the dashboard.
   */
  @Post(':vehicleId/wake-poll')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Trigger one immediate telemetry poll (wake on demand)' })
  async wakePoll(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    await this.telemetryFetcher.pollOnce(vehicleId, req.user.id);
  }

  /**
   * Ingest telemetry point (internal API)
   * Normally called by queue processor, but can be used for direct ingestion
   */
  @Post(':vehicleId/ingest')
  @ApiOperation({ summary: 'Ingest telemetry point' })
  async ingestTelemetry(
    @Param('vehicleId') vehicleId: string,
    @Body() dto: CreateTelemetryPointDto,
    @Request() req,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.telemetryService.createTelemetryPoint(vehicleId, dto);
  }

  /**
   * Redis Stream consumer group health: lag, pending counts, stream length.
   * lagAlert=true means a consumer group is > 1000 messages behind — investigate.
   */
  @Get('stream/health')
  @ApiOperation({ summary: 'Redis Stream consumer group lag & health' })
  async getStreamHealth() {
    return this.streamHealth.getHealth();
  }
}
