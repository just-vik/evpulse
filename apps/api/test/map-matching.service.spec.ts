/**
 * MapMatchingService — singleton-bridging regression tests.
 *
 * Background: a real trip (Sulzbach (Taunus) → Wallau, 2026-09-07) rendered
 * as an almost-straight diagonal on the map instead of following roads.
 * Root cause: splitByTimeGap() dropped any segment with fewer than 2 points,
 * which silently discarded real GPS fixes stranded alone between two large
 * gaps — including the trip's actual destination fix. bridgeSingletons()
 * fixes this by re-attaching each such fix to its nearest neighbor via a
 * 2-point OSRM /route call instead of dropping it.
 *
 * These tests mock fetch (no live OSRM/network) and use the exact real
 * timestamps/coordinates from that trip's telemetry.
 */

import { MapMatchingService } from '../src/maps/map-matching.service';

function mockFetch() {
  const calls: string[] = [];
  (global as any).fetch = jest.fn((url: string) => {
    calls.push(url);
    const isMatch = url.includes('/match/v1/');
    return Promise.resolve({
      json: () =>
        Promise.resolve(
          isMatch
            ? { code: 'Ok', matchings: [{ geometry: 'matched-geom', distance: 1000 }] }
            : { code: 'Ok', routes: [{ geometry: 'route-geom', distance: 300 }] },
        ),
    } as any);
  });
  return calls;
}

const T = (s: string) => new Date(`2026-09-07T${s}Z`);

// Real (non-interpolated) GPS fixes from the Sulzbach (Taunus) → Wallau trip.
// Gaps: 36s, 85s, 121s(split), 483s(split), 38s, 263s(split).
const bugTripPoints = [
  { lat: 50.121338, lon: 8.523644, timestamp: T('14:15:39') },
  { lat: 50.118632, lon: 8.529426, timestamp: T('14:16:15') },
  { lat: 50.110535, lon: 8.519854, timestamp: T('14:17:40') },
  { lat: 50.092212, lon: 8.483581, timestamp: T('14:19:41') }, // isolated: 121s before, 483s after
  { lat: 50.058668, lon: 8.369831, timestamp: T('14:27:44') },
  { lat: 50.058668, lon: 8.369831, timestamp: T('14:28:22') },
  { lat: 50.063518, lon: 8.368649, timestamp: T('14:32:45') }, // isolated: 263s before — actual destination
];

describe('MapMatchingService — singleton bridging', () => {
  let svc: MapMatchingService;

  beforeEach(() => {
    svc = new MapMatchingService();
  });

  it('retains the trip destination instead of dropping it when isolated by a >2min gap', async () => {
    const calls = mockFetch();
    const result = await svc.match(bugTripPoints);

    expect(result).not.toBeNull();
    // The destination fix (14:32:45, lon 8.368649/lat 50.063518) must have been
    // sent to OSRM as an endpoint of some request — the old code dropped it entirely.
    expect(calls.some(u => u.includes('8.368649,50.063518'))).toBe(true);
  });

  it('bridges an isolated fix stranded between two segments (not just at the tail)', async () => {
    mockFetch();
    const A = { lat: 50.0, lon: 8.0, timestamp: T('10:00:00') };
    const B = { lat: 50.01, lon: 8.0, timestamp: T('10:00:30') };  // +30s  → segment [A,B]
    const C = { lat: 50.02, lon: 8.0, timestamp: T('10:03:20') };  // +170s → isolated
    const D = { lat: 50.03, lon: 8.0, timestamp: T('10:06:40') };  // +200s → isolated from C
    const E = { lat: 50.04, lon: 8.0, timestamp: T('10:07:10') };  // +30s  → segment [D,E]

    const result = await svc.match([A, B, C, D, E]);

    expect(result).not.toBeNull();
    // C (170s from B, 200s from D) bridges to the temporally-closer neighbor (B).
    expect(result!.singletonBridgeCount).toBe(1);
    expect(result!.segmentCount).toBe(3); // [A,B], [B,C] bridge, [D,E]
  });

  it('reports segment/bridge diagnostics for the real bug trip', async () => {
    mockFetch();
    const result = await svc.match(bugTripPoints);

    expect(result).not.toBeNull();
    // Expected segments: [t0,t1,t2], [t2,t3] bridge, [t4,t5], [t5,t6] bridge
    expect(result!.segmentCount).toBe(4);
    expect(result!.singletonBridgeCount).toBe(2);
    expect(result!.largestGapSeconds).toBeCloseTo(483, 0);
    // Any trip that needed a bridge can never be reported as a full trace match.
    expect(result!.type).toBe('estimated');
  });

  it('returns null (not a throw) when OSRM is unreachable', async () => {
    (global as any).fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await svc.match(bugTripPoints);
    expect(result).toBeNull();
  });

  it('is deterministic — identical input and OSRM responses produce identical output', async () => {
    mockFetch();
    const first = await svc.match(bugTripPoints);
    mockFetch();
    const second = await svc.match(bugTripPoints);
    expect(second).toEqual(first);
  });

  it('does not bridge when GPS coverage is contiguous (no gap > 2 min)', async () => {
    mockFetch();
    const dense = [
      { lat: 50.0, lon: 8.0, timestamp: T('10:00:00') },
      { lat: 50.01, lon: 8.0, timestamp: T('10:00:30') },
      { lat: 50.02, lon: 8.0, timestamp: T('10:01:00') },
      { lat: 50.03, lon: 8.0, timestamp: T('10:01:30') },
    ];
    const result = await svc.match(dense);
    expect(result).not.toBeNull();
    expect(result!.segmentCount).toBe(1);
    expect(result!.singletonBridgeCount).toBe(0);
    expect(result!.type).toBe('matched');
  });
});
