import { resolveRouteQuality } from '../src/trips/route-quality.util';

describe('resolveRouteQuality', () => {
  it('returns UNAVAILABLE with fewer than 3 raw GPS points, regardless of other signals', () => {
    expect(
      resolveRouteQuality({
        rawGpsPointsCount: 2,
        singletonBridgesCount: 0,
        largestGapSeconds: 5,
        reconstructedDistancePercent: 0,
      }),
    ).toBe('UNAVAILABLE');
  });

  it('caps a sparse/bridged route at PARTIAL even with many raw points — never HIGH', () => {
    expect(
      resolveRouteQuality({
        rawGpsPointsCount: 30,
        singletonBridgesCount: 1,
        largestGapSeconds: 50,
        reconstructedDistancePercent: 5,
      }),
    ).toBe('PARTIAL');
  });

  it('caps at PARTIAL when the largest real-GPS gap exceeds 2 minutes, even with 0 bridges', () => {
    expect(
      resolveRouteQuality({
        rawGpsPointsCount: 20,
        singletonBridgesCount: 0,
        largestGapSeconds: 200,
        reconstructedDistancePercent: 0,
      }),
    ).toBe('PARTIAL');
  });

  it('caps at PARTIAL when more than 20% of distance came from 2-point /route legs', () => {
    expect(
      resolveRouteQuality({
        rawGpsPointsCount: 20,
        singletonBridgesCount: 0,
        largestGapSeconds: 10,
        reconstructedDistancePercent: 25,
      }),
    ).toBe('PARTIAL');
  });

  it('returns HIGH only for dense points, tight gaps, and no reconstruction', () => {
    expect(
      resolveRouteQuality({
        rawGpsPointsCount: 20,
        singletonBridgesCount: 0,
        largestGapSeconds: 10,
        reconstructedDistancePercent: 0,
      }),
    ).toBe('HIGH');
  });

  it('returns MEDIUM for a clean but not-dense-enough trip', () => {
    expect(
      resolveRouteQuality({
        rawGpsPointsCount: 8,
        singletonBridgesCount: 0,
        largestGapSeconds: 40,
        reconstructedDistancePercent: 0,
      }),
    ).toBe('MEDIUM');
  });
});
