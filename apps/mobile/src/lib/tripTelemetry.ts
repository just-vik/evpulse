/**
 * GET /trips/:tripId/points (apps/api/src/trips/trips.controller.ts) — `elev` added
 * in commit 9b500fd. These are the canonical per-sample telemetry values exactly as
 * the backend computed them; nothing here reinterprets sign or magnitude.
 */
export interface TripPoint {
  t: string;
  lat: number | null;
  lng: number | null;
  spd: number | null;
  pwr: number | null;
  soc: number | null;
  elev: number | null;
}

export interface TripPointsResponse {
  tripId: string;
  startTime: string;
  endTime: string | null;
  points: TripPoint[];
}

export interface ChartSample {
  value: number;
}

/**
 * Visual sample cap for a trip telemetry chart on a phone screen. A long trip can have
 * thousands of Fleet Telemetry points; rendering one SVG point per sample isn't
 * necessary for a line this small and isn't free on-device.
 */
const MAX_CHART_SAMPLES = 140;

/**
 * Uniform-stride downsampling for visualization only — this never touches the API
 * response or any stored value, it only decides how many of the already-valid samples
 * get a point on the chart. A fixed stride (not a windowed min/max or LTTB reduction)
 * is intentionally simple: the goal is bounding SVG render cost, not preserving peaks
 * for analysis — that's a calculation-layer concern, not a chart concern.
 */
function downsample<T>(items: T[], maxSamples: number): T[] {
  if (items.length <= maxSamples) return items;
  const stride = Math.ceil(items.length / maxSamples);
  const out: T[] = [];
  for (let i = 0; i < items.length; i += stride) out.push(items[i]);
  return out;
}

/** Filters to samples where `field` is present, then downsamples for charting. */
function toChartSeries(points: TripPoint[], field: 'spd' | 'pwr' | 'soc' | 'elev'): ChartSample[] {
  const valid = points.filter((p) => p[field] != null);
  return downsample(valid, MAX_CHART_SAMPLES).map((p) => ({ value: p[field] as number }));
}

/** Speed (km/h) — raw canonical value, as returned by /points. */
export function speedChartData(points: TripPoint[]): ChartSample[] {
  return toChartSeries(points, 'spd');
}

/**
 * Power (kW) — raw canonical value, sign untouched. Per the Oct 2026 telemetry audit,
 * positive/negative here must stay exactly what the backend sent: do not flip sign or
 * relabel as "consumption"/"regen" here — that interpretation belongs to a calculation
 * layer, not this chart.
 */
export function powerChartData(points: TripPoint[]): ChartSample[] {
  return toChartSeries(points, 'pwr');
}

/** Elevation (m) — absolute altitude per sample, not a gain/loss computation. */
export function elevationChartData(points: TripPoint[]): ChartSample[] {
  return toChartSeries(points, 'elev');
}

/** SOC (%) — raw canonical value; a null sample is simply omitted, never clamped. */
export function socChartData(points: TripPoint[]): ChartSample[] {
  return toChartSeries(points, 'soc');
}
