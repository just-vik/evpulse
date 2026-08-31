import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SuperchargerPricingService } from './supercharger-pricing.service';
import { TeslaOAuthService } from '../tesla-fleet/tesla-oauth.service';
import { isWorkerRole } from '../runtime/runtime-role';

/**
 * ChargingCostService — session cost from tariffs + Tesla catalog / billing.
 *
 * Tariff tree (summary):
 *   - manual cost → unchanged
 *   - tesla_sc / supercharger → Tesla Pricing API (needs GPS) → else superchargerRate (ToD)
 *   - dc_third / dc_fast with maxPowerKw > 50 → Pricing API only if lat/lng (session or
 *     recovered telemetry); no GPS → thirdPartyRate (e.g. underground parking)
 *   - other types → thirdPartyRate or homeChargingRate by chargerType
 */
@Injectable()
export class ChargingCostService {
  private readonly logger = new Logger(ChargingCostService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly superchargerPricing?: SuperchargerPricingService,
    @Optional() private readonly teslaOAuth?: TeslaOAuthService,
  ) {}

  /**
   * Fill cost for sessions that were force-closed by TelemetryEventEngine
   * (those bypass ChargingDetectorService.endSession, so cost is never set).
   * Runs every 5 minutes — idempotent, skips sessions that already have a cost.
   */
  @Cron('*/5 * * * *')
  async fillMissingCosts(): Promise<void> {
    if (!isWorkerRole()) return;
    const sessions = await this.prisma.chargingSession.findMany({
      where: {
        endTime:        { not: null },
        costTotal:      null,
        energyAddedKwh: { gt: 0 },
        // Supercharger sessions are handled by ChargingSyncService (real Tesla billing).
        // Applying a static tariff here would race with the billing sync and might
        // block the cron from retrying once ChargingSyncService writes tesla_api.
        chargerType: { notIn: ['tesla_sc', 'supercharger'] },
      },
      take: 20,
      orderBy: { startTime: 'desc' },
    });
    if (!sessions.length) return;

    this.logger.log(`[Cost] Backfilling cost for ${sessions.length} session(s) with missing cost`);
    for (const s of sessions) {
      await this.calculateSessionCost(s.id).catch((e: Error) =>
        this.logger.warn(`[Cost] Backfill failed for ${s.id}: ${e.message}`),
      );
    }
  }

