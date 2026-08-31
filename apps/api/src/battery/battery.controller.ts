import { Controller, Get, Post, Param, UseGuards, Request, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VehiclesService } from '../vehicles/vehicles.service';
import { BatteryAnalyticsService } from './battery-analytics.service';
import { BatteryHealthService } from './battery-health.service';

@ApiTags('battery')
@Controller('battery')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class BatteryController {
  constructor(
    private readonly batteryAnalyticsService: BatteryAnalyticsService,
    private readonly vehiclesService: VehiclesService,
    private readonly batteryHealthService: BatteryHealthService,
  ) {}

  /** GET /battery/:vehicleId/health — current SOH + capacity */
  @Get(':vehicleId/health')
  @ApiOperation({ summary: 'Get current battery health (SOH)' })
  async getHealth(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.batteryAnalyticsService.getBatteryHealth(vehicleId);
  }

  /** GET /battery/:vehicleId/history — time-ordered SOH snapshots for chart */
  @Get(':vehicleId/history')
  @ApiOperation({ summary: 'Get battery health history (SOH over time)' })
  async getHistory(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('days') days?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.batteryAnalyticsService.getBatteryHealthHistory(
      vehicleId,
      days ? Number(days) : 30,
    );
  }

  /** GET /battery/:vehicleId/degradation — trend + projections */
  @Get(':vehicleId/degradation')
  @ApiOperation({ summary: 'Get battery degradation trend' })
  async getDegradation(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('days') days?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.batteryAnalyticsService.getDegradationTrend(vehicleId, days ? Number(days) : 90);
  }

  /** GET /battery/:vehicleId/degradation-forecast — simplified SOH forecast (now/1y/5y) */
  @Get(':vehicleId/degradation-forecast')
  @ApiOperation({ summary: 'Get battery SOH forecast (now, 1 year, 5 years)' })
  async getDegradationForecast(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.batteryAnalyticsService.getDegradationForecast(vehicleId);
  }

  /** GET /battery/:vehicleId/cycles — estimated full charge cycles */
  @Get(':vehicleId/cycles')
  @ApiOperation({ summary: 'Get charge cycle count estimate' })
  async getChargeCycles(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.batteryAnalyticsService.getChargeCycles(vehicleId);
  }

  /** GET /battery/:vehicleId/vampire-drain — overnight SOC loss detection */
  @Get(':vehicleId/vampire-drain')
  @ApiOperation({ summary: 'Detect vampire drain' })
  async detectVampireDrain(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('hours') hours?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.batteryAnalyticsService.detectVampireDrain(vehicleId, hours ? Number(hours) : 8);
  }

  /** GET /battery/:vehicleId/baseline-status — diagnostic: baseline lock state */
  @Get(':vehicleId/baseline-status')
  @ApiOperation({ summary: 'Diagnostic: baseline lock status and cycle counts' })
  async getBaselineStatus(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.batteryAnalyticsService.getBaselineStatus(vehicleId);
  }

  /** GET /battery/:vehicleId/trend — weekly SOH data points (deduped, regression-ready) */
  @Get(':vehicleId/trend')
  @ApiOperation({ summary: 'Weekly SOH trend from charging sessions (deduped by ISO week)' })
  async getWeeklyTrend(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('weeks') weeks?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.batteryHealthService.getDegradationTrend(vehicleId, weeks ? Number(weeks) : 52);
  }

  /** GET /battery/:vehicleId/forecast-80 — linear regression: when does SOH reach 80%? */
  @Get(':vehicleId/forecast-80')
  @ApiOperation({ summary: 'Forecast when battery SOH will reach 80% via linear regression' })
  async getForecast80(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.batteryHealthService.forecastDegradation(vehicleId);
  }

  /** POST /battery/:vehicleId/recalculate — trigger SOH recalculation */
  @Post(':vehicleId/recalculate')
  @ApiOperation({ summary: 'Trigger battery SOH recalculation' })
  async recalculate(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    // Запустить продвинутую аналитику + простую оценку по зарядкам
    await this.batteryAnalyticsService.updateBatteryMetrics(vehicleId).catch(
      () => undefined,
    );
    await this.batteryHealthService
      .estimateCapacityFromCharging(vehicleId)
      .catch(() => undefined);
    return this.batteryAnalyticsService.getBatteryHealth(vehicleId);
  }
}
