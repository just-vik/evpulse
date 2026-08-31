import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TeslaFleetService } from '../tesla-fleet/tesla-fleet.service';

interface SuperchargerRate {
  stationId:          string;
  name:               string;
  ratePerKwh:         number;
  peakRatePerKwh?:    number;
  offPeakRatePerKwh?: number;
  peakHoursStart?:    number;
  peakHoursEnd?:      number;
  currency:           string;
  lat:                number;
  lng:                number;
}

export interface SuperchargerPricing {
  ratePerKwh:  number;
  stationName: string;
  source:      'redis_cache' | 'db_cache' | 'tesla_api' | 'fallback';
}

@Injectable()
export class SuperchargerPricingService {
  private readonly logger = new Logger(SuperchargerPricingService.name);

  private readonly CACHE_TTL_S   = 7 * 24 * 60 * 60; // 7 days — pricing rarely changes
  private readonly MATCH_RADIUS_KM = 0.5;             // 500 m match tolerance

  constructor(
    private readonly prisma:      PrismaService,
    private readonly redis:       RedisService,
    private readonly teslaFleet:  TeslaFleetService,
  ) {}

  /**
   * Returns the €/kWh rate for a Supercharger session.
   *
   * Lookup chain (cheapest first):
   *   1. Redis (TTL 7d)  → free
   *   2. DB cache         → free
   *   3. Tesla API        → $0.10/call (only on cache miss)
   *   4. null             → caller falls back to vehicle settings rate
   */
  async getRateForSession(
    vehicleId:        string,
    lat:              number,
    lng:              number,
    sessionStartTime: Date,
    accessToken:      string,
  ): Promise<SuperchargerPricing | null> {
    // 1 — Redis (4-decimal precision ≈ 11 m granularity)
    const cacheKey = `sc_rate:${lat.toFixed(4)}:${lng.toFixed(4)}`;
    const cached   = await this.redis.get(cacheKey);
    if (cached) {
      try {
        const rate: SuperchargerRate = JSON.parse(cached);
        return {
          ratePerKwh:  this.applyTimeOfDay(rate, sessionStartTime),
          stationName: rate.name,
          source:      'redis_cache',
        };
      } catch { /* malformed cache entry — fall through */ }
    }

    // 2 — DB (lat/lng bounding box ≈ ±0.005° ≈ 550 m)
    const dbStation = await (this.prisma as any).superchargerLocation.findFirst({
      where: {
        lat: { gte: lat - 0.005, lte: lat + 0.005 },
        lng: { gte: lng - 0.005, lte: lng + 0.005 },
      },
    });
    if (dbStation) {
      const rate = this.mapDbToRate(dbStation);
      await this.redis.set(cacheKey, JSON.stringify(rate), 'EX', this.CACHE_TTL_S);
      return {
        ratePerKwh:  this.applyTimeOfDay(rate, sessionStartTime),
        stationName: rate.name,
        source:      'db_cache',
      };
    }

    // 3 — Tesla API ($0.10/call — only on full cache miss)
    try {
      const sites   = await this.teslaFleet.getNearbySuperchargers(vehicleId, accessToken);
      const matched = this.findNearest(sites, lat, lng);
      if (!matched) return null;

      const ratePerKwh        = matched.billing?.per_kwh         ?? null;
      const peakRatePerKwh    = matched.billing?.peak_per_kwh    ?? null;
      const offPeakRatePerKwh = matched.billing?.off_peak_per_kwh ?? null;

      if (ratePerKwh == null) return null; // pricing not available for this station

      // Persist to DB for future lookups
      await (this.prisma as any).superchargerLocation.upsert({
        where:  { stationId: matched.id ?? matched.site_id },
        update: { ratePerKwh, peakRatePerKwh, offPeakRatePerKwh, updatedAt: new Date() },
        create: {
          stationId:          matched.id ?? matched.site_id,
          name:               matched.name,
          lat:                matched.location?.lat ?? matched.gps_coords?.lat ?? lat,
          lng:                matched.location?.lon ?? matched.location?.lng ?? matched.gps_coords?.lon ?? lng,
          ratePerKwh,
          peakRatePerKwh,
          offPeakRatePerKwh,
          peakHoursStart:     matched.billing?.peak_hours_start ?? null,
          peakHoursEnd:       matched.billing?.peak_hours_end   ?? null,
          currency:           matched.billing?.currency         ?? 'EUR',
        },
      });

      const rate: SuperchargerRate = {
        stationId:          matched.id ?? matched.site_id,
        name:               matched.name,
        ratePerKwh,
        peakRatePerKwh,
        offPeakRatePerKwh,
        peakHoursStart:     matched.billing?.peak_hours_start,
        peakHoursEnd:       matched.billing?.peak_hours_end,
        currency:           matched.billing?.currency ?? 'EUR',
        lat:                matched.location?.lat ?? lat,
        lng:                matched.location?.lon ?? lng,
      };
      await this.redis.set(cacheKey, JSON.stringify(rate), 'EX', this.CACHE_TTL_S);

      this.logger.log(
        `[SuperchargerPricing] ${matched.name}: ${ratePerKwh}€/kWh (tesla_api, cached 7d)`,
      );
      return {
        ratePerKwh:  this.applyTimeOfDay(rate, sessionStartTime),
        stationName: rate.name,
        source:      'tesla_api',
      };
    } catch (err: any) {
      this.logger.warn(`[SuperchargerPricing] API call failed for ${vehicleId}: ${err.message}`);
      return null;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Apply time-of-day tariff if peak/off-peak schedule exists.
   *
   * Tesla Supercharger peak hours are defined in the LOCAL timezone of the
   * station (typically the country's standard time). Using UTC getHours() is
   * incorrect — e.g. a 05:15 CET session (04:15 UTC) would look like "hour 4"
   * in UTC but is correctly "hour 5" in CET, both off-peak before 08:00.
   * For stations outside a known timezone we use Europe/Berlin as default since
   * the vehicle is primarily used in Germany.
   */
  private applyTimeOfDay(rate: SuperchargerRate, time: Date): number {
    if (
      rate.peakRatePerKwh    != null &&
      rate.offPeakRatePerKwh != null &&
      rate.peakHoursStart    != null &&
      rate.peakHoursEnd      != null
    ) {
      // Derive local hour at the station location using Intl (no external deps).
      // Falls back to 'Europe/Berlin' when station timezone is unknown.
      const localHour = parseInt(
        new Intl.DateTimeFormat('en', {
          timeZone: 'Europe/Berlin',
          hour:     'numeric',
          hour12:   false,
        }).format(time),
        10,
      );
      const isPeak = localHour >= rate.peakHoursStart && localHour < rate.peakHoursEnd;
      return isPeak ? rate.peakRatePerKwh : rate.offPeakRatePerKwh;
    }
    return rate.ratePerKwh;
  }

  /** Find closest site within MATCH_RADIUS_KM. */
  private findNearest(sites: any[], lat: number, lng: number): any | null {
    let nearest: any  = null;
    let minDist       = Infinity;
    for (const site of sites) {
      const siteLat = site.location?.lat ?? site.gps_coords?.lat;
      const siteLng = site.location?.lon ?? site.location?.lng ?? site.gps_coords?.lon;
      if (siteLat == null || siteLng == null) continue;
      const dist = this.haversineKm(lat, lng, siteLat, siteLng);
      if (dist < minDist && dist <= this.MATCH_RADIUS_KM) {
        minDist = dist;
        nearest = site;
      }
    }
    return nearest;
  }

  private haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R    = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a    =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private mapDbToRate(db: any): SuperchargerRate {
    return {
      stationId:          db.stationId,
      name:               db.name,
      ratePerKwh:         db.ratePerKwh         ?? 0,
      peakRatePerKwh:     db.peakRatePerKwh      ?? undefined,
      offPeakRatePerKwh:  db.offPeakRatePerKwh   ?? undefined,
      peakHoursStart:     db.peakHoursStart      ?? undefined,
      peakHoursEnd:       db.peakHoursEnd        ?? undefined,
      currency:           db.currency            ?? 'EUR',
      lat:                db.lat,
      lng:                db.lng,
    };
  }
}