  /**
   * Calculate and persist cost for a completed charging session.
   * Called by ChargingDetectorService.endSession() and the backfill cron.
   */
  async calculateSessionCost(sessionId: string): Promise<void> {
    const session = await (this.prisma as any).chargingSession.findUnique({
      where: { id: sessionId },
      include: {
        vehicle: {
          select: { id: true, userId: true, settings: true },
        },
      },
    });
    if (!session) return;

    // Skip if cost is authoritative: manual override or confirmed Tesla billing data.
    // Prevents recalculateAll from overwriting real Tesla API prices with static tariff.
    if (session.costSource === 'manual' || session.costSource === 'tesla_api') return;

    const energy = session.energyAddedKwh ?? 0;
    if (energy <= 0) return;

    const settings    = session.vehicle.settings;
    const chargerType = session.chargerType ?? 'ac_home';

    let costPerKwh: number;
    let costSource:  string;
    let location:    string | undefined;

    // Explicit Tesla Supercharger from vehicle telemetry (fast_charger_type / brand).
    const explicitTeslaSc = chargerType === 'supercharger' || chargerType === 'tesla_sc';
    // High-power DC: may be Tesla (no brand in first packet) or third-party — resolve via site API first.
    const isHighPowerDc =
      (chargerType === 'dc_fast' || chargerType === 'dc_third') &&
      ((session as any).maxPowerKw ?? 0) > 50;

    if (explicitTeslaSc || isHighPowerDc) {
      let startLat = (session as any).startLat as number | null;
      let startLng = (session as any).startLng as number | null;

      // When the first charging batch arrives without GPS (common on Supercharger
      // pull-in — Fleet Telemetry sends charger state before the GPS lock settles),
      // fall back to the last known GPS position from raw telemetry near session start.
      if ((startLat == null || startLng == null) && this.superchargerPricing) {
        const nearbyGps = await this.prisma.telemetryPoint.findFirst({
          where: {
            vehicleId:  session.vehicleId,
            timestamp:  {
              gte: new Date(session.startTime.getTime() - 10 * 60_000), // up to 10 min before
              lte: new Date(session.startTime.getTime() +  5 * 60_000), // or 5 min after
            },
            latitude:  { not: null },
            longitude: { not: null },
          },
          orderBy: { timestamp: 'desc' },
          select:  { latitude: true, longitude: true },
        });
        if (nearbyGps?.latitude != null && nearbyGps?.longitude != null) {
          startLat = nearbyGps.latitude;
          startLng = nearbyGps.longitude;
          // Persist so future recalculations don't need another telemetry lookup
          await this.prisma.chargingSession.update({
            where: { id: sessionId },
            data:  { startLat, startLng } as any,
          });
          this.logger.debug(
            `[Cost] session=${sessionId} — GPS recovered from telemetry (${startLat.toFixed(5)}, ${startLng.toFixed(5)})`,
          );
        }
      }

      const hasGps = startLat != null && startLng != null;

      // Tesla catalog API requires coordinates — never call without hasGps.
      if (hasGps && this.superchargerPricing && this.teslaOAuth) {
        try {
          const accessToken = await this.teslaOAuth.getValidAccessToken(session.vehicle.userId);
          const pricing = await this.superchargerPricing.getRateForSession(
            session.vehicleId,
            startLat,
            startLng,
            session.startTime,
            accessToken,
          );

          if (pricing) {
            costPerKwh = pricing.ratePerKwh;
            costSource = `supercharger_${pricing.source}`;
            location   = pricing.stationName;
            // Confirm chargerType if we matched a Tesla Supercharger site from GPS alone
            if (isHighPowerDc && !explicitTeslaSc) {
              await this.prisma.chargingSession.update({
                where: { id: sessionId },
                data:  { chargerType: 'supercharger' },
              });
            }
            this.logger.log(
              `[Cost] session=${sessionId} supercharger="${pricing.stationName}" ` +
              `${costPerKwh}€/kWh (${pricing.source}) × ${energy.toFixed(2)}kWh`,
            );
          } else {
            // No Tesla site match: explicit Tesla SC → vehicle supercharger ToD rate;
            // high-power DC without Tesla brand → public DC tariff (Ionity, etc.).
            if (explicitTeslaSc) {
              costPerKwh = this.superchargerRateForTime(settings, session.startTime);
              costSource = 'supercharger';
            } else {
              costPerKwh = settings?.thirdPartyRate ?? 0.45;
              costSource = 'tariff';
            }
          }
        } catch (err: any) {
          this.logger.warn(`[Cost] Supercharger pricing lookup failed for ${sessionId}: ${err.message}`);
          if (explicitTeslaSc) {
            costPerKwh = this.superchargerRateForTime(settings, session.startTime);
            costSource = 'supercharger';
          } else {
            costPerKwh = settings?.thirdPartyRate ?? 0.45;
            costSource = 'tariff';
          }
        }
      } else {
        // No GPS (underground, etc.) or pricing stack unavailable — no catalog lookup.
        if (isHighPowerDc && !hasGps) {
          this.logger.debug(
            `[Cost] session=${sessionId} high-power DC without GPS — thirdPartyRate (no Tesla catalog)`,
          );
        }
        if (explicitTeslaSc) {
          costPerKwh = this.superchargerRateForTime(settings, session.startTime);
          costSource = 'supercharger';
        } else {
          // isHighPowerDc (outer branch) without catalog
          costPerKwh = settings?.thirdPartyRate ?? 0.45;
          costSource = 'tariff';
        }
      }
    } else if (chargerType === 'dc_fast' || chargerType === 'dc_third') {
      // 3rd-party DC fast (Ionity, Allego, EnBW …) below 50 kW peak
      costPerKwh = settings?.thirdPartyRate ?? 0.45;
      costSource = 'tariff';
    } else if (chargerType === 'ac_city' || chargerType === 'ac_fast') {
      // Public AC city charger (22 kW) — billed at public tariff
      costPerKwh = settings?.thirdPartyRate ?? 0.45;
      costSource = 'tariff';
    } else {
      // home_slow, home_wall, ac_home, ac_slow → home electricity rate
      costPerKwh = settings?.homeChargingRate ?? 0.32;
      costSource = 'tariff';
    }

    const costTotal = Math.round(costPerKwh * energy * 100) / 100;

    await this.prisma.chargingSession.update({
      where: { id: sessionId },
      data: {
        costPerKwh,
        costTotal,
        costSource,
        currency: 'EUR',
        ...(location ? { location } : {}),
      },
    });

    if (costSource === 'tariff' || costSource === 'supercharger') {
      this.logger.log(
        `[Cost] session=${sessionId} type=${chargerType} ` +
          `${costPerKwh}€/kWh × ${energy.toFixed(2)}kWh = ${costTotal}€`,
      );
    }
  }

