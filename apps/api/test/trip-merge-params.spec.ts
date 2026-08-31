import { haversineKmMerge } from '../src/trips/trip-merge-params';

describe('haversineKmMerge', () => {
  it('returns null for NaN / non-finite', () => {
    expect(haversineKmMerge(NaN, 10, 10, 10)).toBeNull();
    expect(haversineKmMerge(10, 10, Infinity, 10)).toBeNull();
  });

  it('returns null for out-of-range lat/lon', () => {
    expect(haversineKmMerge(91, 0, 0, 0)).toBeNull();
    expect(haversineKmMerge(0, 181, 0, 0)).toBeNull();
  });

  it('returns null when a pole is (0,0) — unreliable for vehicles', () => {
    expect(haversineKmMerge(0, 0, 52.5, 13.4)).toBeNull();
    expect(haversineKmMerge(52.5, 13.4, 0, 0)).toBeNull();
  });

  it('returns small distance for nearby Berlin-ish coords', () => {
    const d = haversineKmMerge(52.52, 13.405, 52.53, 13.415);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(0.5);
    expect(d!).toBeLessThan(5);
  });
});
