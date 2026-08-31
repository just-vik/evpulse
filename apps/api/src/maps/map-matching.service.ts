import { Injectable, Logger } from '@nestjs/common';

export interface MatchInput {
  lat:       number;
  lon:       number;
  timestamp?: Date;
}

export interface MatchResult {
  polyline:   string;   // Google polyline5 encoded
  distanceKm: number;
  type:       'matched' | 'estimated';
}

/**
 * MapMatchingService — snaps GPS points to real roads via OSRM.
 *
 * For trips with 3+ GPS points → /match API (trace snapped to road)
 * For trips with 2 points only → /route API (shortest road path)
 *
 * Returns null gracefully when OSRM is unreachable or the region is
 * outside the loaded road network.
 */
@Injectable()
export class MapMatchingService {
  private readonly logger = new Logger(MapMatchingService.name);
  private readonly base = process.env.OSRM_URL ?? 'http://tesla-osrm:5000';

  // Matching radius per point — 50 m allows for GPS inaccuracy without
  // snapping to completely wrong roads in dense urban areas.
  private readonly RADIUS_M = 50;

  async match(points: MatchInput[]): Promise<MatchResult | null> {
    if (points.length < 2) return null;
    try {
      // Split trace by gaps > 2 min — OSRM returns NoMatch when consecutive
      // timestamps jump too far (e.g. tunnel / signal loss during a trip).
      const segments = this.splitByTimeGap(points, 120_000);

      if (segments.length === 1) {
        // Common case — single contiguous segment
        const seg = segments[0];
        return seg.length === 2
          ? await this.route(seg[0], seg[1])
          : await this.matchTrace(seg);
      }

      // Multiple segments — match each independently, merge results
      const results = await Promise.all(
        segments.map(seg =>
          (seg.length === 2
            ? this.route(seg[0], seg[1])
            : this.matchTrace(seg)
          ).catch(() => null),
        ),
      );
      const valid = results.filter((r): r is MatchResult => r !== null);
      if (valid.length === 0) return null;
      if (valid.length === 1) return valid[0];

      return {
        polyline:   mergePolylines(valid.map(r => r.polyline)),
        distanceKm: Math.round(valid.reduce((s, r) => s + r.distanceKm, 0) * 10) / 10,
        type:       (valid.every(r => r.type === 'matched') ? 'matched' : 'estimated') as 'matched' | 'estimated',
      };
    } catch (err: any) {
      this.logger.debug(`[MapMatch] Failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Split a point array into segments wherever consecutive timestamps
   * are more than gapMs apart. Points without timestamps are never split.
   */
  private splitByTimeGap(points: MatchInput[], gapMs: number): MatchInput[][] {
    if (points.length < 2) return [points];
    const segments: MatchInput[][] = [];
    let current: MatchInput[] = [points[0]];

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const dt = (prev.timestamp && curr.timestamp)
        ? curr.timestamp.getTime() - prev.timestamp.getTime()
        : 0;
      if (dt > gapMs) {
        if (current.length >= 2) segments.push(current);
        current = [curr];
      } else {
        current.push(curr);
      }
    }
    if (current.length >= 2) segments.push(current);
    // If all points landed in segments with < 2 entries, fall back to full set
    return segments.length > 0 ? segments : [points];
  }

  // ── /match — GPS trace → snapped road route ──────────────────────────────

  private async matchTrace(points: MatchInput[]): Promise<MatchResult | null> {
    // OSRM expects lon,lat (reversed vs common convention)
    const coords     = points.map(p => `${p.lon},${p.lat}`).join(';');
    const radiuses   = points.map(() => this.RADIUS_M).join(';');
    const timestamps = points.every(p => p.timestamp)
      ? '&timestamps=' + points.map(p => Math.floor(p.timestamp!.getTime() / 1000)).join(';')
      : '';

    const url =
      `${this.base}/match/v1/driving/${coords}` +
      `?geometries=polyline&overview=full&radiuses=${radiuses}${timestamps}`;

    const res  = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const data = await res.json() as any;

    if (data.code !== 'Ok' || !data.matchings?.length) {
      this.logger.debug(`[MapMatch] match returned code=${data.code}`);
      return null;
    }

    // Sum distances across all matching segments (OSRM may split at gaps)
    const totalM = (data.matchings as any[]).reduce((s, m) => s + (m.distance ?? 0), 0);

    // If OSRM split into multiple matchings, decode + merge their polylines
    const polyline = data.matchings.length === 1
      ? data.matchings[0].geometry as string
      : mergePolylines((data.matchings as any[]).map((m: any) => m.geometry as string));

    return {
      polyline,
      distanceKm: Math.round(totalM / 100) / 10,
      type: 'matched' as const,
    };
  }

  // ── /route — 2-point shortest road path ─────────────────────────────────

  private async route(from: MatchInput, to: MatchInput): Promise<MatchResult | null> {
    const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
    const url    = `${this.base}/route/v1/driving/${coords}?geometries=polyline&overview=full`;

    const res  = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const data = await res.json() as any;

    if (data.code !== 'Ok' || !data.routes?.length) {
      this.logger.debug(`[MapMatch] route returned code=${data.code}`);
      return null;
    }

    return {
      polyline:   data.routes[0].geometry as string,
      distanceKm: Math.round((data.routes[0].distance as number) / 100) / 10,
      type: 'estimated' as const,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Decode multiple Google polyline5 strings, concatenate all lat/lng pairs,
 * and re-encode into a single polyline5 string.
 * Used when OSRM splits a trace into multiple matchings.
 */
function mergePolylines(polylines: string[]): string {
  const all: Array<[number, number]> = [];
  for (const pl of polylines) {
    all.push(...decodePoly(pl));
  }
  return encodePoly(all);
}

function decodePoly(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function encodePoly(points: Array<[number, number]>): string {
  let out = '', prevLat = 0, prevLng = 0;
  const encodeValue = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) { s += String.fromCharCode(((0x20 | (n & 0x1f)) + 63)); n >>= 5; }
    s += String.fromCharCode(n + 63);
    return s;
  };
  for (const [lat, lng] of points) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    out += encodeValue(iLat - prevLat) + encodeValue(iLng - prevLng);
    prevLat = iLat; prevLng = iLng;
  }
  return out;
}
