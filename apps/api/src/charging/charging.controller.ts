import { Controller, Get, Put, Post, Param, Body, UseGuards, Request, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VehiclesService } from '../vehicles/vehicles.service';
import { ChargingDetectorService } from './charging-detector.service';
import { ChargingCostService } from './charging-cost.service';
import { ChargingReconcilerService } from './charging-reconciler.service';
import { BillingService } from '../billing/billing.service';
import { clampDateRange } from '../billing/entitlements.helper';
import { ChargingSyncService } from '../tesla-fleet/charging-sync.service';

@ApiTags('charging')
@Controller('charging')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ChargingController {
  constructor(
    private readonly chargingDetectorService: ChargingDetectorService,
    private readonly vehiclesService: VehiclesService,
    private readonly chargingCostService: ChargingCostService,
    private readonly chargingReconcilerService: ChargingReconcilerService,
    private readonly billingService: BillingService,
    private readonly chargingSync: ChargingSyncService,
  ) {}

  /**
   * Get charging sessions for a vehicle
   */
  @Get('vehicle/:vehicleId/sessions')
  @ApiOperation({ summary: 'Get charging sessions' })
  async getChargingSessions(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('limit') limit?: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const ent = await this.billingService.getCurrent(req.user.id);
    const { from: effectiveFrom, to: effectiveTo, clamped, limitDays } = clampDateRange(
      {
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
      },
      ent,
      'chargingHistoryDays',
    );
    const sessions = await this.chargingDetectorService.getChargingSessions(
      vehicleId, limit ? Number(limit) : 50, effectiveFrom, effectiveTo,
    );
    return { data: sessions, meta: { clamped, limitDays, plan: ent.plan } };
  }

  /**
   * Get charging statistics
   */
  @Get('vehicle/:vehicleId/stats')
  @ApiOperation({ summary: 'Get charging statistics' })
  async getChargingStats(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('days') days?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const ent = await this.billingService.getCurrent(req.user.id);
    const requestedDays = days ? Number(days) : 30;
    const effectiveDays = Math.min(requestedDays, ent.analyticsDepthDays);
    const clamped = requestedDays > effectiveDays;
    const stats = await this.chargingDetectorService.getChargingStats(vehicleId, effectiveDays);
    return { data: stats, meta: { clamped, limitDays: ent.analyticsDepthDays, plan: ent.plan } };
  }

  /**
   * Monthly cost summary for a vehicle
   */
  @Get('vehicle/:vehicleId/cost-summary')
  @ApiOperation({ summary: 'Monthly cost summary' })
  async getCostSummary(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('months') months?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.chargingCostService.getMonthlyCostSummary(vehicleId, months ? Number(months) : 3);
  }

  /**
   * Override cost for a specific session
   */
  @Put('sessions/:id/cost')
  @ApiOperation({ summary: 'Set manual session cost' })
  setManualCost(
    @Request() req: any,
    @Param('id') id: string,
    @Body('manualCost') manualCost: number,
  ) {
    return this.chargingCostService.setManualCost(req.user.id, id, manualCost);
  }

  /**
   * Recalculate costs for all sessions of a vehicle (use after changing tariffs)
   */
  @Post('vehicle/:vehicleId/recalculate-costs')
  @ApiOperation({ summary: 'Recalculate session costs from current tariffs' })
  async recalculateCosts(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    return this.chargingCostService.recalculateAll(vehicleId);
  }

  /**
   * Merge fragmented charging rows (same physical session split by telemetry gaps).
   */
  @Post('vehicle/:vehicleId/reconcile-sessions')
  @ApiOperation({ summary: 'Merge fragmented charging sessions for this vehicle' })
  async reconcileSessions(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('days') days?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const d = days ? Math.min(Math.max(1, Number(days)), 365) : 90;
    return this.chargingReconcilerService.runManual(vehicleId, d);
  }

  /**
   * Trigger Tesla billing API sync for recent SC sessions of a vehicle.
   * Useful after re-authorizing or when a session shows no cost.
   */
  @Post('vehicle/:vehicleId/sync-billing')
  @ApiOperation({ summary: 'Trigger Tesla billing API sync for recent SC sessions' })
  async syncBilling(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
    @Query('days') days?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const d = days ? Math.min(Math.max(1, Number(days)), 30) : 7;
    return this.chargingSync.adminSyncRecent(d);
  }
}
