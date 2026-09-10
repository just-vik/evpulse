# Range Prediction

Status: **as-built** — `range-predictor.service.ts` is fully read in this
pass (271 lines, complete file, no follow-up needed for this specific
service). Verified against `main` @ `5d4b4fb`. See [`README.md`](README.md)
for shared conventions.

This is already a substantially more sophisticated model than a naive
`usableKwh / flatEfficiency` calculation — it's a recency-weighted,
context-aware heuristic blend, not a pure physics formula and not ML
(despite living in `apps/api/src/ml/`). No regression/trained-model step
exists; every factor below is a hand-set constant.

## Definition

Predicted remaining range at the vehicle's current SOC, given recent trip
history, ambient/battery temperature, driving mode (city/highway/mixed),
and a driver-aggressiveness adjustment.

## Inputs

- `currentSoc` (%) — caller-supplied
- `context.speedKmh` (optional) — current speed, used to infer driving mode
- `context.tempC` (optional) — ambient temp; falls back to the vehicle's
  most recent `telemetryPoint.outsideTemp` if omitted
- Last 40 trips (`distanceKm>5`, `efficiencyWhkm` not null, `endTime` not
  null), each carrying `stats.avgSpeed` and `stats.elevationGain`
- `vehicle.batteryCapacityDetected` (from [`battery-health.md`](battery-health.md))
  → fallback `vehicleSpec.batteryUsableKwh` → fallback hardcoded `75`
- Most recent `telemetryPoint.batteryTemp` (separate from ambient temp)

