import { Injectable } from '@nestjs/common';

interface KalmanState {
  lat:             number;
  lng:             number;
  variance:        number;  // uncertainty in m²
  lastTimestampMs: number;
}

/**
 * KalmanGpsFilter — 1D Kalman filter applied independently to lat and lng.
 *
 * Smooths noisy GPS readings before they are stored in trip_points.
 * Tesla typically has ~5–15 m GPS accuracy; process noise 3 m²/s gives
 * good balance between responsiveness and smoothing on urban routes.
 *
 * Call reset(vehicleId) at the start of every new trip so the filter
 * initialises from the actual trip-start position instead of carrying
 * over state from the previous journey.
 */
@Injectable()
export class KalmanGpsFilter {
  // Process noise: how fast uncertainty grows (m²/s).
  // 3 m²/s is the TeslaMate-derived optimum for Tesla telemetry.
  private readonly PROCESS_NOISE = 3;

  // Default measurement variance when GPS accuracy is unknown (10 m → 100 m²)
  private readonly DEFAULT_ACCURACY_M = 10;

  private readonly states = new Map<string, KalmanState>();

  /**
   * Filter a GPS fix.
   *
   * @param vehicleId   — per-vehicle filter state key
   * @param lat         — raw latitude
   * @param lng         — raw longitude
   * @param timestampMs — Unix ms of this measurement
   * @param accuracyM   — GPS accuracy in metres (optional; defaults to 10 m)
   * @returns smoothed { lat, lng, varianceM2 }
   */
  process(
    vehicleId: string,
    lat: number,
    lng: number,
    timestampMs: number,
    accuracyM = this.DEFAULT_ACCURACY_M,
  ): { lat: number; lng: number; varianceM2: number } {
    // Reject corrupt coordinates
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      const s = this.states.get(vehicleId);
      return s
        ? { lat: s.lat, lng: s.lng, varianceM2: s.variance }
        : { lat, lng, varianceM2: 9999 };
    }

    const existing = this.states.get(vehicleId);

    if (!existing) {
      // First fix — initialise directly from measurement
      const variance = accuracyM * accuracyM;
      this.states.set(vehicleId, { lat, lng, variance, lastTimestampMs: timestampMs });
      return { lat, lng, varianceM2: variance };
    }

    // ── PREDICT ──────────────────────────────────────────────────────────────
    const dt = Math.max(0, (timestampMs - existing.lastTimestampMs) / 1000); // seconds
    const predictedVariance = existing.variance + dt * this.PROCESS_NOISE * this.PROCESS_NOISE;

    // ── UPDATE ────────────────────────────────────────────────────────────────
    const measurementVariance = accuracyM * accuracyM;
    const K = predictedVariance / (predictedVariance + measurementVariance); // Kalman gain

    const smoothLat = existing.lat + K * (lat - existing.lat);
    const smoothLng = existing.lng + K * (lng - existing.lng);
    const newVariance = (1 - K) * predictedVariance;

    this.states.set(vehicleId, {
      lat:             smoothLat,
      lng:             smoothLng,
      variance:        newVariance,
      lastTimestampMs: timestampMs,
    });

    return { lat: smoothLat, lng: smoothLng, varianceM2: newVariance };
  }

  /**
   * Reset the filter for a vehicle.
   * Must be called at the start of each new trip so the filter does not
   * extrapolate from the previous journey's last position.
   */
  reset(vehicleId: string): void {
    this.states.delete(vehicleId);
  }
}
