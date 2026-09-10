# Energy Consumed (per trip)

Status: **as-built** — describes what the code does today, verified against
`apps/api/src` on `main` @ `c5e5549`. Nothing here is a proposed formula;
where current behavior has a real limitation, it's called out explicitly
under "Edge cases" instead of being smoothed over. See
[`README.md`](README.md) for units, the confidence model, and the
data-source hierarchy shared across all metric specs.

## Definition

Net electrical energy drawn from (or returned to) the battery during a trip,
computed as a running power integral while the vehicle is driving.

## Inputs

- `data.power` — instantaneous power (kW), signed (negative = regen)
- `dtMs` — elapsed time since the previous processed point
- `isPlugged` — whether the vehicle is currently charging
- `isGap` — whether this point follows a telemetry gap being bridged
- `speed` — used only to gate the regen threshold, not the energy integral itself

Code: [`trip-detector.service.ts:148, 374–391`](../../apps/api/src/trips/trip-detector.service.ts#L148)

## Tesla source

Tesla Fleet Telemetry, `power` signal (kW). No REST/`vehicle_data` polling
fallback for this signal — it's streaming-only.

## Current implementation

Runs per telemetry tick, inline inside the trip state machine
(`TripDetectorService`'s point-processing path) — not a separate batch job
or post-processing step. Every processed point updates a per-vehicle
in-memory `cache` entry (`prev.energyKwh`) and immediately pushes the new
running total into `TripBuilder` (`updateEnergy`), which is what the live
trip endpoint and the final DB row both read from.

Code: [`trip-detector.service.ts:374–391`](../../apps/api/src/trips/trip-detector.service.ts#L374-L391)

## Formula

Power is first smoothed with an EMA (α = 0.3) before integration, to filter
sensor spikes rather than integrating raw noisy samples:

```
newEmaPower = emaPower === undefined
  ? power                                    // cold start: seed, no lag
  : 0.3 * power + 0.7 * prevEmaPower
```

The smoothed power is then integrated over the elapsed interval and
accumulated into a running total:

```
dtHours     = dtMs / 3_600_000
canIntegrate = !isPlugged && !isGap && 0 < dtHours < 0.5   // interval <30 min
deltaEnergy  = canIntegrate ? newEmaPower * dtHours : 0
energyKwh    = prevEnergyKwh + deltaEnergy
```

This is a **rectangular** integration on the EMA'd signal, not a trapezoidal
average of consecutive raw samples — the smoothing constant does similar work
but the two are mathematically different methods; don't describe this as
"trapezoidal power integration" in user-facing copy.

`energyKwh` is *net*: a negative `power` sample (regen) produces a negative
`deltaEnergy`, so heavy regen sections reduce the running total directly.

Regen is *also* tracked as its own, separately-thresholded quantity — it does
not simply mirror `energyKwh`'s negative contributions:

```
regenDelta = canIntegrate && power < -10 && speed > 5 ? |power| * dtHours : 0
regenKwh   = prevRegenKwh + regenDelta
```

The `power < -10 kW` (not `power < 0`) and `speed > 5 km/h` guards exist
specifically to filter BMS cell-balancing noise on Model Y, which otherwise
shows up as small negative power while parked/idle.

### Consumption (derived)

Not separately measured — computed on demand from the same running totals,
for a live/in-progress trip:

```
efficiencyWhkm = distanceKm > 0.1 && energyKwh > 0
  ? round((energyKwh * 1000 / distanceKm), 1 decimal)
  : null
efficiencyWhkm = efficiencyWhkm <= 600 ? efficiencyWhkm : null   // outlier guard, undocumented origin
```

`distanceKm` for a live trip is pure GPS (haversine over recorded points) —
not odometer; see [`trips.md`](trips.md) (pending) for the finalized-trip
distance calculation, which does have an odometer fallback.

Code: [`trip-builder.service.ts:257–277`](../../apps/api/src/trips/trip-builder.service.ts#L257-L277)

## Units

kWh (internal running total: `energyKwh`). Regenerated energy is tracked
separately as `regenKwh`, same unit. Consumption is Wh/km internally,
displayed as kWh/100km — see the unit-normalization rule in
[`README.md`](README.md).

## Fallbacks

There is **no SOC-delta fallback** for energy. If `power` is missing on a
tick, `data.power ?? 0` treats it as literally zero power for that interval —
not as "unknown, estimate some other way." See Edge cases below; this is a
real gap relative to the measured/estimated/unknown model in
[`README.md`](README.md), not an intentional fallback tier.

Distance (the other half of consumption) *does* have a real GPS→odometer
fallback — see [`trips.md`](trips.md#distance), not duplicated here.

## Data-quality rules

Every point gets a 0–1 confidence score before it's allowed to affect trip
state transitions:

```
speedConsistency = 1 - min(1, |speed - avgSpeedRecent| / max(avgSpeedRecent, 5)) * 0.5
signalScore      = (powerKnown ? 1 : 0 + gpsOk ? 1 : 0) / 2
gapPenalty       = dtMs > 60s ? 0.4 : dtMs > 30s ? 0.2 : dtMs > 15s ? 0.1 : 0
confidence       = clamp(speedConsistency*0.5 + signalScore*0.3 + 0.2 - gapPenalty, 0, 1)
```

- `< 0.3` → point hard-ignored for state transitions
- `0.3–0.6` → cache frozen (no state transition) but point still recorded
- `≥ 0.6` → normal processing

Critically, **this confidence score does not gate the energy integral
itself** — see Edge cases #1–2. It only gates whether a point can trigger a
trip state transition (e.g. DRIVING → STOPPED).

Code: [`trip-detector.service.ts:1908–1930`](../../apps/api/src/trips/trip-detector.service.ts#L1908-L1930)

## Confidence

Separately from the per-point score above, each trip gets an overall
**quality score** (0–100) that *is* meant to represent trustworthiness of
the trip's numbers as a whole:

```
score = 100
      - min(30, gapCount * 5)
      - min(20, floor(signalLossSec / 60) * 2)
      - min(30, round(interpolatedPointCount * 0.1))
label = score >= 80 ? HIGH : score >= 50 ? MEDIUM : LOW
```

Code: [`trip-builder.service.ts:281–299`](../../apps/api/src/trips/trip-builder.service.ts#L281-L299)

This is exactly the "confidence: HIGH/MEDIUM/LOW" concept the product wants
to show next to figures like energy/consumption — it already exists, but
**is not currently wired to any user-facing screen**. No frontend component
reads `computeQuality()`'s output today.

## Edge cases

1. **Missing power reads as zero, not "unknown."** `const power = data.power
   ?? 0` (`trip-detector.service.ts:148`) means a telemetry gap in the
   `power` signal silently contributes zero energy for that interval, rather
   than being excluded or flagged. `powerKnown` (`data.power != null &&
   data.power !== 0`) feeds into the confidence score, but confidence only
   gates *state transitions* — it does not gate whether the (zero) delta
   gets integrated into `energyKwh`.

2. **A hard-ignored point's energy delta can be inconsistently applied.**
   `this.tripBuilder.updateEnergy(vehicleId, energyKwh)` (line 391) fires
   *before* the confidence check (line 420+). When a point is then
   hard-ignored (confidence < 0.3, line 432–437), the function returns
   *without* calling `this.cache.set(...)` — so the state machine's own
   `prev.energyKwh` baseline for the *next* tick reverts to the pre-tick
   value, while `TripBuilder`'s stored total was already overwritten to
   include the discarded delta. `TripBuilder.updateEnergy` is a plain
   setter (`buf.energyKwh = energyKwh`, `trip-builder.service.ts:215-218`),
   so the next legitimate tick's `updateEnergy` call overwrites it again
   from the reverted (lower) baseline — meaning the hard-ignored delta is
   usually erased on the next tick, *unless* the trip finalizes in the
   narrow window between the two. Not verified to have caused a visible bad
   number in production; flagged here because it's a real inconsistency
   between two pieces of state that are supposed to track each other.

3. **No SOC-delta fallback exists.** If telemetry is too sparse for power
   integration to run at all for a whole trip (e.g. `power` never populated),
   `energyKwh` stays 0 rather than falling back to a coarser SOC × usable
   capacity estimate. Net effect: `efficiencyWhkm` comes back `null` (guarded
   by `distanceKm > 0.1 && energyKwh > 0`) rather than a low-confidence
   estimate — arguably the *safer* failure mode of the two, but it means
   trips with genuinely bad power telemetry show no consumption figure at
   all today, not an "estimated, low confidence" one.

## Algorithm version

Not tracked. There is no `energy-v1` / `energy-v2` tagging anywhere in the
schema or code — this document describes the only version that currently
exists. If this formula changes later (e.g. to fix edge cases #1–3 above),
there is currently no mechanism to distinguish trips computed under the old
vs. new logic, or to avoid silently changing historical numbers on redeploy.
This is the one gap that recurs identically across every metric spec in this
directory — see [`README.md`](README.md#formula-versioning).

## Tests

None currently. `apps/api/test/` has specs for `trip-post-processor`,
`trip-reconciler`, `trip-merge-params`, and `trip-backfill-rebuild`, but no
spec exercises the EMA/integration/confidence logic in
`trip-detector.service.ts` directly (it's a ~1900-line file with no
dedicated spec file at all). This is the actual highest-value next step
before changing this formula: characterize current behavior in tests first,
then any future formula change (fixing edge cases #1–3 above) has a
regression harness instead of relying on manual spot-checks.
