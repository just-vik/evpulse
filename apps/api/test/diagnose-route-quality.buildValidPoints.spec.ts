/**
 * Regression guard for a bug found while validating the singleton-bridging
 * route fix: the diagnostic script originally fed `nonInterpolatedRows`
 * (telemetry rows with interpolated=false, which can still have a null
 * lat/lon) into resolveRouteQuality()'s `rawGpsPointsCount`, whose contract
 * requires coordinate-valid fixes only. On the actual bug trip this didn't
 * change the result (gaps/bridges already forced PARTIAL), but on a trip
 * with many null-coordinate rows and few real gaps it would have produced a
 * falsely confident HIGH/MEDIUM classification instead of the correct one.
 *
 * Invariant: route quality, map-match input, and GPS coverage MUST be
 * computed from coordinate-valid telemetry points only. A non-interpolated
 * row without latitude/longitude is telemetry evidence, not a GPS fix, and
 * must never improve route confidence.
 */

import { buildValidPoints } from '../scripts/diagnose-route-quality';
import { resolveRouteQuality } from '../src/trips/route-quality.util';

function row(overrides: Partial<{ latitude: number | null; longitude: number | null; timestamp: Date; interpolated: boolean }>) {
  return {
    latitude: null,
    longitude: null,
    timestamp: new Date('2026-01-01T00:00:00Z'),
    interpolated: false,
    ...overrides,
  };
}

describe('diagnose-route-quality buildValidPoints — coordinate-validity invariant', () => {
  it('does not let non-interpolated rows with null lat/lon inflate the valid GPS point count', () => {
    const T = (s: string) => new Date(`2026-01-01T${s}Z`);
    // Reproduces the actual Sulzbach → Wallau bug trip shape: 15 rows with
    // interpolated=false, 8 of them carrying no GPS lock (null lat/lon).
    const rows = [
      row({ latitude: 50.121338, longitude: 8.523644, timestamp: T('14:15:39') }),
      row({ latitude: 50.118632, longitude: 8.529426, timestamp: T('14:16:15') }),
      row({ latitude: 50.110535, longitude: 8.519854, timestamp: T('14:17:40') }),
      row({ timestamp: T('14:18:16') }), // null coords — telemetry event, not a fix
      row({ latitude: 50.092212, longitude: 8.483581, timestamp: T('14:19:41') }),
      row({ timestamp: T('14:20:18') }),
      row({ timestamp: T('14:21:42') }),
      row({ timestamp: T('14:22:18') }),
      row({ timestamp: T('14:23:43') }),
      row({ timestamp: T('14:24:19') }),
      row({ timestamp: T('14:25:43') }),
      row({ timestamp: T('14:26:20') }),
      row({ latitude: 50.058668, longitude: 8.369831, timestamp: T('14:27:44') }),
      row({ latitude: 50.058668, longitude: 8.369831, timestamp: T('14:28:22') }),
      row({ latitude: 50.063518, longitude: 8.368649, timestamp: T('14:32:45') }),
    ];

    const { nonInterpolatedRows, invalidCount, validPoints } = buildValidPoints(rows);

    expect(nonInterpolatedRows).toBe(15); // all rows counted, regardless of coordinate validity
    expect(invalidCount).toBe(8);         // the 8 null-coordinate rows
    expect(validPoints).toHaveLength(7);  // only coordinate-valid fixes — must NOT be 15
  });

  it('a caller that mistakenly passes the row count instead of the valid-point count gets a falsely confident classification', () => {
    // Deliberately small gaps and no bridging — isolates the point-count
    // input as the only variable between the buggy and correct call.
    const commonInput = { singletonBridgesCount: 0, largestGapSeconds: 20, reconstructedDistancePercent: 0 };

    const correct = resolveRouteQuality({ ...commonInput, rawGpsPointsCount: 7 });  // validGpsPoints
    const buggy   = resolveRouteQuality({ ...commonInput, rawGpsPointsCount: 15 }); // nonInterpolatedRows (wrong)

    expect(correct).toBe('MEDIUM');  // 7 points doesn't clear the HIGH bar (>= 15)
    expect(buggy).toBe('HIGH');      // proves the wrong input silently overstates confidence
    expect(buggy).not.toBe(correct);
  });
});
