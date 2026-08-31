import { Controller, Get, Param, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VehiclesService } from '../vehicles/vehicles.service';
import { VehicleAnalyticsService } from './vehicle-analytics.service';

@ApiTags('vehicle-analytics')
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class VehicleAnalyticsController {
  constructor(
    private readonly vehicleAnalyticsService: VehicleAnalyticsService,
    private readonly vehiclesService: VehiclesService,
  ) {}

  /**
   * Vehicle status for Dashboard.
   *
   * New endpoint: does not change existing /telemetry/* APIs.
   *
   * GET /api/v1/vehicles/:id/status
   */
  @Get('vehicles/:vehicleId/status')
  @ApiOperation({ summary: 'Get current vehicle status (dashboard aggregate)' })
  async getVehicleStatus(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.vehicleAnalyticsService.getVehicleStatus(vehicleId);
  }

  /**
   * Trips summary for today.
   *
   * GET /api/v1/vehicles/:id/trips/today
   */
  @Get('vehicles/:vehicleId/trips/today')
  @ApiOperation({ summary: 'Get trips summary for today' })
  async getTripsToday(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('dayStart') dayStart?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.vehicleAnalyticsService.getTripsToday(vehicleId, dayStart);
  }

  /**
   * Charging summary for last 30 days.
   *
   * GET /api/v1/vehicles/:id/charging/summary
   */
  @Get('vehicles/:vehicleId/charging/summary')
  @ApiOperation({ summary: 'Get charging summary for last 30 days' })
  async getChargingSummary(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.vehicleAnalyticsService.getChargingSummary(vehicleId);
  }

  /**
   * Cost analytics for last 30 days.
   *
   * GET /api/v1/vehicles/:id/cost
   */
  @Get('vehicles/:vehicleId/cost')
  @ApiOperation({ summary: 'Get energy cost analytics for last 30 days' })
  async getCost(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('rate') rate?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const pricePerKwh = rate ? Number(rate) : 0.13;
    return this.vehicleAnalyticsService.getCostSummary(vehicleId, pricePerKwh);
  }

  /**
   * Cost telemetry diagnostics for sync quality and billing source coverage.
   *
   * GET /api/v1/vehicles/:id/cost-telemetry
   */
  @Get('vehicles/:vehicleId/cost-telemetry')
  @ApiOperation({ summary: 'Get cost telemetry diagnostics for last 30 days' })
  async getCostTelemetry(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.vehicleAnalyticsService.getCostTelemetry(vehicleId);
  }

  /**
   * Aggregated dashboard payload — single request instead of 4.
   *
   * GET /api/v1/vehicles/:id/dashboard?rate=0.35
   */
  @Get('vehicles/:vehicleId/dashboard')
  @ApiOperation({ summary: 'Aggregated dashboard payload (status + trips + charging + cost)' })
  async getDashboard(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('rate') rate?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const pricePerKwh = rate ? Number(rate) : 0.35;
    return this.vehicleAnalyticsService.getDashboardSummary(vehicleId, pricePerKwh);
  }

  /**
   * Full dashboard context — includes battery health + vampire drain.
   * Single endpoint for all dashboard data including AI context.
   *
   * GET /api/v1/vehicles/:id/dashboard/full?rate=0.35
   */
  @Get('vehicles/:vehicleId/dashboard/full')
  @ApiOperation({ summary: 'Full dashboard context including battery health and vampire drain' })
  async getFullDashboard(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('rate') rate?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const pricePerKwh = rate ? Number(rate) : 0.35;
    return this.vehicleAnalyticsService.getFullContext(vehicleId, pricePerKwh);
  }
}

