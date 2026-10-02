import {
  PAYLOAD_KIND_NORMALIZED_V1,
  PAYLOAD_KIND_TESLA_FLEET_TELEMETRY_V1,
  buildTelemetryPointDto,
  normalizeRawTelemetryPayload,
  rawPayloadToPoint,
} from '../src/telemetry/raw-telemetry-payload';
import { normalizeTeslaPayload } from '../src/utils/normalizeTeslaTelemetry';

/**
 * Regression tests for raw-payload replay dispatch (telemetry audit, Oct 2026, commit 2/4:
 * "persist raw fleet telemetry events"). TelemetryRaw.payload can now hold either shape —
 * these confirm both replay paths resolve correctly and that history already written
 * before payloadKind existed (payloadKind absent/'normalized_v1') keeps working unchanged.
 */
describe('raw-telemetry-payload', () => {
  const teslaEvent = {
    vin: '5YJSA1E26HF000000',
    createdAt: '2026-03-20T10:00:00.000Z',
    data: [
      { key: 'VehicleSpeed', value: { doubleValue: 56 } },
      { key: 'BatteryLevel', value: { doubleValue: 61 } },
      { key: 'Odometer', value: { doubleValue: 1000 } },
    ],
  };

  describe('rawPayloadToPoint — new tesla_fleet_telemetry_v1 rows', () => {
    it('нормализует raw Tesla event через normalizeTeslaPayload() и строит тот же DTO, что и живой путь', () => {
      const point = rawPayloadToPoint(teslaEvent, PAYLOAD_KIND_TESLA_FLEET_TELEMETRY_V1);
      const expected = buildTelemetryPointDto(normalizeTeslaPayload(teslaEvent));

      expect(point).not.toBeNull();
      expect(point).toEqual(expected);
      // Spot-check a couple of fields directly, so this test still fails loudly if
      // buildTelemetryPointDto itself regresses rather than just mirroring it blindly.
      expect(point!.speed).toBe(56); // Fleet Telemetry VehicleSpeed is already km/h — not re-converted
      expect(point!.soc).toBe(61);
      expect(point!.timestamp).toEqual(new Date('2026-03-20T10:00:00.000Z'));
    });

    it('возвращает null для мусорного payload вместо падения', () => {
      expect(rawPayloadToPoint(null, PAYLOAD_KIND_TESLA_FLEET_TELEMETRY_V1)).toBeNull();
      expect(rawPayloadToPoint('not-an-object', PAYLOAD_KIND_TESLA_FLEET_TELEMETRY_V1)).toBeNull();
    });
  });

  describe('rawPayloadToPoint — legacy normalized_v1 rows (written before this change)', () => {
    const legacyPayload = {
      timestamp: '2026-01-15T08:00:00.000Z',
      soc: 70,
      speed: 42,
      power: 8.5,
      latitude: 50.1,
      longitude: 8.6,
      charging_state: 'Disconnected',
    };

    it('продолжает работать как раньше, когда payloadKind явно normalized_v1', () => {
      const point = rawPayloadToPoint(legacyPayload, PAYLOAD_KIND_NORMALIZED_V1);
      expect(point).not.toBeNull();
      expect(point!.timestamp).toEqual(new Date('2026-01-15T08:00:00.000Z'));
      expect(point!.soc).toBe(70);
      expect(point!.speed).toBe(42);
      expect((point as any).charging_state).toBe('Disconnected');
    });

    it('продолжает работать для строк, записанных до появления payloadKind (undefined/null)', () => {
      // Prisma column default backfills these to 'normalized_v1', but a caller reading
      // the row before that default is applied (or an older select) may still see
      // undefined/null — must resolve exactly the same as the explicit value.
      expect(rawPayloadToPoint(legacyPayload, undefined)).toEqual(
        rawPayloadToPoint(legacyPayload, PAYLOAD_KIND_NORMALIZED_V1),
      );
      expect(rawPayloadToPoint(legacyPayload, null)).toEqual(
        rawPayloadToPoint(legacyPayload, PAYLOAD_KIND_NORMALIZED_V1),
      );
    });

    it('отбрасывает payload без валидного timestamp (как и прежний rawPayloadToDto)', () => {
      expect(rawPayloadToPoint({ soc: 50 }, PAYLOAD_KIND_NORMALIZED_V1)).toBeNull();
      expect(rawPayloadToPoint({ timestamp: 'not-a-date' }, PAYLOAD_KIND_NORMALIZED_V1)).toBeNull();
    });
  });

  describe('normalizeRawTelemetryPayload — used by trip rebuild from raw telemetry', () => {
    it('для tesla_fleet_telemetry_v1 возвращает normalizeTeslaPayload(), а не сырой Tesla event', () => {
      const result = normalizeRawTelemetryPayload(teslaEvent, PAYLOAD_KIND_TESLA_FLEET_TELEMETRY_V1);
      expect(result).toEqual(normalizeTeslaPayload(teslaEvent));
      expect(result!.speed).toBe(56);
      expect(result!.odometer).toBeCloseTo(1000 * 1.60934, 1);
    });

    it('для normalized_v1 (и для undefined/legacy) возвращает payload как есть', () => {
      const legacy = { timestamp: '2026-01-01T00:00:00.000Z', speed: 30, power: 2 };
      expect(normalizeRawTelemetryPayload(legacy, PAYLOAD_KIND_NORMALIZED_V1)).toEqual(legacy);
      expect(normalizeRawTelemetryPayload(legacy, undefined)).toEqual(legacy);
    });
  });
});
