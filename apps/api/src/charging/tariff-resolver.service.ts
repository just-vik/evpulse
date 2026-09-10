import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SuperchargerPricingService } from './supercharger-pricing.service';
import { TeslaOAuthService } from '../tesla-fleet/tesla-oauth.service';
import { TariffContext, TariffResolution, TariffSource } from './tariff-resolution.types';

export const TARIFF_RESOLVER_CONFIG = 'TARIFF_RESOLVER_CONFIG';

/**
 * Required, not defaulted: see docs/calculations/tariff-resolver.md §7.
 * There is currently no real data source anywhere in the codebase that
 * supplies a trustworthy currency (not VehicleSettings, not
 * SuperchargerPricingService's catalog response, not ChargingSession) --
 * so this service refuses to guess one. A caller must explicitly supply
 * both values; until a canonical-currency product decision is ratified,
 * that's a deliberate integration-time choice, never a resolver default.
 */
export interface TariffResolverConfig {
  canonicalDefaultRate: number;
  canonicalCurrency: string;
}

/**
 * TariffResolverService — answers exactly one question: "what rate per
 * kWh should apply to this energy cost calculation?" See
 * docs/calculations/tariff-resolver.md for the full design. This is a
 * PURE resolver: it does not compute energy, Trip.costTotal,
 * ChargingSession.costTotal, costPerKm, or any forecast figure, and it
 * never sees a manually-costed session (manualCost is checked by the
 * caller, before this service is ever invoked -- §6).
 *
 * Not yet wired into any of the five existing call sites (ChargingCostService,
 * VehicleAnalyticsService, CostForecastService, TripDetectorService,
 * TripGapRecoveryService) -- this is the "pure resolver, before consumer
 * migration" step. See tariff-resolver.md §9 for the migration plan.
 */
@Injectable()
export class TariffResolverService {
  private readonly logger = new Logger(TariffResolverService.name);

