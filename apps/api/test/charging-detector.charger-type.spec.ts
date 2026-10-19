/**
 * Regression: detectChargerType must return 'ac_city' (third-party rate) when
 * GPS confirms the vehicle is NOT at its registered home location.
 *
 * Root cause of the 2026-10-14 Interparking misclassification:
 *   isAtHomeLocation() returned false (Netherlands, 600 km from Wiesbaden home),
 *   but detectChargerType fell through to the default 'return home_wall', applying
 *   homeChargingRate (€0.32/kWh) instead of thirdPartyRate (€0.71/kWh).
 *
 * After fix:
 *   - GPS present + at home        → home_wall
 *   - GPS present + NOT at home    → ac_city  (THIRD_PARTY_TYPES → thirdPartyRate)
 *   - No GPS                       → home_wall (conservative: better to under-charge
 *                                    than to apply a third-party rate to a real home charge)
 *   - powerKw >= 50                → tesla_sc  (unchanged — Supercharger detection)
 *   - powerKw > 22 < 50            → dc_third  (unchanged)
 *   - powerKw > 11 <= 22           → ac_city   (unchanged — power-based public AC)
 *   - powerKw <= 2                 → home_slow (unchanged)
 *
 * Note: ac_city is in TariffResolverService.THIRD_PARTY_TYPES, so thirdPartyRate applies.
 * ChargingSyncService does NOT sync ac_city sessions with Tesla Billing API (only
 * tesla_sc / supercharger / dc_third / dc_fast are queued) — that is intentional:
 * a VIN=N/A public card session has no Tesla billing entry to match against.
 */

import { ChargingDetectorService } from '../src/charging/charging-detector.service';

const HOME_LAT = 50.0587;
const HOME_LNG = 8.4155;

const AWAY_LAT = 52.0707;  // Scheveningen, ~600 km from home
const AWAY_LNG = 4.2769;

function buildService(homeConfigured: boolean) {
  const prisma = {
    chargingSession: {
      findFirst: jest.fn().mockResolvedValue(null),
      create:    jest.fn().mockResolvedValue({ id: 'sess-1' }),
      update:    jest.fn().mockResolvedValue({}),
    },
    chargingPoint: {
      create: jest.fn().mockResolvedValue({ id: 'pt-1' }),
    },
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({ batteryCapacityDetected: 77 }),
    },
    vehicleSettings: {
      findUnique: jest.fn().mockResolvedValue(
        homeConfigured
          ? { homeLatitude: HOME_LAT, homeLongitude: HOME_LNG }
          : null,
      ),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };

  return new ChargingDetectorService(prisma as any);
}

describe('ChargingDetectorService.detectChargerType — GPS-based classification', () => {

  it('GPS present + at home → home_wall', async () => {
    const svc = buildService(true);
    const type = await (svc as any).detectChargerType(
      7.4,          // 7.4 kW — typical home wall-box
      null, null,   // fastChargerType, fastChargerBrand
      'veh-1',
      HOME_LAT, HOME_LNG,
    );
    expect(type).toBe('home_wall');
  });

  it('GPS present + NOT at home → ac_city (not home_wall)', async () => {
    const svc = buildService(true);
    const type = await (svc as any).detectChargerType(
      7.0,          // 7 kW public AC (Interparking Boulevard case)
      null, null,
      'veh-1',
      AWAY_LAT, AWAY_LNG,
    );
    expect(type).toBe('ac_city');
    expect(type).not.toBe('home_wall');
  });

  it('No GPS (lat/lng null) → home_wall (conservative default)', async () => {
    const svc = buildService(true);
    const type = await (svc as any).detectChargerType(
      7.4,
      null, null,
      'veh-1',
      null, null,  // no coordinates
    );
    expect(type).toBe('home_wall');
  });

  it('No home settings configured → ac_city when GPS present and away', async () => {
    // isAtHomeLocation() returns false when no settings row exists
    const svc = buildService(false);
    const type = await (svc as any).detectChargerType(
      7.4,
      null, null,
      'veh-1',
      AWAY_LAT, AWAY_LNG,
    );
    expect(type).toBe('ac_city');
  });

  it('No home settings + no GPS → home_wall', async () => {
    const svc = buildService(false);
    const type = await (svc as any).detectChargerType(
      7.4,
      null, null,
      'veh-1',
      null, null,
    );
    expect(type).toBe('home_wall');
  });

  // ── Power-band boundaries unchanged by this fix ──────────────────────────

  it('powerKw >= 50 → tesla_sc (Supercharger not affected)', async () => {
    const svc = buildService(true);
    const type = await (svc as any).detectChargerType(
      250, null, null, 'veh-1', AWAY_LAT, AWAY_LNG,
    );
    expect(type).toBe('tesla_sc');
  });

  it('fastChargerType Tesla → tesla_sc (explicit signal not affected)', async () => {
    const svc = buildService(true);
    const type = await (svc as any).detectChargerType(
      30, 'Tesla', null, 'veh-1', AWAY_LAT, AWAY_LNG,
    );
    expect(type).toBe('tesla_sc');
  });

  it('powerKw > 22 and < 50 → dc_third (DC not affected)', async () => {
    const svc = buildService(true);
    const type = await (svc as any).detectChargerType(
      40, null, null, 'veh-1', AWAY_LAT, AWAY_LNG,
    );
    expect(type).toBe('dc_third');
  });

  it('powerKw > 11 → ac_city (power-based public AC not affected)', async () => {
    const svc = buildService(true);
    const type = await (svc as any).detectChargerType(
      15, null, null, 'veh-1', HOME_LAT, HOME_LNG,
    );
    expect(type).toBe('ac_city');
  });

  it('powerKw <= 2 → home_slow (not affected)', async () => {
    const svc = buildService(true);
    const type = await (svc as any).detectChargerType(
      1.8, null, null, 'veh-1', HOME_LAT, HOME_LNG,
    );
    expect(type).toBe('home_slow');
  });

});
