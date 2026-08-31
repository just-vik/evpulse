import { Injectable, Logger } from '@nestjs/common';
import { CreateTelemetryPointDto } from './dto/telemetry.dto';

/**
 * TelemetrySanitizerService — strict pre-filter for incoming telemetry points.
 *
 * Runs BEFORE the dedup layer and detectors.  Any point that fails a hard rule
 * is rejected entirely.  Soft rules null-out specific fields without rejecting
 * the whole point.
 *
 * Hard reject rules:
 *   - speed > 250 km/h          (physically impossible for a Tesla)
 *   - |power| > 1000 kW         (instrumentation error)
 *   - soc < 0 OR soc > 100      (invalid percentage)
 *   - timestamp in the future by > 5 min   (clock drift / replay attack)
 *   - timestamp more than 7 days in the past (stale replay)
 *
 * Soft null-out rules (field set to null, point kept):
 *   - lat/lon outside valid range  (|lat|>90 or |lon|>180)
 *   - lat/lon = exactly 0,0        (default/null GPS reading)
 *   - GPS jump: implied speed between consecutive points > 300 km/h
 *     AND gap < 60 s (teleport glitch — null out the new coordinates)
 *
 * GPS jump state is tracked per-vehicle across calls so it works
 * across batch boundaries.
 */
@Injectable()
export class TelemetrySanitizerService {
  private readonly logger = new Logger(TelemetrySanitizerService.name);

  /** Per-vehicle last-seen GPS for jump detection */
  private readonly lastGps = new Map<string, { lat: number; lon: number; ts: number }>();

  /** Per-vehicle last-seen valid SOC (for impossible-jump detection) */
  private readonly lastSoc = new Map<string, { soc: number; ts: number }>();

  /** Per-vehicle last-seen valid speed (for spike detection) */
  private readonly lastSpeed = new Map<string, { speed: number; ts: number }>();

  sanitize(
    vehicleId: string,
    points: CreateTelemetryPointDto[],
  ): CreateTelemetryPointDto[] {
    const now = Date.now();
    const result: CreateTelemetryPointDto[] = [];

    for (const raw of points) {
      const ts = raw.timestamp ? new Date(raw.timestamp as unknown as string).getTime() : now;

      // ── Hard reject ─────────────────────────────────────────────────────
      if (raw.speed != null && raw.speed > 250) {
        this.logger.debug(`[Sanitizer] ${vehicleId}: rejected speed=${raw.speed}`);
        continue;
      }
      if (raw.power != null && Math.abs(raw.power) > 1000) {
        this.logger.debug(`[Sanitizer] ${vehicleId}: rejected power=${raw.power}`);
        continue;
      }
      if (raw.soc != null && (raw.soc < 0 || raw.soc > 100)) {
        this.logger.debug(`[Sanitizer] ${vehicleId}: rejected soc=${raw.soc}`);
        continue;
      }
      if (ts > now + 5 * 60_000) {
        this.logger.debug(`[Sanitizer] ${vehicleId}: rejected future timestamp`);
        continue;
      }
      if (ts < now - 7 * 86_400_000) {
        this.logger.debug(`[Sanitizer] ${vehicleId}: rejected stale timestamp`);
        continue;
      }

      // ── Soft null-out GPS ────────────────────────────────────────────────
      const point = { ...raw };
      const lat = point.latitude  as number | null | undefined;
      const lon = point.longitude as number | null | undefined;

      const gpsInvalid =
        lat == null || lon == null ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
        (lat === 0 && lon === 0);

      if (gpsInvalid) {
        point.latitude  = null;
        point.longitude = null;
      } else {
        // GPS jump filter
        const prev = this.lastGps.get(vehicleId);
        if (prev) {
          const dtMs   = ts - prev.ts;
          if (dtMs > 0 && dtMs < 60_000) {
            const distKm    = haversineKm(prev.lat, prev.lon, lat!, lon!);
            const impliedKmh = distKm / (dtMs / 3_600_000);
            if (impliedKmh > 300) {
              this.logger.debug(
                `[Sanitizer] ${vehicleId}: GPS jump nulled (${distKm.toFixed(2)} km in ${dtMs}ms, ${impliedKmh.toFixed(0)} km/h)`,
              );
              point.latitude  = null;
              point.longitude = null;
            }
          }
        }

        // Update last GPS only when coordinates survived
        if (point.latitude != null && point.longitude != null) {
          this.lastGps.set(vehicleId, { lat: point.latitude as number, lon: point.longitude as number, ts });
        }
      }

      // ── Soft null-out SOC impossible jump ────────────────────────────────
      // A Tesla battery cannot gain/lose > 15% SOC in under 60 seconds.
      // A spike like 40% → 85% in one poll is a Tesla API ghost value.
      // Fallback: when the jump is nulled, use the last-known valid SOC so
      // the UI never shows '—' due to a transient sensor artefact.
      if (point.soc != null) {
        const prevSoc = this.lastSoc.get(vehicleId);
        if (prevSoc) {
          const dtMs = ts - prevSoc.ts;
          if (dtMs > 0 && dtMs < 60_000 && Math.abs(point.soc - prevSoc.soc) > 15) {
            this.logger.debug(
              `[Sanitizer] ${vehicleId}: SOC jump nulled (${prevSoc.soc}→${point.soc} in ${dtMs}ms), falling back to ${prevSoc.soc}`,
            );
            point.soc = prevSoc.soc; // fall back to last known instead of showing null
          }
        }
        if (point.soc != null) {
          this.lastSoc.set(vehicleId, { soc: point.soc, ts });
        }
      }

      // ── Soft null-out speed spike ────────────────────────────────────────
      // Instantaneous jump from 0 → > 180 km/h in one telemetry tick is
      // a GPS/BLE artefact; null-out so trip detector doesn't start a trip.
      // Fallback: use the last known speed (likely 0) rather than null.
      if (point.speed != null) {
        const prevSpeed = this.lastSpeed.get(vehicleId);
        if (prevSpeed) {
          const dtMs = ts - prevSpeed.ts;
          if (dtMs > 0 && dtMs < 5_000 && prevSpeed.speed < 5 && point.speed > 180) {
            this.logger.debug(
              `[Sanitizer] ${vehicleId}: speed spike nulled (${prevSpeed.speed}→${point.speed} in ${dtMs}ms), falling back to ${prevSpeed.speed}`,
            );
            point.speed = prevSpeed.speed; // fall back to last known instead of null
          }
        }
        if (point.speed != null) {
          this.lastSpeed.set(vehicleId, { speed: point.speed, ts });
        }
      }

      result.push(point);
    }

    return result;
  }
}

function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R      = 6371;
  const toRad  = (d: number) => (d * Math.PI) / 180;
  const dLat   = toRad(lat2 - lat1);
  const dLon   = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