Code: [`range-predictor.service.ts:37-96`](../../apps/api/src/ml/range-predictor.service.ts#L37-L96)

## Tesla source

No live Tesla signal is read directly by this service beyond what's already
stored: historical `Trip`/`TripStats` rows, and the two most-recent
`telemetryPoint.outsideTemp`/`batteryTemp` readings.

## Current implementation

Called two ways: `predict()` (full result, cached) and `predictLive()` (a
thin wrapper returning just `rangeKm`, used by `TripEngineV2` for real-time
WebSocket range updates). Cached in Redis, **adaptive TTL**: 5s while
`speedKmh > 5` (moving), 60s while parked — cache key includes
`vehicleId:round(soc):mode`, so different SOC/mode combos don't collide.

Input trips are filtered twice before use:
1. `isValidTrip()` (shared ML filter, see below) — rejects physically
   implausible trips.
2. Mode partitioning: trips are bucketed by their own `avgSpeed` into
   city/highway/mixed; if the current-mode bucket has `>= 4` trips
   (`MIN_TRIPS_PER_MODE`), only that bucket is used, else it falls back to
   the full validated pool.

## Formula

```
rangeKm = (usableKwh * 1000) / predictedEffWhKm
```

### `predictedEffWhKm` — the actual core of this model

A recency-weighted average of historical trip efficiency, each trip's
contribution adjusted by several independent multiplicative/additive
factors before weighting:

```
weight = 1.0, decaying ×0.88 per trip (most recent first → most weight)

per trip:
  modifier = 1.0
  # speed modifier (mode-aware step function on this trip's own avgSpeed)
  ×1.35 if avgSpeed>120, ×1.22 if >110, ×1.10 if >90, ×0.90 if <40, ×0.95 if <55

  # aerodynamic drag, drag ∝ speed² (100 km/h reference)
  × (1 + (avgSpeed/100)² × 0.08)

  # ambient temperature (non-linear step, see below)
  × tempFactor(tempC)

  # elevation: physics estimate, 0.3 Wh per metre of climb
  + (elevGainM × 0.3 / distanceKm) / max(baseEfficiency, 100)   # additive fractional bump

  contribution = tripEfficiency × modifier × weight

predictedEffWhKm = Σcontribution / Σweight

× (1 + driverAggressiveness × 0.25)          # see below

if batteryTempC < 10:  × 1.10                # cold pack: internal resistance
if batteryTempC > 40:  × 1.08                # hot pack: BMS power limiting
```

### Ambient temperature step function

```
tempFactor: >20°C→1.00, >10°C→1.05, >0°C→1.15, >-10°C→1.30, else→1.40
```

### Driver aggressiveness

```
baseline = 170 Wh/km   // "typical Model Y LR highway" per source comment — not vehicle-specific
median   = median(last 10 trips' efficiencyWhkm), needs >=3 samples else factor=0
factor   = clamp((median - baseline) / baseline, 0, 1)   // only ever inflates predicted consumption, never reduces it
```

### Usable energy

```
socFactor = SOC>80% → 0.92 | SOC>60% → 0.97 | SOC>20% → 1.00 | else → 0.85
usableKwh = batteryKwh × (currentSoc/100) × socFactor
```

Code: [`range-predictor.service.ts:97-155, 210-252`](../../apps/api/src/ml/range-predictor.service.ts#L97-L155)

## Units

kWh for battery capacity, Wh/km for efficiency (internal), km for range —
consistent with [`README.md`](README.md#units).

## Fallbacks

```
batteryKwh: vehicle.batteryCapacityDetected (own SOH estimate)
         → vehicleSpec.batteryUsableKwh (factory spec)
         → 75 (hardcoded)

tempC: caller-supplied context.tempC
     → most recent telemetryPoint.outsideTemp
     → null (tempFactor treats null as 1.0, i.e. no correction)

trips: mode-specific bucket (>=4 trips)
     → full validated pool (if mode bucket too small)
```

`batteryKwh`'s first tier reuses [`battery-health.md`](battery-health.md)'s
own estimate — so any inaccuracy there (Model-Y-derived temperature curve
applied to all models, unverified factory-spec coverage) propagates
directly into every range prediction.

## Data-quality rules

`isValidTrip()` (shared across ML services, not range-specific):

```
reject if: efficiencyWhkm is null/0
        or efficiencyWhkm < 80          (physically impossible for an EV)
        or efficiencyWhkm > 400         (towing / sensor fault)
        or distanceKm < 5               (too short for reliable efficiency)
        or avgSpeed > 160                (GPS artifact / test track)
```

Code: [`trip-validator.ts`](../../apps/api/src/ml/trip-validator.ts)

**This is a different plausibility band than the one in
[`energy.md`](energy.md#formula) (`efficiencyWhkm <= 600` cap at the
per-trip storage stage).** Two independently-chosen thresholds for "is this
efficiency number real" now exist in the codebase — 600 Wh/km at write time
vs. 80–400 Wh/km at ML-read time. Neither is wrong for its own purpose (a
looser cap when just deciding whether to show a number at all vs. a
tighter one before feeding a statistical model), but they were clearly
authored independently rather than sharing one definition — a candidate for
[`data-quality.md`](README.md) to reconcile explicitly rather than silently
carry two different "is this real" answers for the same underlying quantity.

## Confidence

```
confidenceScore = min(0.95, 0.5 + (tripsUsed/40) × 0.45)
confidence label = >=0.80 high | >=0.60 medium | else low
```

A fourth distinct confidence formula/scale, alongside trips/energy's
two-tier score, battery health's dual 0.30–0.95 formulas, and charging's
categorical-only approach. See
[`README.md`](README.md#confidence-model) — now four, not three,
independently-authored confidence representations.

## Edge cases

1. **Driver-aggressiveness baseline (170 Wh/km) is a single hardcoded
   number**, not derived per vehicle model/trim — an efficient city-only
   driver in a Model 3 and a highway-heavy driver in a Model X are compared
   against the same reference point. The factor can only ever *increase*
   predicted consumption (clamped `[0, 1]`), never reduce it below the
   trip-history-implied baseline — a driver more efficient than 170 Wh/km
   gets no corresponding discount.

2. **No regression or trained model exists**, despite the file living under
   `apps/api/src/ml/`. Every coefficient (temperature steps, elevation
   constant, speed modifiers, drag exponent) is a hand-set constant, not
   fit to this vehicle's or any vehicle's actual data. That's not
   necessarily wrong as a v1 — see the roadmap principle of "regression
   baseline before ML" — but it means "ML" in the directory name overstates
   what's implemented today.

3. **Two independently-authored efficiency-plausibility bands** — see
   Data-quality rules above.

4. **`batteryKwh` inherits Battery Health's unresolved edge cases** — see
   Fallbacks above.

5. **Elevation term can push `modifier` outside intuitive bounds** for
   very short, very steep trips (`distanceKm` in the denominator of
   `elevWhPerKm`) — not verified to produce a bad number in practice, but
   the formula has no explicit clamp on the elevation contribution the way
   temperature/speed modifiers do.

## Algorithm version

Not tracked — same gap as every other spec in this directory. The file's
own docstring already calls itself "v1... Improvements over v1" in a
comment, i.e. an informal version note exists in prose but nowhere in
persisted data. See [`README.md`](README.md#formula-versioning).

## Tests

None found (no `range-predictor*.spec.ts` in `apps/api/test/`). Given this
model has more independently-tunable constants than any other calculation
audited so far (temperature steps, elevation constant, drag exponent, SOC
taper, driver-aggressiveness baseline, recency decay rate), it's the
strongest single candidate in the whole calculation layer for
characterization tests before any tuning — a small constant change here
(e.g. adjusting the 170 Wh/km baseline) currently has no regression
safety net at all.
