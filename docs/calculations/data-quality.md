# Data Quality: cross-cutting policy catalogue

Status: **catalogue, not new formulas.** This document collects and cross-
references what the other six specs already found — real data-state
values, real outlier thresholds, real confidence models — as they actually
exist in `apps/api/src` on `main` @ `7dac36b`. It does not introduce a new
enum, threshold, or confidence formula. Where a "unified" shape is
described, it is explicitly a **proposed future contract**, not something
implemented today — see "Proposed future contract" at the end.

This is the last document in the calculation-spec audit. Everything below
is a synthesis of [`energy.md`](energy.md), [`trips.md`](trips.md),
[`charging.md`](charging.md), [`battery-health.md`](battery-health.md),
[`range.md`](range.md), and [`costs.md`](costs.md) — read those for full
formulas and code citations; this doc indexes and cross-cuts them.

## 1. Data states that actually exist in code

No single, shared data-state enum exists. Five independently-defined state
representations were found:

| Representation | Values | Where | Meaning |
|---|---|---|---|
| Telemetry freshness | `REALTIME` (<60s) / `DELAYED` (<300s) / `STALE` (<900s) / `OFFLINE` (else/null) | `vehicle-analytics.service.ts:29-35` (`DataQuality` type) | Governs which UI controls are enabled — see [`../../apps/api/src/tesla-fleet/tesla-commands.controller.ts`](../../apps/api/src/tesla-fleet/tesla-commands.controller.ts) and the frontend `vehicleCommandPolicy.ts` |
| Trip reliability | `HIGH` / `MEDIUM` / `LOW` | `Trip.reliability` (schema), set in `trip-post-processor.service.ts:818-824`; reconstructed/gap-recovered trips start at `LOW` | A trip-level trust label, distinct from the 0–100 quality score in [`trips.md`](trips.md) / [`energy.md`](energy.md#confidence) |
| Trip quality score | 0–100 numeric, `HIGH`(≥80)/`MEDIUM`(≥50)/`LOW` label | `TripBuilder.computeQuality()`, [`energy.md`](energy.md#confidence) | Gap count / signal-loss / interpolated-point penalty — not currently shown in any UI |
| Trip anomaly flags | free-form JSON array, e.g. `['HIGH_EFFICIENCY','GPS_JUMP']` | `Trip.anomalyFlags` (schema) | A tag list, not an enum — no fixed vocabulary verified in this pass |
| Battery-health "no data yet" | `dataQuality: 'learning'` | `battery-analytics.service.ts` `getBatteryHealth()`, no-record branch | The only place a battery metric returns a string data-quality label at all |

`reliability` and the trip quality score are **not the same field** and
can disagree (a `HIGH`-reliability trip could still have a mediocre quality
score, since they're computed by different code with different inputs) —
neither this audit nor, as far as verified, the product surfaces both
together anywhere.

No `VALID`/`DEGRADED`/`ESTIMATED`/`STALE`/`MISSING`/`INVALID` taxonomy
exists anywhere in the codebase. Introducing one is a genuine design
decision for the future contract, not a description of current behavior.

## 2. Source hierarchy

Already documented as a cross-cutting pattern in
[`README.md`](README.md#data-source-hierarchy) — not repeated here. Summary
of what has a real fallback ladder vs. what doesn't:

| Metric | Has a real ladder? |
|---|---|
| Charging energy | Yes — Tesla delta → power integral |
| Charging cost | Yes — catalog API → configured tariff → hardcoded default (×5 independent implementations, see [`costs.md`](costs.md)) |
| Trip distance (final) | Yes — GPS → odometer |
| Trip energy | **No** — power integral only, `null` power reads as zero |
| Battery nominal capacity | Yes — factory-spec table → per-vehicle field |
| Range `batteryKwh` | Yes — detected SOH capacity → factory spec → hardcoded 75 |

## 3. Telemetry quality rules actually in use

Collected from the six specs, by concern:

- **Missing points**: trip energy treats missing `power` as `0`, not
  "unknown" ([`energy.md`](energy.md#edge-cases) #1). No equivalent
  "treat missing as zero" behavior was found for SOC or charging energy —
  those are gated by explicit null-checks instead.
- **Timestamp gaps**: trip detection uses a **self-calibrating** dynamic
  threshold (median of last 10 intervals × 2.5, floor 60s) rather than a
  fixed timeout, specifically to handle both ~10s streaming and 60–300s
  REST-poll cadences ([`trips.md`](trips.md#valid-telemetry-points--gap-handling)).
  Charging detection uses a fixed 3-minute pause grace instead
  ([`charging.md`](charging.md#session-end--pause-tolerance)) — two
  different gap-tolerance philosophies for structurally similar problems.
- **Stale telemetry**: the `REALTIME`/`DELAYED`/`STALE`/`OFFLINE` ladder
  above — the only freshness classification found, used for command
  eligibility, not (as far as verified) for gating any calculation's
  confidence.
- **SOC jumps**: **no validation exists anywhere audited.** Neither trip
  detection, charging detection, nor battery health rejects or flags an
  implausible SOC delta between consecutive points
  ([`trips.md`](trips.md#soc-jumps)). This is the most consistently absent
  check across every spec.
- **Power anomalies**: the regen threshold (`power<-10kW & speed>5`,
  [`energy.md`](energy.md#formula)) filters BMS balancing noise; the
  DC-fast-charge inference (`power>30kW & speed<2`,
  [`charging.md`](charging.md#which-tesla-states-count-as-charging))
  filters preconditioning draw by requiring the correct power *sign*.
- **GPS gaps/jumps**: teleport filter (`>200km/h` implied or `>0.3km` in
  `<5s`, [`trips.md`](trips.md#gps-jump--teleport-filtering)); sparse-GPS
  correction via odometer fallback (same doc, "Distance").
- **Odometer fallback**: only used for finalized-trip distance, only when
  GPS underestimates by >25% — not a general "prefer odometer" rule
  ([`trips.md`](trips.md#distance)).
- **Charging-session gaps**: 3-minute pause grace before ending a session;
  three-rule ghost-session rejection at end
  ([`charging.md`](charging.md#minimum-session-duration--ghost-session-rejection)).

## 4. Outlier / plausibility thresholds — catalogued, not unified

Every threshold below is real, independently authored, and currently
serves only the one calculation listed. **None are changed by this
document.**

| Threshold | Value | Protects | Why it exists (as documented) |
|---|---|---|---|
| Trip consumption storage cap | ≤600 Wh/km | [`energy.md`](energy.md#formula) `efficiencyWhkm` | Reject implausible per-trip efficiency before it's ever stored/displayed |
| Range-prediction input validity | 80–400 Wh/km | [`range.md`](range.md#data-quality-rules) `isValidTrip()` | A *tighter* band for feeding a statistical model — "physically impossible" and "towing/sensor fault" per source comment |
| GPS-artifact speed | avgSpeed > 160 km/h | [`range.md`](range.md#data-quality-rules) `isValidTrip()` | Test-track / GPS glitch, not real driving |
| Battery capacity bounds (Engine A) | 20–120 kWh (absolute) | [`battery-health.md`](battery-health.md#formula) | "Covers all Tesla models" — not model-specific |
| Battery SOH bounds (Engine B, range method) | 50–130% of nominal | [`battery-health.md`](battery-health.md#engine-b-canonical-batteryanalyticsservice) | Different unit (relative %, not absolute kWh) from Engine A's bound above for a conceptually similar guard |
| Battery SOH bounds (Engine B, charging/trip methods) | 50–110% of nominal | same | Tighter than the range-method bound in the same service |
| Charging efficiency clamp | 0.70–1.25 | [`charging.md`](charging.md#efficiency) | AC home 0.90–0.96 / DC fast 0.85–0.93 typical, per inline comment — heuristic, not cited to an external source |
| Ghost-session energy floor | <0.05 kWh (Rule A) | [`charging.md`](charging.md#minimum-session-duration--ghost-session-rejection) | Never a real charge |
| Trip hard-ignore confidence | <0.3 | [`trips.md`](trips.md#data-quality-rules--confidence) | Point too noisy to affect state transitions |
| GPS teleport | >200 km/h implied, or >0.3km in <5s | [`trips.md`](trips.md#gps-jump--teleport-filtering) | Reject a GNSS glitch mid-trip |

**Three separate consumption-plausibility bands exist for what is,
physically, the same underlying quantity** (Wh/km): ≤600 (storage), 80–400
(ML input), and implicitly whatever a "reasonable" efficiency looks like
in the battery-efficiency and range-baseline calculations. They were
authored independently for different purposes (a display sanity check vs.
an ML-input gate) and are not wrong individually, but they've never been
reconciled against each other. Same story for battery capacity bounds:
absolute kWh in one engine, relative % in the other, for conceptually the
same "is this capacity estimate physically real" question.

**This audit does not recommend collapsing these into one number.** A
display-time sanity check and a statistical-model input gate serve
different purposes and can legitimately have different widths. The
recommendation is narrower: each threshold should *say what it protects
and why* (this table is the first pass at that) so future changes are
deliberate, not accidental drift.

## 5. Confidence — six independently-authored representations, catalogued

| # | Representation | Scale | Where |
|---|---|---|---|
| 1 | Trip/energy point confidence | 0–1, gates state transitions only | [`energy.md`](energy.md#data-quality-rules) |
| 2 | Trip/energy quality score | 0–100, HIGH/MEDIUM/LOW | [`energy.md`](energy.md#confidence) |
| 3 | Battery health, Engine A | 0.30–0.70 / 0.50–0.95, scaled by session count | [`battery-health.md`](battery-health.md#confidence) |
| 4 | Battery health, Engine B (SOH blend) | `methodsAgreeing/3` → 0.33/0.67/1.00 | [`battery-health.md`](battery-health.md#formula---three-independent-estimators-then-a-weighted-median) |
| 5 | Battery health, Engine B (baseline lock) | categorical HIGH/MEDIUM/NONE | [`battery-health.md`](battery-health.md#baseline-lock--a-separate-permanent-reference-capacity-mechanism) |
| 6 | Range prediction | 0–1 scaled by trip count, own HIGH/MEDIUM/LOW cutoffs (≥0.80/≥0.60) | [`range.md`](range.md#confidence) |
| — | Charging | *No numeric confidence* — categorical `costSource`/`chargerType` strings only | [`charging.md`](charging.md#data-quality-rules--confidence) |
| — | Costs | *No confidence at all* — `CostForecastService`'s `rateSource`/`dataSource` are provenance labels, not trust scores | [`costs.md`](costs.md#data-quality-rules--confidence) |

No two of the six numeric/categorical scales share boundaries, meaning, or
computation. A `confidence: 0.7` from range prediction and a
`confidence: 0.7` from battery health Engine A are not comparable numbers
— they're outputs of unrelated formulas that happen to land in the same
range.

## Proposed future contract (NOT implemented — design target only)

The shape below is what a future unified result could look like. It is
**not** built, **not** in the Prisma schema, and no calculation currently
returns this shape. Written here so the eventual schema/contract work has
a documented starting point instead of designing from scratch:

```ts
type CalculationResult<T> = {
  value: T;
  rawValue?: T;              // pre-clamping value, when a display cap exists
                              // (e.g. battery health's min(100, ...) — see
                              // battery-health.md edge case #3)
  source: 'tesla_direct' | 'tesla_derived' | 'evpulse_calculated' | 'external' | 'fallback';
  method: string;             // e.g. 'charging_quality', 'weighted_median', 'range'
  observationCount: number;   // raw inputs used (sessions, trips, points —
                              // NOT method count, see battery-health.md's
                              // sampleCount-means-two-things finding)
  methodCount?: number;       // distinct estimation methods that agreed, when applicable
  confidence: number;         // 0-1, meaning TBD by a real cross-metric design pass
  confidenceLevel: 'VERY_LOW' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
  algorithmVersion: string;   // e.g. 'energy-v1' — see README.md#formula-versioning
  calculatedAt: Date;
};
```

A proposed confidence-level banding (numbers only — not yet mapped from
any existing formula, and no existing formula's 0–1 output should be
silently reinterpreted through this band without a deliberate migration
per metric):

```
0.00–0.29  VERY_LOW
0.30–0.49  LOW
0.50–0.69  MEDIUM
0.70–0.84  HIGH
0.85–1.00  VERY_HIGH
```

Before this contract can be built for real, in order:
1. Decide the semantics of `observationCount` vs `methodCount` per metric
   (battery health already needs both, distinctly).
2. Decide whether `confidence` gets recomputed on a shared scale per
   metric, or whether each metric keeps its own formula and only
   `confidenceLevel` becomes shared (mapped per-metric, with different
   metrics allowed different mapping functions if their formulas aren't
   comparable).
3. Add `algorithmVersion` to the schema *before* changing any formula this
   contract would apply to — not after, per the versioning gap already
   flagged as recurring in every spec ([`README.md`](README.md#formula-versioning)).
4. Only then touch the `BatteryHealth` table (or any other) to add
   `rawValue`/provenance fields — a schema change should follow the
   contract design, not precede it.

## What this document deliberately does not do

- Does not unify the outlier thresholds in section 4.
- Does not unify the confidence formulas in section 5.
- Does not propose a Prisma migration.
- Does not change `BatteryHealthService`'s writer status (see
  [`battery-health.md`](battery-health.md#canonical-engine) for that
  decision, already made separately).

This closes the calculation-spec audit phase:

```
README          ✓
energy          ✓
trips           ✓
charging        ✓
battery-health  ✓ (+ canonical-engine decision)
range           ✓
costs           ✓
data-quality    ✓ (this document)
```
