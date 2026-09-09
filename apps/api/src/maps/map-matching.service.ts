import { Injectable, Logger } from '@nestjs/common';

export interface MatchInput {
  lat:       number;
  lon:       number;
  timestamp?: Date;
}

/** Result of a single OSRM call — either a real trace match or a 2-point route. */
interface SegmentMatchResult {
  polyline:   string;   // Google polyline5 encoded
  distanceKm: number;
  type:       'matched' | 'estimated';
}

export interface MatchResult extends SegmentMatchResult {
  /** Number of independently-matched sub-segments merged into this result (1 = no split). */
  segmentCount: number;
  /**
   * How many of those segments exist only because a real fix was stranded
   * alone between two large time gaps and had to be bridged to a neighbor
   * via a 2-point /route call — i.e. road-network guesswork through a real
   * data gap, not a matched trace. 0 means every segment came directly from
   * splitByTimeGap with its original points intact.
   */
  singletonBridgeCount: number;
  /** Largest gap (seconds) between consecutive input points, before any splitting/bridging. */
  largestGapSeconds: number;
  /** Distance (km) covered by segments that were real /match traces. */
  matchedDistanceKm: number;
  /** Distance (km) covered by segments resolved via a 2-point /route call (bridges included). */
  routedDistanceKm: number;
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
      const largestGapSeconds = this.largestGap(points);

      // Split trace by gaps > 2 min — OSRM returns NoMatch when consecutive
      // timestamps jump too far (e.g. tunnel / signal loss during a trip).
      // A gap can strand a single real fix between two splits (e.g. sparse
      // GPS on a highway stretch) — bridge it to its nearest neighbor via a
      // 2-point route rather than dropping it, so real fixes are never
      // silently discarded. This matters most at the trace's tail: without
      // bridging, the trip's actual destination fix can be dropped entirely,
      // leaving the rendered route short of where the car actually stopped.
      const { segments, bridgeCount } = this.bridgeSingletons(this.splitByTimeGap(points, 120_000));

      if (segments.length === 1) {
        // Common case — single contiguous segment
        const seg = segments[0];
        const result = seg.length === 2
          ? await this.route(seg[0], seg[1])
          : await this.matchTrace(seg);
        return result && this.withDiagnostics([result], 1, bridgeCount, largestGapSeconds);
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
      const valid = results.filter((r): r is SegmentMatchResult => r !== null);
      if (valid.length === 0) return null;
      return this.withDiagnostics(valid, segments.length, bridgeCount, largestGapSeconds);
    } catch (err: any) {
      this.logger.debug(`[MapMatch] Failed: ${err.message}`);
      return null;
    }
  }

  /** Merge one or more segment results into a single MatchResult with diagnostics attached. */
  private withDiagnostics(
    valid: SegmentMatchResult[],
    segmentCount: number,
    singletonBridgeCount: number,
    largestGapSeconds: number,
  ): MatchResult {
    const matchedDistanceKm = Math.round(
      valid.filter(r => r.type === 'matched').reduce((s, r) => s + r.distanceKm, 0) * 10,
    ) / 10;
    const routedDistanceKm = Math.round(
      valid.filter(r => r.type === 'estimated').reduce((s, r) => s + r.distanceKm, 0) * 10,
    ) / 10;

    const merged: SegmentMatchResult = valid.length === 1
      ? valid[0]
      : {
          polyline:   mergePolylines(valid.map(r => r.polyline)),
          distanceKm: Math.round(valid.reduce((s, r) => s + r.distanceKm, 0) * 10) / 10,
          type:       (valid.every(r => r.type === 'matched') ? 'matched' : 'estimated') as 'matched' | 'estimated',
        };

    return {
      ...merged,
      segmentCount,
      singletonBridgeCount,
      largestGapSeconds,
      matchedDistanceKm,
      routedDistanceKm,
    };
  }

  /** Largest gap (seconds) between consecutive timestamped points, before any splitting. */
  private largestGap(points: MatchInput[]): number {
    let largest = 0;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1].timestamp;
      const curr = points[i].timestamp;
      if (!prev || !curr) continue;
      const dtS = (curr.getTime() - prev.getTime()) / 1000;
      if (dtS > largest) largest = dtS;
    }
    return largest;
  }

  /**
   * Split a point array into segments wherever consecutive timestamps
   * are more than gapMs apart. Points without timestamps are never split.
   *
   * Segments of length 1 are kept (not dropped) — a real fix stranded alone
   * between two large gaps is still real data; bridgeSingletons() re-attaches
   * it to a neighbor instead of it being silently discarded.
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
        segments.push(current);
        current = [curr];
      } else {
        current.push(curr);
      }
    }
    segments.push(current);
    return segments;
  }

  /**
   * splitByTimeGap can now yield segments with just 1 point (a real fix
   * stranded alone between two large gaps). Re-attach each such singleton to
   * whichever neighboring segment is temporally closer, forming a 2-point
   * bridge segment (matched via /route, not /match — we have no trace
   * through the gap, only its two endpoints).
   *
   * When two singletons sit back-to-back, bridging the first one forward
   * consumes the second one's only point as the bridge's endpoint — that
   * index is marked consumed and skipped, otherwise it would be re-emitted
   * as a second, spurious zero-length bridge sharing the same point.
   */
  private bridgeSingletons(rawSegments: MatchInput[][]): { segments: MatchInput[][]; bridgeCount: number } {
    const result: MatchInput[][] = [];
    const consumed = new Set<number>();
    let bridgeCount = 0;

    for (let i = 0; i < rawSegments.length; i++) {
      if (consumed.has(i)) continue;
      const seg = rawSegments[i];
      if (seg.length !== 1) {
        result.push(seg);
        continue;
      }

      const point  = seg[0];
      const lastResultSeg = result.length ? result[result.length - 1] : null;
      const prevPt = lastResultSeg ? lastResultSeg[lastResultSeg.length - 1] : null;
      const nextSeg = rawSegments[i + 1] ?? null;
      const nextPt  = nextSeg ? nextSeg[0] : null;
      const dtPrev = prevPt?.timestamp && point.timestamp
        ? point.timestamp.getTime() - prevPt.timestamp.getTime() : Infinity;
      const dtNext = nextPt?.timestamp && point.timestamp
        ? nextPt.timestamp.getTime() - point.timestamp.getTime() : Infinity;

      if (prevPt && dtPrev <= dtNext) {
        result.push([prevPt, point]);
        bridgeCount++;
      } else if (nextPt) {
        result.push([point, nextPt]);
        bridgeCount++;
        if (nextSeg!.length === 1) consumed.add(i + 1);
      } else {
        // No neighbor at all — only possible if points.length < 2 overall,
        // which match() already guards against before calling this.
        result.push(seg);
      }
    }
    return { segments: result, bridgeCount };
  }

  // ── /match — GPS trace → snapped road route ──────────────────────────────

  private async matchTrace(points: MatchInput[]): Promise<SegmentMatchResult | null> {
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

  private async route(from: MatchInput, to: MatchInput): Promise<SegmentMatchResult | null> {
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