  // Charger-type classification mirrors ChargingCostService's own buckets
  // (charging.md), minus the maxPowerKw/GPS-recovery nuance that service
  // keeps for itself per the migration mapping -- TariffContext carries no
  // maxPowerKw, so this is deliberately a simpler classification than the
  // full existing ladder, not a regression.
  private static readonly SUPERCHARGER_TYPES = new Set(['supercharger', 'tesla_sc']);
  private static readonly THIRD_PARTY_TYPES = new Set(['dc_fast', 'dc_third', 'ac_city', 'ac_fast']);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly superchargerPricing?: SuperchargerPricingService,
    @Optional() private readonly teslaOAuth?: TeslaOAuthService,
    @Optional() @Inject(TARIFF_RESOLVER_CONFIG) private readonly config?: TariffResolverConfig,
  ) {}

  async resolve(context: TariffContext): Promise<TariffResolution> {
    if (context.purpose === 'actual_cost') {
      return (await this.resolveSupercharger(context))
          ?? (await this.resolveVehicleSettings(context))
          ?? this.resolveDefault();
    }

    if (context.purpose === 'forecast') {
      return (await this.resolveHistoricalRate(context))
          ?? (await this.resolveVehicleSettings(context))
          ?? this.resolveDefault();
    }

    // historical_summary: no catalog call (would re-query Tesla for a past
    // session just to backfill a rollup gap), no historical_sessions tier
    // (a rollup must not paper over its own gaps by re-deriving from other
    // sessions' already-aggregated numbers -- tariff-resolver.md §3).
    return (await this.resolveVehicleSettings(context))
        ?? this.resolveDefault();
  }

  /** actual_cost only. Returns null (not a fallback value) on no match, no
   *  GPS, no matching site, or a catalog error -- caller's resolve() chain
   *  falls through to VehicleSettings in every one of those cases. */
  private async resolveSupercharger(context: TariffContext): Promise<TariffResolution | null> {
    const isSuperchargerCandidate =
      context.chargerType != null &&
      (TariffResolverService.SUPERCHARGER_TYPES.has(context.chargerType) ||
       TariffResolverService.THIRD_PARTY_TYPES.has(context.chargerType));
    if (!isSuperchargerCandidate) return null;
    if (!context.location || !this.superchargerPricing || !this.teslaOAuth) return null;

    try {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: context.vehicleId },
        select: { userId: true },
      });
      if (!vehicle) return null;

      const accessToken = await this.teslaOAuth.getValidAccessToken(vehicle.userId);
      const pricing = await this.superchargerPricing.getRateForSession(
        context.vehicleId,
        context.location.latitude,
        context.location.longitude,
        context.timestamp ?? new Date(),
        accessToken,
      );
      if (!pricing) return null;

      if (!this.config) {
        throw new Error(
          'TariffResolverService: Supercharger catalog resolved a rate but no ' +
          'canonicalCurrency is configured -- SuperchargerPricingService.getRateForSession() ' +
          'does not return a currency, so one must be supplied, not guessed. See tariff-resolver.md §7.',
        );
      }

      return { rate: pricing.ratePerKwh, currency: this.config.canonicalCurrency, source: 'supercharger_catalog' };
    } catch (err: any) {
      this.logger.warn(`[TariffResolver] Supercharger catalog lookup failed for vehicle ${context.vehicleId}: ${err.message}`);
      return null;
    }
  }

  /** All purposes use this as their non-catalog, non-historical fallback.
   *  Reads VehicleSettings AS PERSISTED -- no reconciliation of the known
   *  thirdPartyRate €0.55-vs-€0.45 disagreement (tariff-resolver.md §5). */
  private async resolveVehicleSettings(context: TariffContext): Promise<TariffResolution | null> {
    const settings = await this.prisma.vehicleSettings.findUnique({
      where: { vehicleId: context.vehicleId },
    });
    if (!settings) return null;
    if (!this.config) {
      throw new Error(
        'TariffResolverService: no canonicalCurrency configured -- VehicleSettings has no ' +
        'currency field, so one must be supplied, not guessed. See tariff-resolver.md §7.',
      );
    }

    // 0 is treated as "not configured," not a real free-electricity rate —
    // canonicalized to TripDetectorService's `(x ?? 0) > 0` style rather
    // than TripGapRecoveryService's plain `?? fallback` (the two diverged;
    // see tariff-current-behavior-trip-paths.spec.ts). A field that's
    // present but exactly 0 falls through to the default tier below, same
    // as a missing settings row.
    const type = context.chargerType;
    let rate: number | null;
    let source: TariffSource;
    if (type != null && TariffResolverService.SUPERCHARGER_TYPES.has(type)) {
      rate = this.resolveSuperchargerRateForTime(settings, context.timestamp ?? new Date());
      source = 'vehicle_settings.supercharger';
    } else if (type != null && TariffResolverService.THIRD_PARTY_TYPES.has(type)) {
      rate = (settings.thirdPartyRate ?? 0) > 0 ? settings.thirdPartyRate : null;
      source = 'vehicle_settings.third_party';
    } else {
      rate = (settings.homeChargingRate ?? 0) > 0 ? settings.homeChargingRate : null;
      source = 'vehicle_settings.home';
    }

    if (rate == null) return null;
    return { rate, currency: this.config.canonicalCurrency, source };
  }

  /**
   * PORTED FROM charging-cost.service.ts's superchargerRateForTime() (removed
   * after the tariff-resolution cleanup pass, all 5 consumers migrated) —
   * same peak/off-peak window, same timezone fallback, same semantics —
   * plus the 0-as-unconfigured guard applied to the standard rate (that
   * guard did not exist in the original; it's the canonicalized behavior
   * decided for the resolver). Returns null (not a fallback value) when
   * the standard rate itself is unconfigured, so the caller's resolve()
   * chain falls through to the default tier.
   */
  private resolveSuperchargerRateForTime(settings: { superchargerRate: number; superchargerOffPeakRate?: number | null; superchargerPeakStart?: number | null; superchargerPeakEnd?: number | null; timezone?: string | null }, startTime: Date): number | null {
    const standardRate = (settings.superchargerRate ?? 0) > 0 ? settings.superchargerRate : null;
    if (standardRate == null) return null;

    const offPeakRate = settings.superchargerOffPeakRate ?? null;
    if (offPeakRate == null) return standardRate;

    const peakStart = settings.superchargerPeakStart ?? 8;
    const peakEnd = settings.superchargerPeakEnd ?? 22;
    const tz = settings.timezone || 'Europe/Berlin';
    const localHour = parseInt(
      new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(startTime),
      10,
    );
    const isPeak = localHour >= peakStart && localHour < peakEnd;
    return isPeak ? standardRate : offPeakRate;
  }

  /** forecast only. Weighted average over ALL historical sessions with a
   *  known cost+energy (no time window -- mirrors CostForecastService's
   *  actual current query exactly, see tariff-current-behavior.spec.ts). */
  private async resolveHistoricalRate(context: TariffContext): Promise<TariffResolution | null> {
    const sessions = await this.prisma.chargingSession.findMany({
      where: {
        vehicleId: context.vehicleId,
        costTotal: { not: null, gt: 0 },
        energyAddedKwh: { not: null, gt: 0 },
      },
      select: { costTotal: true, energyAddedKwh: true },
    });
    if (sessions.length < 3) return null;

    const totalCost = sessions.reduce((s, r) => s + (r.costTotal ?? 0), 0);
    const totalEnergy = sessions.reduce((s, r) => s + (r.energyAddedKwh ?? 0), 0);
    if (totalEnergy <= 0) return null;
    if (!this.config) {
      throw new Error(
        'TariffResolverService: no canonicalCurrency configured -- historical ChargingSession ' +
        'rows have no reliable currency field today, so one must be supplied, not guessed. See tariff-resolver.md §7.',
      );
    }

    return {
      rate: Math.round((totalCost / totalEnergy) * 1000) / 1000,
      currency: this.config.canonicalCurrency,
      source: 'historical_sessions',
    };
  }

  private resolveDefault(): TariffResolution {
    if (!this.config) {
      throw new Error(
        'TariffResolverService: reached the default tier with no TariffResolverConfig ' +
        'provided. Per tariff-resolver.md §7/§10, this service does not invent a rate or ' +
        'currency -- both canonicalDefaultRate and canonicalCurrency must be explicitly configured.',
      );
    }
    return { rate: this.config.canonicalDefaultRate, currency: this.config.canonicalCurrency, source: 'default' };
  }
}