  /**
   * User overrides the cost for a session (e.g. after a DC session with a promo rate).
   */
  async setManualCost(
    userId: string,
    sessionId: string,
    manualCost: number,
  ): Promise<{ costTotal: number; costPerKwh: number | null }> {
    const session = await this.prisma.chargingSession.findFirst({
      where: { id: sessionId },
      include: { vehicle: { select: { userId: true } } },
    });
    if (!session || session.vehicle.userId !== userId) {
      throw new Error('Session not found or access denied');
    }

    const energy = session.energyAddedKwh ?? 0;
    const costPerKwh = energy > 0
      ? Math.round((manualCost / energy) * 10000) / 10000
      : null;

    await this.prisma.chargingSession.update({
      where: { id: sessionId },
      data: {
        manualCost,
        costTotal: manualCost,
        costPerKwh,
        costSource: 'manual',
        currency: 'EUR',
      },
    });

    return { costTotal: manualCost, costPerKwh };
  }

  /**
   * Returns the effective Supercharger rate for a given session start time,
   * applying the user's configured off-peak schedule when available.
   *
   * Tesla Germany time-of-day schedule (typical):
   *   Peak    08:00–22:00 → settings.superchargerRate      (e.g. 0.38 €/kWh)
   *   Off-peak 22:00–08:00 → settings.superchargerOffPeakRate (e.g. 0.25 €/kWh)
   *
   * Falls back to superchargerRate when no off-peak rate is configured.
   */
  private superchargerRateForTime(settings: any, startTime: Date): number {
    const standardRate = settings?.superchargerRate ?? 0.42;
    const offPeakRate  = settings?.superchargerOffPeakRate as number | null ?? null;
    if (offPeakRate == null) return standardRate;

    const peakStart = (settings?.superchargerPeakStart as number | null) ?? 8;
    const peakEnd   = (settings?.superchargerPeakEnd   as number | null) ?? 22;

    // Use vehicle/user timezone (falls back to Europe/Berlin for backwards compat).
    // Stored in vehicle_settings.timezone (default 'UTC' in schema, but users in
    // Germany default to Europe/Berlin via settings page).
    const tz = (settings?.timezone as string | undefined) || 'Europe/Berlin';
    const localHour = parseInt(
      new Intl.DateTimeFormat('en', {
        timeZone: tz,
        hour:     'numeric',
        hour12:   false,
      }).format(startTime),
      10,
    );
    const isPeak = localHour >= peakStart && localHour < peakEnd;
    return isPeak ? standardRate : offPeakRate;
  }

  /**
   * Cost summary for a vehicle over N months, grouped by month.
   */
  async getMonthlyCostSummary(vehicleId: string, months = 3) {
    const since = new Date();
    since.setMonth(since.getMonth() - months);

    const sessions = await this.prisma.chargingSession.findMany({
      where: { vehicleId, startTime: { gte: since }, endTime: { not: null } },
      orderBy: { startTime: 'desc' },
      select: {
        id: true,
        startTime: true,
        energyAddedKwh: true,
        costTotal: true,
        costPerKwh: true,
        costSource: true,
        chargerType: true,
        manualCost: true,
        currency: true,
      },
    });

    const byMonth: Record<
      string,
      { sessions: number; kwh: number; cost: number }
    > = {};

    for (const s of sessions) {
      const key = s.startTime.toISOString().slice(0, 7); // YYYY-MM
      if (!byMonth[key]) byMonth[key] = { sessions: 0, kwh: 0, cost: 0 };
      byMonth[key].sessions++;
      byMonth[key].kwh += s.energyAddedKwh ?? 0;
      byMonth[key].cost += s.costTotal ?? 0;
    }

    const totalCost = sessions.reduce((s, c) => s + (c.costTotal ?? 0), 0);
    const totalKwh = sessions.reduce((s, c) => s + (c.energyAddedKwh ?? 0), 0);

    // Derive currency from sessions (first non-null), fallback EUR.
    const currency = sessions.find(s => s.currency)?.currency ?? 'EUR';

    return {
      totalCost: +totalCost.toFixed(2),
      totalKwh: +totalKwh.toFixed(1),
      avgPerSession: sessions.length
        ? +(totalCost / sessions.length).toFixed(2)
        : 0,
      currency,
      byMonth,
      sessions,
    };
  }

  /**
   * Recalculate costs for all sessions of a vehicle (backfill after tariff change).
   */
  async recalculateAll(vehicleId: string): Promise<{ updated: number }> {
    const sessions = await this.prisma.chargingSession.findMany({
      where: { vehicleId, endTime: { not: null }, costSource: { not: 'manual' } },
      select: { id: true },
    });

    for (const s of sessions) {
      await this.calculateSessionCost(s.id);
    }

    return { updated: sessions.length };
  }
}
