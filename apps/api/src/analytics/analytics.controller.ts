import { Controller, Get, Param, UseGuards, Request, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VehiclesService } from '../vehicles/vehicles.service';
import { EnergyAnalyticsService } from './energy-analytics.service';
import { EfficiencyDatasetService } from './efficiency-dataset.service';
import { EfficiencyPredictorService } from './efficiency-predictor.service';
import { CostForecastService } from './cost-forecast.service';

@ApiTags('analytics')
@Controller('analytics')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class AnalyticsController {
  constructor(
    private readonly energyAnalyticsService: EnergyAnalyticsService,
    private readonly vehiclesService: VehiclesService,
    private readonly efficiencyDataset: EfficiencyDatasetService,
    private readonly efficiencyPredictor: EfficiencyPredictorService,
    private readonly costForecast: CostForecastService,
  ) {}

  /**
   * Get energy history
   */
  @Get('vehicle/:vehicleId/energy-history')
  @ApiOperation({ summary: 'Get energy history' })
  async getEnergyHistory(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('days') days?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.energyAnalyticsService.getEnergyHistory(vehicleId, days ? Number(days) : 30);
  }

  /**
   * Get charging costs
   */
  @Get('vehicle/:vehicleId/charging-costs')
  @ApiOperation({ summary: 'Get charging costs' })
  async getChargingCosts(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('rate') rate?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.energyAnalyticsService.getChargingCosts(vehicleId, rate ? Number(rate) : 0.13);
  }

  /**
   * Dataset for trip efficiency model training (CSV/JSON).
   * GET /api/v1/analytics/vehicle/:vehicleId/efficiency-dataset
   */
  @Get('vehicle/:vehicleId/efficiency-dataset')
  @ApiOperation({ summary: 'Build trip efficiency dataset for ML training' })
  async getEfficiencyDataset(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('limit') limit?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const rows = await this.efficiencyDataset.buildDataset(vehicleId, limit ? Number(limit) : 1000);
    return rows;
  }

  /**
   * Predict trip efficiency & range (Wh/km + est. range).
   * GET /api/v1/analytics/vehicle/:vehicleId/efficiency-prediction
   */
  @Get('vehicle/:vehicleId/efficiency-prediction')
  @ApiOperation({ summary: 'Predict trip efficiency (Wh/km) and range' })
  async predictEfficiency(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.efficiencyPredictor.predictForVehicle(vehicleId);
  }

  /**
   * Forecast energy cost for the next week / month.
   * GET /api/v1/analytics/vehicle/:vehicleId/cost-forecast
   */
  @Get('vehicle/:vehicleId/cost-forecast')
  @ApiOperation({ summary: 'Forecast weekly/monthly EV cost' })
  async getCostForecast(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('pricePerKwh') pricePerKwh?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    // pricePerKwh from query is only an explicit user override (e.g. manual input).
    // Tariff resolution (sessions → settings → default) happens inside the service.
    const override = pricePerKwh ? Number(pricePerKwh) : undefined;
    return this.costForecast.forecastForVehicle(vehicleId, override);
  }
}
