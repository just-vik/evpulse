# Battery Health (State of Health / degradation)

Status: **as-built** — verified against
`apps/api/src/battery/battery-health.service.ts` on `main` @ `ccca855`. See
[`README.md`](README.md) for shared units/confidence/versioning conventions.

**This is EVPulse's own statistical estimate, derived from charging
sessions — it is not a read of Tesla's internal BMS State-of-Health value.**
Tesla does not expose a BMS SOH signal via Fleet Telemetry/Fleet API; this
number is calculated entirely from observed `(energyAdded, ΔSOC)` pairs
across charging sessions. Any UI copy should say "estimated" rather than
imply this is Tesla's own figure.

## Definition

Estimated battery State of Health (SOH) — the vehicle's current usable
capacity as a percentage of its factory-nominal capacity — derived from a
weighted median of per-charging-session capacity estimates, temperature-
corrected and quality-filtered.

## Inputs

Per charging session (from `ChargingSession`, only sessions with all four
fields non-null are considered):
- `startSoc`, `endSoc` (%)
- `energyAddedKwh` (kWh) — see [`charging.md`](charging.md#energy-source-selection)
  for how this value itself was derived; battery health inherits whatever
  uncertainty exists there.
- `startTime` (used to locate a nearby battery-temperature reading)

Per vehicle:
- `vehicleSpec.batteryNominalKwh` (factory-spec table) → fallback
  `vehicle.batteryCapacityNominal` (per-vehicle field)

Code: [`battery-health.service.ts:74-96, 143-145`](../../apps/api/src/battery/battery-health.service.ts#L74-L96)

## Tesla source

Not a direct signal — built from the same `charge_energy_added`/`soc`
telemetry that also feeds [`charging.md`](charging.md), plus
`telemetry_points.batteryTemp` looked up separately (see Data-quality rules).

## Current implementation

Two entry points, both funnel into the same `_computeAndPersistCapacity`:
- `estimateCapacityFromCharging(vehicleId)` — last 50 sessions, called by
  `BatteryAnalyticsService.updateBatteryMetrics()` **after every charging
  session** (event-driven, not polled).
- `backfillCapacityFromHistory(vehicleId, since?)` — **all** historical
  sessions (no limit), run by a daily cron at **03:30 UTC** (offset 30min
  after `BatteryAnalyticsService`'s own 03:00 cron specifically so the two
  heavy scans don't overlap) and on-demand (e.g. after a manual tariff
  backfill).

Nominal capacity is **not** a single hardcoded "Model Y = 75 kWh" — it's a
per-vehicle lookup: `vehicle.vehicleSpec?.batteryNominalKwh ??
vehicle.batteryCapacityNominal`, i.e. a factory-spec table keyed by
model/trim/year, with a per-vehicle-record fallback. The accuracy of this
whole calculation is bounded by how complete that factory-spec table
actually is — not independently verified in this pass (see Edge cases).

Code: [`battery-health.service.ts:133-145`](../../apps/api/src/battery/battery-health.service.ts#L133-L145)

## Formula

Per qualifying session:

```
capacityKwh = energyAddedKwh / (ΔSOC / 100)      // ΔSOC = endSoc - startSoc
```

Then, per session, a temperature correction (see below) normalizes to a
20°C reference, and physical bounds reject implausible readings
(`20 <= correctedCapacity <= 120` kWh — "covers all Tesla models" per the
inline comment, i.e. not model-specific bounds).

Aggregation across qualifying sessions is a **weighted median**, weight =
that session's `ΔSOC`:

```
sort samples by capacity ascending
totalWeight = Σ weight
walk sorted samples accumulating weight; medianCap = capacity at the
  sample where cumulative weight first reaches totalWeight/2
```

Weighting by `ΔSOC` means a session with a bigger SOC swing (more signal,
less relative BMS measurement noise) counts for more in the median — not a
plain count-based median.

```
sohPercent         = min(100, medianCap / nominalCap × 100)   // capped: >100 = noise, not a super-battery
degradationPercent = max(0, (1 - medianCap / nominalCap) × 100)
```

Code: [`battery-health.service.ts:164-226`](../../apps/api/src/battery/battery-health.service.ts#L164-L226)

## Temperature correction

```
factor(tempC) =
  tempC >= 20   → 1.000
  tempC >= 10   → 1.000 - (20-tempC) * 0.004     // -0.40%/°C
  tempC >= 0    → 0.960 - (10-tempC) * 0.007     // -0.70%/°C
  tempC >= -10  → 0.890 - (0-tempC)  * 0.010     // -1.00%/°C
  tempC < -10   → 0.790                          // floor, not extrapolated

correctedCapacity = rawCapacity / factor(tempC)
```

Applied when a nearby battery-temperature reading exists; **sessions with no
temperature reading are used uncorrected** ("benefit of the doubt" per
source comment), not excluded.

The source comment cites this as "empirical fit to published Tesla Model Y
capacity-vs-temperature curves" — **it is applied uniformly to every
vehicle model** processed by this service, not just Model Y. Whether Model
3/S/X share a close-enough curve is not verified anywhere in the code or
this audit.

Code: [`battery-health.service.ts:472-493`](../../apps/api/src/battery/battery-health.service.ts#L472-L493)

## Fallbacks

Two-tier quality filter (the docstring calls this "the TezLab method"):

```
isQuality session: ΔSOC >= 25% AND endSoc >= 90%   // near-full charges, less BMS noise

usedSamples = qualitySamples.length >= MIN_QUALITY_SESSIONS (3)
  ? qualitySamples        // method: 'charging_quality'
  : allSamples            // method: 'charging_simple' — fallback so new users get an estimate quickly
```

`nominalCap` itself also has a fallback tier: factory-spec table → per-vehicle
field (see Current implementation above) — no further fallback exists if
both are missing (method returns `null` rather than guessing a number).

Code: [`battery-health.service.ts:193-207`](../../apps/api/src/battery/battery-health.service.ts#L193-L207)

## Units

kWh for capacity (`estimatedCapacityKwh`, `nominalCapacityKwh`), % for
`sohPercent`/`degradationPercent`/`chargingSoh`.

## Data-quality rules

- **Cold-temperature exclusion**: sessions with `batteryTemp < 5°C` are
  dropped entirely (not corrected) — cold BMS artificially limits accessible
  capacity in a way the linear correction above isn't trusted to compensate
  for reliably at the low end.
- **Physical bounds**: any single session's (corrected) capacity outside
  `[20, 120]` kWh is discarded as noise before it reaches the median.
- **Temperature lookup**: nearest `telemetry_points.batteryTemp` within
  `[sessionStart-15min, sessionStart+10min]`, selected via raw SQL
  (`$queryRawUnsafe` with session IDs string-interpolated directly into the
  query). The IDs are Prisma-generated `cuid`s from the service's own prior
  DB query, not user input, so this isn't an injection path in practice —
  noted because raw-SQL string interpolation is normally something to
  scrutinize on sight, not because there's an actual exploitable gap here.

Code: [`battery-health.service.ts:431-454`](../../apps/api/src/battery/battery-health.service.ts#L431-L454)

## Confidence

**A 0–1 `confidenceScore`, persisted per estimate — a different scale and
meaning than the trip/energy confidence in [`energy.md`](energy.md) or the
categorical `costSource` strings in [`charging.md`](charging.md). Not
unified across metrics; see [`README.md`](README.md#confidence-model).**

```
n = number of samples actually used
confidence =
  quality method:  min(0.95, 0.50 + (n/10)  * 0.45)   // → 0.95 at n>=10
  fallback method: min(0.70, 0.30 + (n/15)  * 0.40)   // → 0.70 at n>=15, capped below quality-method's floor
```

The fallback method's confidence ceiling (0.70) is deliberately below the
quality method's floor (0.50) at low `n` only asymptotically — at `n=1`,
fallback gives `0.30+0.027≈0.33` vs. quality's `0.50+0.045≈0.545` — so a
`charging_simple` estimate never claims to be as trustworthy as even a
small `charging_quality` batch, by construction of the two formulas rather
than an explicit cross-check between them.

Persisted alongside: `method` (`'charging_quality'`/`'charging_simple'`),
`sampleCount`, `nominalCapacityKwh`, `estimatedCapacityKwh` — this is
already close to the "Battery Health 94%, Confidence: HIGH, Observations:
183" product concept; it just isn't labeled HIGH/MEDIUM/LOW anywhere, only
the raw 0–1 float.

Code: [`battery-health.service.ts:228-251`](../../apps/api/src/battery/battery-health.service.ts#L228-L251)

## Edge cases

1. **Factory-spec (`batteryNominalKwh`) coverage is unverified.** The
   *formula* correctly avoids a single hardcoded per-model number, but the
   accuracy of every SOH estimate is bounded by how complete/accurate that
   spec table actually is across trims/years — not audited in this pass.

2. **Temperature curve is Model-Y-derived, applied to all models** — see
   Temperature correction above.

3. **`>100%` capped, not investigated.** `sohPercent = min(100, ...)` treats
   any reading above nominal as pure measurement noise. This is a reasonable
   default, but means a vehicle with genuinely better-than-rated capacity
   (unlikely, but not physically impossible immediately post-manufacture)
   would be silently clipped with no record of the raw value.

4. **No SOC-jump or session-authenticity cross-check** with the ghost-session
   rules in [`charging.md`](charging.md#minimum-session-duration--ghost-session-rejection)
   — a session that passed the charging detector's ghost filter but still
   has slightly-off SOC/energy values (e.g. from a brief BMS glitch) has no
   additional filter here beyond the `ΔSOC<=0`/`energy<=0`/bounds checks
   already covered above.

## Algorithm version

Not tracked — same gap as every other spec in this directory. See
[`README.md`](README.md#formula-versioning). Given this is the most mature
calculation audited so far, it's also the one where a future formula change
(e.g. revising the temperature curve per-model) would most benefit from
versioning existing first — changing `batteryTempCapacityFactor` today
would silently shift every vehicle's historical SOH trend on next backfill.

## Tests

None found (`apps/api/test/` has no `battery-health*.spec.ts`). Given this
calculation already has the most internal structure (quality filter,
temperature correction, weighted median, dual confidence formulas) of
anything audited so far, it's a strong candidate for characterization tests
before revisiting edge cases #1–3.
