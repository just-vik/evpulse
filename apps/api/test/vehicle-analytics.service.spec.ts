import { getDataQuality } from '../src/analytics/vehicle-analytics.service';

// P1.2.1 canonical freshness policy — recalibrated against real production
// telemetry cadence for a parked vehicle (observed gaps: 50s–6m20s). See the
// doc comment on getDataQuality for the full rationale; this is the single
// canonical helper — REST, WebSocket, and any future consumer must all read
// dataQuality from here, never recompute their own thresholds.
describe('getDataQuality — canonical freshness thresholds', () => {
  it('0s → REALTIME', () => {
    expect(getDataQuality(0)).toBe('REALTIME');
  });

  it('59s → REALTIME', () => {
    expect(getDataQuality(59)).toBe('REALTIME');
  });

  it('60s → DELAYED', () => {
    expect(getDataQuality(60)).toBe('DELAYED');
  });

  it('299s → DELAYED', () => {
    expect(getDataQuality(299)).toBe('DELAYED');
  });

  it('300s → STALE', () => {
    expect(getDataQuality(300)).toBe('STALE');
  });

  it('899s → STALE', () => {
    expect(getDataQuality(899)).toBe('STALE');
  });

  it('900s → OFFLINE', () => {
    expect(getDataQuality(900)).toBe('OFFLINE');
  });

  it('null → OFFLINE', () => {
    expect(getDataQuality(null)).toBe('OFFLINE');
  });

  it('a very large value → OFFLINE (no upper bound cliff)', () => {
    expect(getDataQuality(999_999)).toBe('OFFLINE');
  });
});
