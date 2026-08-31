import {
  Controller, Get, Post, Param, Query, Body, Request,
  UseGuards, NotFoundException, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VehiclesService } from '../vehicles/vehicles.service';
import { PrismaService } from '../prisma/prisma.service';
import { RangePredictorService } from './range-predictor.service';
import { BatteryForecastService } from './battery-forecast.service';
import { SmartChargingService, PriceSlot } from './smart-charging.service';
import { AnomalyDetectionService } from './anomaly.service';
import { FeatureBuilderService } from './feature-builder.service';

@ApiTags('ml')
@Controller('ml')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class MlController {
  constructor(
    private readonly rangeSvc:    RangePredictorService,
    private readonly batterySvc:  BatteryForecastService,
    private readonly chargingSvc: SmartChargingService,
    private readonly anomalySvc:  AnomalyDetectionService,
    private readonly featureSvc:  FeatureBuilderService,
    private readonly vehiclesSvc: VehiclesService,
    private readonly prisma:      PrismaService,
  ) {}

  /**
   * Context-aware range prediction based on actual trip history.
   * More accurate than the ideal Tesla estimate because it uses
   * your real efficiency weighted by recency + conditions.
   *
   * GET /ml/:vehicleId/range?soc=36&temp=12&speed=90
   */
  @Get(':vehicleId/range')
  @ApiOperation({ summary: 'Predict remaining range from real trip history' })
  @ApiQuery({ name: 'soc',   required: true,  type: Number, description: 'Current SOC %' })
  @ApiQuery({ name: 'temp',  required: false, type: Number, description: 'Outside temp °C (optional)' })
  @ApiQuery({ name: 'speed', required: false, type: Number, description: 'Current/expected speed km/h' })
  async predictRange(
    @Param('vehicleId') vehicleId: string,
    @Query('soc')   socStr:   string,
    @Query('temp')  tempStr?: string,
    @Query('speed') speedStr?: string,
  ) {
    const soc = Number(socStr);
    if (isNaN(soc) || soc < 0 || soc > 100) {
      throw new BadRequestException('soc must be 0–100');
    }

    const result = await this.rangeSvc.predict(vehicleId, soc, {
      tempC:    tempStr  ? Number(tempStr)  : undefined,
      speedKmh: speedStr ? Number(speedStr) : undefined,
    });

    if (!result) {
      throw new NotFoundException('Insufficient trip history for range prediction (need ≥ 3 trips)');
    }

    return {
      ...result,
      lowData: result.confidenceScore < 0.6,
      dataWarning: result.confidenceScore < 0.6
        ? 'Prediction based on limited trip history — accuracy will improve with more data'
        : undefined,
    };
  }

  /**
   * Battery capacity trend forecast using linear regression on BatteryHealth history.
   * Returns current SOH, 30-day projection, 1-year projection, and degradation rate.
   *
   * GET /ml/:vehicleId/battery-forecast
   */
  @Get(':vehicleId/battery-forecast')
  @ApiOperation({ summary: 'Battery degradation trend and 1-year forecast' })
  async batteryForecast(@Param('vehicleId') vehicleId: string) {
    const result = await this.batterySvc.forecast(vehicleId);
    if (!result) {
      throw new NotFoundException('Insufficient battery health history (need ≥ 5 measurements)');
    }
    return {
      ...result,
      lowData: result.sampleCount < 10,
      dataWarning: result.sampleCount < 10
        ? 'Forecast based on limited history — accuracy improves with more measurements'
        : undefined,
    };
  }

  /**
   * Smart charging schedule optimized for cheapest electricity slots.
   * Automatically respects 80% daily SOC limit (configurable) to protect battery.
   *
   * POST /ml/:vehicleId/smart-charging
   * Body: { currentSoc, targetSoc, priceSchedule: [{hour, pricePerKwh}], batteryKwh?, chargingSpeedKw? }
   */
  @Post(':vehicleId/smart-charging')
  @ApiOperation({ summary: 'Optimal charging schedule from electricity price forecast' })
  async smartCharging(
    @Param('vehicleId') _vehicleId: string,
    @Body() body: {
      currentSoc:       number;
      targetSoc:        number;
      priceSchedule:    PriceSlot[];
      batteryKwh?:      number;
      maxDailySocPct?:  number;
      chargingSpeedKw?: number;
      batteryTempC?:    number;
      batteryType?:     'NMC' | 'LFP';
      dayOfWeek?:       number;
    },
  ) {
    if (!Array.isArray(body.priceSchedule) || !body.priceSchedule.length) {
      throw new BadRequestException('priceSchedule must be a non-empty array of {hour, pricePerKwh}');
    }
    return this.chargingSvc.suggest(body);
  }

  /**
   * Anomaly detection: flags high consumption, vampire drain, and slow charging.
   * Results are cached for 5 minutes.
   *
   * GET /ml/:vehicleId/anomalies
   */
  @Get(':vehicleId/anomalies')
  @ApiOperation({ summary: 'Detect efficiency, vampire drain, and charging anomalies' })
  async anomalies(@Param('vehicleId') vehicleId: string, @Request() req) {
    await this.vehiclesSvc.findOne(vehicleId, req.user.id);
    return this.anomalySvc.detect(vehicleId);
  }

  /**
   * Compute ML features for a specific trip.
   * Useful for debugging / model training inspection.
   *
   * GET /ml/trip/:tripId/features
   */
  @Get('trip/:tripId/features')
  @ApiOperation({ summary: 'Extract ML features for a trip' })
  async tripFeatures(@Param('tripId') tripId: string, @Request() req) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { vehicleId: true },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    await this.vehiclesSvc.findOne(trip.vehicleId, req.user.id);
    const result = await this.featureSvc.buildForTrip(tripId);
    if (!result) throw new NotFoundException('Trip not finalized');
    return result;
  }
}
