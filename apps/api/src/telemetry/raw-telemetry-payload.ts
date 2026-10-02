import { normalizeTeslaPayload } from '../utils/normalizeTeslaTelemetry';
import { CreateTelemetryPointDto } from './dto/telemetry.dto';

type NormalizedTeslaPayload = ReturnType<typeof normalizeTeslaPayload>;

/**
 * `telemetry_raw.payloadKind` values.
 *
 * Added Oct 2026 (telemetry audit): TelemetryRaw.payload used to always hold an
 * already-normalized CreateTelemetryPointDto, despite the schema comment promising
 * "raw event exactly as received" — losing the ability to replay history through a
 * fixed/changed normalizer. New Fleet Telemetry rows now store the real Tesla event.
 * payloadKind lets every reader (replay, backfill) tell the two shapes apart instead
 * of guessing from field presence, which would break the moment Tesla's payload gains
 * a field that happens to collide with a DTO field name.
 */
export const PAYLOAD_KIND_NORMALIZED_V1 = 'normalized_v1';
export const PAYLOAD_KIND_TESLA_FLEET_TELEMETRY_V1 = 'tesla_fleet_telemetry_v1';

/**
 * Builds the CreateTelemetryPointDto fields written to `telemetry_points` from a
 * normalizeTeslaPayload() result.
 *
 * Shared by the live Fleet Telemetry worker and raw-event replay/backfill so both
 * paths produce byte-identical points from the same input — replaying a raw event
 * can never drift from what would have been persisted had it arrived live.
 *
 * Note: self_driving_km / odometer_km_since_reset are intentionally excluded — those
 * update the Vehicle row directly (see FleetTelemetryWorker.processEntries), they are
 * not telemetry_points fields.
 */
export function buildTelemetryPointDto(
  normalized: NormalizedTeslaPayload,
): CreateTelemetryPointDto & Record<string, any> {
  return {
    timestamp: new Date(normalized.timestamp),
    soc: normalized.soc ?? null,
    batteryRangeKm: normalized.batteryRangeKm ?? null,
    speed: normalized.speed ?? null,
    power: normalized.power ?? null,
    current: normalized.current ?? null,
    voltage: normalized.voltage ?? null,
    latitude: normalized.latitude ?? null,
    longitude: normalized.longitude ?? null,
    elevationM: normalized.elevationM ?? null,
    batteryTemp: normalized.batteryTemp ?? null,
    outsideTemp: normalized.outsideTemp ?? null,
    insideTemp: normalized.insideTemp ?? null,
    odometer: normalized.odometer ?? null,
    heading: normalized.heading ?? null,
    charging_state: normalized.charging_state || null,
    shift_state: normalized.shift_state || null,
    fast_charger_type: normalized.fast_charger_type ?? null,
    fast_charger_brand: normalized.fast_charger_brand ?? null,
    charge_energy_added: normalized.charge_energy_added ?? null,
  };
}

/**
 * Resolves a `telemetry_raw` row's payload back into a normalizeTeslaPayload()-shaped,
 * loosely-typed object, regardless of payloadKind.
 *
 * Use this (never direct field access on the row) wherever a raw row is read generically
 * — e.g. trip rebuild from raw telemetry — so a future payloadKind only has to be taught
 * here once instead of at every call site.
 */
export function normalizeRawTelemetryPayload(
  payload: unknown,
  payloadKind: string | null | undefined,
): Record<string, any> | null {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payloadKind === PAYLOAD_KIND_TESLA_FLEET_TELEMETRY_V1) {
    return normalizeTeslaPayload(payload);
  }
  // normalized_v1 — the default, and what every row written before payloadKind existed
  // resolves to (Prisma column default): payload is already DTO/normalized-shaped.
  return payload as Record<string, any>;
}

/**
 * Resolves a `telemetry_raw` row's payload into a CreateTelemetryPointDto suitable for
 * TelemetryPipeline.processBatch(), regardless of payloadKind. Replaces the old
 * payloadKind-blind `rawPayloadToDto` that assumed every row was already DTO-shaped.
 */
export function rawPayloadToPoint(
  payload: unknown,
  payloadKind: string | null | undefined,
): CreateTelemetryPointDto | null {
  if (payloadKind === PAYLOAD_KIND_TESLA_FLEET_TELEMETRY_V1) {
    const normalized = normalizeRawTelemetryPayload(payload, payloadKind);
    return normalized ? buildTelemetryPointDto(normalized as NormalizedTeslaPayload) : null;
  }

  // normalized_v1: payload is already DTO-shaped — only the timestamp needs coercion
  // back to a Date (identical to the pre-existing rawPayloadToDto() behaviour).
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const o = payload as Record<string, unknown>;
  const ts = o.timestamp;
  let timestamp: Date | undefined;
  if (ts instanceof Date) timestamp = ts;
  else if (typeof ts === 'string' || typeof ts === 'number') {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) timestamp = d;
  }
  if (timestamp == null) return null;
  return { ...o, timestamp } as CreateTelemetryPointDto;
}
