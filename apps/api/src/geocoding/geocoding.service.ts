import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

interface GeoLocation {
  short: string;   // "Senefeldstraße 9, Wiesbaden"
  full: string;    // "Senefeldstraße 9, Wiesbaden, Hessen, Germany"
  city: string;    // "Wiesbaden"
  country: string; // "Germany"
}

interface NominatimResult {
  display_name: string;
  address: {
    road?: string;
    house_number?: string;
    city?: string;
    town?: string;
    village?: string;
    suburb?: string;
    municipality?: string;
    state?: string;
    country?: string;
    postcode?: string;
  };
}

@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  // Rate-limit queue: Nominatim policy = max 1 req/sec
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  // Round coordinates to 4 decimal places (~11m grid) — enough precision for street addresses
  private readonly PRECISION = 4;
  private readonly CACHE_TTL = 60 * 60 * 24 * 30; // 30 days (addresses don't change)
  private readonly NOMINATIM_URL =
    process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org';

  constructor(private readonly redis: RedisService) {}

  async reverseShort(lat: number, lon: number): Promise<string | null> {
    const loc = await this.reverse(lat, lon);
    return loc?.short ?? null;
  }

  async reverse(lat: number, lon: number): Promise<GeoLocation | null> {
    if (!lat || !lon) return null;

    const rLat = lat.toFixed(this.PRECISION);
    const rLon = lon.toFixed(this.PRECISION);
    const cacheKey = `geo:rev:${rLat}:${rLon}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as GeoLocation;

    return new Promise((resolve) => {
      this.queue.push(async () => {
        try {
          const result = await this.fetchNominatim(rLat, rLon);
          if (result) {
            await this.redis.set(cacheKey, JSON.stringify(result), 'EX', this.CACHE_TTL);
          }
          resolve(result);
        } catch (err: any) {
          this.logger.warn(`Geocoding failed for ${rLat},${rLon}: ${err.message}`);
          resolve(null);
        }
      });
      this.processQueue();
    });
  }

  async batchReverse(
    points: Array<{ id: string; lat: number; lon: number }>,
  ): Promise<Map<string, GeoLocation>> {
    const results = new Map<string, GeoLocation>();
    for (const point of points) {
      const loc = await this.reverse(point.lat, point.lon);
      if (loc) results.set(point.id, loc);
    }
    return results;
  }

  private async fetchNominatim(lat: string, lon: string): Promise<GeoLocation | null> {
    const url =
      `${this.NOMINATIM_URL}/reverse?format=json&lat=${lat}&lon=${lon}` +
      `&zoom=18&addressdetails=1`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'EVPulse/1.0 (tesla-analytics; contact@evpulse.app)',
        'Accept-Language': 'de,en',
      },
    });

    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);

    const data = await res.json() as NominatimResult;
    if (!data?.address) return null;

    const a = data.address;
    const road = [a.road, a.house_number].filter(Boolean).join(' ');
    // Prefer village / suburb / town for TezLab-like labels ("Wallau · …" vs only parent city)
    const city =
      a.village ??
      a.town ??
      a.suburb ??
      a.city ??
      a.municipality ??
      '';

    return {
      short: [road, city].filter(Boolean).join(', '),
      full: data.display_name,
      city,
      country: a.country ?? '',
    };
  }

  // 1 request per second (Nominatim rate limit)
  private processQueue(): void {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const next = this.queue.shift();
    const done = () => {
      setTimeout(() => {
        this.processing = false;
        this.processQueue();
      }, 1100);
    };
    if (next) {
      next().then(done, done);
    }
  }
}
