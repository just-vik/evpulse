import { normalizeTeslaPayload } from '../src/utils/normalizeTeslaTelemetry';

/**
 * Canonical TripPoint.power sign contract (Oct 2026 power-provenance investigation +
 * fix, "normalize charging power polarity"):
 *
 *   driving:  + = discharge, − = regen
 *   charging: + = charging power — same polarity regardless of which Tesla field
 *             produced it (DCChargingPower, ACChargingPower, REST charger_power, or
 *             the PackVoltage×PackCurrent fallback).
 *
 * Before this fix, the fallback branch negated unconditionally, so a charging sample
 * that fell through to it (DCChargingPower/ACChargingPower both absent from that
 * batch — happens when Fleet Telemetry sends a sparse batch) came out NEGATIVE,
 * opposite of every other charging source. VehicleSpeed is untouched by this fix —
 * these tests only cover power.
 */

function fleetEvent(fields: Record<string, number | string>): any {
  return {
    vin: '5YJSA1E26HF000000',
    createdAt: '2026-06-01T10:00:00.000Z',
    data: Object.entries(fields).map(([key, value]) => ({
      key,
      value: typeof value === 'number' ? { doubleValue: value } : { stringValue: value },
    })),
  };
}

describe('normalizeTeslaPayload — canonical power polarity', () => {
  describe('REST (vehicle_data polling) — native Tesla fields, already correct, unchanged by this fix', () => {
    it('driving discharge: drive_state.power positive → positive', () => {
      const r = normalizeTeslaPayload({
        drive_state: { power: 45 },
        charge_state: { charging_state: 'Disconnected' },
      });
      expect(r.power).toBe(45);
    });

    it('driving regen: drive_state.power negative → negative', () => {
      const r = normalizeTeslaPayload({
        drive_state: { power: -12 },
        charge_state: { charging_state: 'Disconnected' },
      });
      expect(r.power).toBe(-12);
    });

    it('charging: charge_state.charger_power positive → positive', () => {
      const r = normalizeTeslaPayload({
        drive_state: {},
        charge_state: { charging_state: 'Charging', charger_power: 7.4 },
      });
      expect(r.power).toBe(7.4);
    });
  });

  describe('Fleet Telemetry — explicit DC/ACChargingPower, already correct, unchanged by this fix', () => {
    it('DC charging: DCChargingPower > 0 → positive', () => {
      const r = normalizeTeslaPayload(fleetEvent({
        ChargingState: 'ChargeStateCharging',
        DCChargingPower: 50,
      }));
      expect(r.power).toBe(50);
    });

    it('AC charging: ACChargingPower > 0 → positive', () => {
      const r = normalizeTeslaPayload(fleetEvent({
        ChargingState: 'ChargeStateCharging',
        ACChargingPower: 7.4,
      }));
      expect(r.power).toBe(7.4);
    });
  });

  describe('Fleet Telemetry — PackVoltage×PackCurrent fallback (the actual fix)', () => {
    it('fallback discharge (driving, not charging): PackCurrent negative → positive', () => {
      const r = normalizeTeslaPayload(fleetEvent({
        ChargingState: 'ChargeStateDisconnected',
        PackVoltage: 400,
        PackCurrent: -50,
      }));
      expect(r.power).toBe(20);
    });

    it('fallback regen (driving, not charging): PackCurrent positive → negative', () => {
      const r = normalizeTeslaPayload(fleetEvent({
        ChargingState: 'ChargeStateDisconnected',
        PackVoltage: 400,
        PackCurrent: 50,
      }));
      expect(r.power).toBe(-20);
    });

    it('fallback charging (ChargingState=Charging, DC/ACChargingPower both absent): PackCurrent positive → POSITIVE — the fix', () => {
      const r = normalizeTeslaPayload(fleetEvent({
        ChargingState: 'ChargeStateCharging',
        PackVoltage: 400,
        PackCurrent: 50,
      }));
      // Before the fix this was -20 — opposite sign from DCChargingPower/
      // ACChargingPower for the exact same physical event.
      expect(r.power).toBe(20);
    });

    it('regression guard: fallback charging never goes negative, even at high current', () => {
      const r = normalizeTeslaPayload(fleetEvent({
        ChargingState: 'ChargeStateCharging',
        PackVoltage: 400,
        PackCurrent: 125,
      }));
      expect(r.power).toBeGreaterThan(0);
    });

    it('ChargeStateStarting (maps to Charging) also gets positive fallback power', () => {
      const r = normalizeTeslaPayload(fleetEvent({
        ChargingState: 'ChargeStateStarting',
        PackVoltage: 400,
        PackCurrent: 20,
      }));
      expect(r.power).toBeGreaterThan(0);
    });
  });

  describe('Fleet Telemetry — explicit charging-power fields still take priority over the fallback', () => {
    it('DCChargingPower present alongside PackVoltage/PackCurrent → DCChargingPower wins', () => {
      const r = normalizeTeslaPayload(fleetEvent({
        ChargingState: 'ChargeStateCharging',
        DCChargingPower: 80,
        PackVoltage: 400,
        PackCurrent: 50, // would derive 20 via fallback — must not be used
      }));
      expect(r.power).toBe(80);
    });
  });
});
