/**
 * Application-level battery-health result contract — NOT yet persisted in
 * this shape. The `BatteryHealth` table and its writers are unchanged; this
 * is step 1 of the plan in docs/calculations/data-quality.md ("Proposed
 * future contract"): give the fields a concrete, documented meaning before
 * any schema migration follows, instead of designing columns on the fly.
 *
 * Produced by BatteryAnalyticsService.computeBatteryHealthResult() — see
 * that method for how each field is actually populated.
 */

/**
 * Which estimator(s) contributed. A single value when only one of the
 * three methods (range/charging/trip) returned a usable result;
 * 'weighted_median' when more than one agreed and were blended — this
 * mirrors the existing `BatteryHealth.method` column's real values
 * exactly (battery-analytics.service.ts's `method: validMethods.length > 1
 * ? 'weighted_median' : methodNames`), so persisting this field later is a
 * rename, not a remapping.
 */
export type BatteryHealthSource = 'trip' | 'charging' | 'range' | 'weighted_median';

export interface BatteryHealthResult {
  /** Display SOH: temperature-corrected, clamped to [70,100]. What the
   *  user sees. */
  value: number;

  /** SOH before the [70,100] clamp — see docs/calculations/battery-health.md
   *  edge case #3 (the live comparison run that found a raw ~108% estimate,
   *  from an 81.1kWh capacity against a lower nominal, hidden behind the
   *  display cap). Always populated: equals `value` when clamping didn't
   *  change anything. */
  rawValue: number;

  /** See BatteryHealthSource doc comment above. */
  source: BatteryHealthSource;

  /**
   * Total raw observations — charging sessions + trips + range telemetry
   * points — summed across every method that contributed. Deliberately
   * NOT the same field as methodCount: docs/calculations/battery-health.md
   * found the two existing engines already disagree on what "sample
   * count" means (Engine A: sessions; Engine B: methods-agreeing), so this
   * contract keeps observation-level and method-level counts as two
   * separate, unambiguous fields instead of overloading one.
   */
  observationCount: number;

  /** How many of the 3 possible estimators (range/charging/trip) returned
   *  a usable result and were blended into `value`. 1-3. This is what the
   *  existing confidence formula (methodCount/3) actually measures. */
  methodCount: number;

  /** Existing formula, unchanged: min(1.0, methodCount/3). Not recomputed
   *  on any unified scale yet — seeing docs/calculations/README.md's
   *  confidence-model catalogue, that unification is deliberately
   *  deferred until the other five representations are reconciled too,
   *  not decided ad hoc here for battery health alone. */
  confidence: number;

  /** Not tracked anywhere before this contract existed (verified: no
   *  algorithm-version field exists in the schema or any prior code).
   *  Bump BATTERY_HEALTH_ALGORITHM_VERSION below whenever
   *  computeBatteryHealthResult's formula changes, BEFORE the change
   *  ships — see docs/calculations/README.md#formula-versioning. */
  algorithmVersion: string;
}

/**
 * Bump this — and only this — when computeBatteryHealthResult's formula
 * changes (estimator weights, temperature correction, clamp bounds, etc).
 * A single constant rather than per-caller strings so there is exactly one
 * place that defines "what version is this build's calculation."
 */
export const BATTERY_HEALTH_ALGORITHM_VERSION = 'battery-analytics-v1';
