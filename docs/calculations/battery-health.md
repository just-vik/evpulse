# Battery Health (State of Health / degradation)

Status: **as-built, two competing engines, canonical decision made but not
yet enforced in code.** Verified against `apps/api/src/battery/` on `main`
@ `ca7c230`. See [`README.md`](README.md) for shared units/confidence/
versioning conventions.

**This is EVPulse's own statistical estimate — it is not a read of Tesla's
internal BMS State-of-Health value.** Tesla does not expose a BMS SOH
signal via Fleet Telemetry/Fleet API; every number in this document is
calculated entirely from observed `(energy, ΔSOC)` pairs across charging
sessions, trips, and/or reported range. Any UI copy should say "estimated"
rather than imply this is Tesla's own figure.

## Canonical engine

**`BatteryAnalyticsService` is the canonical battery-health estimation
engine.** `BatteryHealthService` is **legacy/secondary** — kept temporarily
for comparison, not to be extended, and scheduled for removal once its
output is no longer needed as a cross-check.

Reasoning:
- `BatteryAnalyticsService` blends **three independent signals** (trip,
  charging, range) via weighted median, rather than relying on charging
  sessions alone.
- It carries method-level confidence (how many of the three signals
  agreed), a distinct concept from `BatteryHealthService`'s
  sample-count-based confidence.
- It has a real permanent-baseline-lock mechanism with its own statistical
  gate (`stdDev` threshold, not just a sample count).
- `BatteryHealthService` had a **P0 runtime bug** (fixed 2026-09-10, see
  Edge cases #1) that most likely made it silently non-functional in
  production for its entire lifetime prior to the fix — it has effectively
  no production track record to weigh against Engine B's.
- A live-data comparison (`scripts/compare-battery-health-engines.ts`,
  run against this instance's one vehicle after the P0 fix) showed both
  engines landing on the same displayed `100%` — but that agreement is an
  artifact of both engines' `min(100, ...)` cap, not evidence the
  underlying estimates match: Engine A's *raw* capacity before the cap was
  81.1 kWh against its resolved nominal, i.e. its raw SOH was **above**
  100% before clipping. With only one vehicle in this instance and no
  vehicle currently showing real (sub-100%) degradation, this decision is
  made on **architectural merits**, not on a statistically validated
  formula comparison — treat it as a considered engineering choice, not a
  scientific conclusion.

Migration status (not yet executed — documentation-only for now, per the
explicit decision not to refactor writers/schema in this pass):

```
Phase 1 (done):   both engines run, comparison script exists, one real
                   data point collected
Phase 2 (pending): BatteryAnalyticsService becomes the sole source the API
                   reads for user-facing SOH; BatteryHealthService keeps
                   writing for comparison only
Phase 3 (pending): BatteryHealthService's writes are disabled; it is
                   removed once Phase 2 has run long enough to trust
```

Today, in the actual code, **both services still write independently to
the same `BatteryHealth` table**, and `getBatteryHealth()` still reads
`findFirst({ orderBy: { timestamp: 'desc' } })` — this canonical-engine
decision is not yet enforced anywhere in code. See Edge cases #6.

## Definition

Estimated battery State of Health (SOH) — the vehicle's current usable
capacity as a percentage of its factory-nominal capacity.

## Engine B (canonical): `BatteryAnalyticsService`

### Inputs

- Trips: `trip.energyUsedKwh`, `trip.startSoc`/`endSoc`, filtered by the
  shared [`isValidTrip()`](range.md#data-quality-rules) gate — last 30 days
- Charging sessions: `energyAddedKwh`, `startSoc`/`endSoc`, `chargerType` —
  last 30 days
- Range observations: `telemetryPoint.batteryRangeKm`/`soc` (SOC 50–100%
  only) — last 90 days, up to 200 samples
- `vehicleSpec.batteryNominalKwh ?? vehicle.batteryCapacityNominal ?? 75`
- `vehicleSpec.rangeWltp` (fallback: `nominalKwh×1000/169`, i.e. assumes a
  Model Y LR EU consumption figure when spec data is missing)
- Most recent average battery temperature, effective charge cycle count

### Current implementation — triggers (verified, corrected from the earlier
pass's reliance on a stale source comment)

`updateBatteryMetrics(vehicleId)` runs:
- Automatically after every charging session ends
  ([`charging-detector.service.ts:345`](../../apps/api/src/charging/charging-detector.service.ts#L345))
- Automatically after every trip finalizes
  ([`trip-detector.service.ts:1467`](../../apps/api/src/trips/trip-detector.service.ts#L1467))
- Daily cron at **03:00 UTC**
- Manually via `POST /battery/:vehicleId/recalculate`

### Formula — three independent estimators, then a weighted median

**Method 1 — range-based** ("TeslaMate approach" per source comment):
```
rangeAt100 = median(batteryRangeKm / soc × 100) over last 90d, SOC 50-100%, >=5 samples
soh = rangeAt100 / wltpRangeKm × 100
bounds: [50, 130]%, else discarded
```

**Method 2 — charging-based:**
```
storedEnergy = energyAdded × dcChargingEfficiency   // constant = 1.0, currently a no-op
capacity = storedEnergy / (ΔSOC/100)
soh = capacity / nominalKwh × 100
filter: ΔSOC > 20% (sessions with ΔSOC<=20% explicitly skipped as "BMS buffer zone noise")
weight: 2.0 if endSOC>=90% else 1.0
bounds: [50, 110]% of nominal, >=2 samples
```

**Method 3 — trip-based:**
```
capacity = energyUsed / (ΔSOC/100)
soh = capacity / nominalKwh × 100
filter: ΔSOC > 20%, plus isValidTrip()
bounds: [50, 110]% of nominal, >=2 samples
```

**Blend:**
```
weighted median across whichever methods returned a result:
  range × 1.0, charging × 0.9, trip × 0.8

tempCorrectedSoh = rawSoh + (20 - avgTempC) × 0.004 × 100    // only if avgTempC < 20°C, else unchanged
                                                              // (linear — see Edge cases #2 for
                                                              //  the shape mismatch with Engine A)

if tempCorrectedSoh < 70: DISCARD ENTIRELY, log warning, no record written
finalSoh = clamp(tempCorrectedSoh, 70, 100)
confidence = min(1.0, methodsAgreeing / 3)
```

Code: [`battery-analytics.service.ts:281-381, 969-1123`](../../apps/api/src/battery/battery-analytics.service.ts#L281-L381)

### Baseline lock — a separate, permanent reference-capacity mechanism

Distinct from the per-update SOH blend above. Evaluated on every
`updateBatteryMetrics` call (`tryLockBaseline`), using its own capacity
estimate (`storedEnergy/(ΔSOC/100)`, `ΔSOC>=30%`, `startSOC<=60%`,
`chargerType`-based DC/AC split):

```
HIGH tier:   >=10 qualifying sessions, endSOC>=90%, stdDev < 2.5 kWh
MEDIUM tier: >=15 qualifying sessions, endSOC 70-90%, stdDev < 3.5 kWh
```

Once a tier locks, it's **permanent** (`vehicles.batteryBaselineHighKwh`/
`batteryBaselineMediumKwh`, written via raw `$executeRaw`) and becomes the
`usableKwh` reference for all future SOH calculations, overriding
`vehicleSpec`/`batteryCapacityDetected`. Its own confidence is categorical:
`HIGH`/`MEDIUM`/`NONE` — a **fifth** confidence representation, distinct
from the 0–1 `methodsAgreeing/3` score above, within this one service.

**This permanent-lock design doesn't distinguish "we're now confident in
the reference number" from "the battery has since genuinely degraded."**
A vehicle's real capacity declines over years; a baseline locked from its
first 10 near-full charges has no mechanism to ever update. This is a
real design tension flagged for the eventual `BatteryHealthResult`
contract redesign — not something to fix by editing constants now (see
"What's not changing yet" below).

Code: [`battery-analytics.service.ts:835-954`](../../apps/api/src/battery/battery-analytics.service.ts#L835-L954)

## Engine A (legacy/secondary): `BatteryHealthService`

Kept for comparison only — see Canonical engine above. Full detail
retained below since it's still live code and still writes to the same
table today.

### Inputs

Per charging session (from `ChargingSession`):
- `startSoc`, `endSoc` (%), `energyAddedKwh` (kWh), `startTime`

Per vehicle:
- `vehicleSpec.batteryNominalKwh` → fallback `vehicle.batteryCapacityNominal`

Code: [`battery-health.service.ts:74-96, 143-145`](../../apps/api/src/battery/battery-health.service.ts#L74-L96)

### Triggers (corrected — the source file's own docstring is wrong here,
see Edge cases #5)

- `estimateCapacityFromCharging(vehicleId)` (last 50 sessions) — **only**
  called from the manual `/recalculate` endpoint.
- `backfillCapacityFromHistory(vehicleId, since?)` (all sessions) — daily
  cron at **03:30 UTC** (offset 30min after Engine B's 03:00 cron
  specifically so the two heavy scans don't overlap), and on-demand.

Neither is triggered by a charging session or trip completing — despite
`estimateCapacityFromCharging`'s own docstring claiming "Called by
BatteryAnalyticsService.updateBatteryMetrics() after each session." That
claim is false; `updateBatteryMetrics` never calls into this service at
all (verified by reading `updateBatteryMetrics` in full — it only calls
its own three estimators).

### Formula

Per qualifying session:
```
capacityKwh = energyAddedKwh / (ΔSOC / 100)
```
Temperature-corrected (piecewise, see below), bounds `[20,120]` kWh,
aggregated via **weighted median** (weight = that session's `ΔSOC`):
```
sohPercent         = min(100, medianCap / nominalCap × 100)
degradationPercent = max(0, (1 - medianCap / nominalCap) × 100)
```
Code: [`battery-health.service.ts:164-226`](../../apps/api/src/battery/battery-health.service.ts#L164-L226)

### Temperature correction — piecewise, non-linear

```
factor(tempC) =
  tempC >= 20   → 1.000
  tempC >= 10   → 1.000 - (20-tempC) * 0.004
  tempC >= 0    → 0.960 - (10-tempC) * 0.007
  tempC >= -10  → 0.890 - (0-tempC)  * 0.010
  tempC < -10   → 0.790
correctedCapacity = rawCapacity / factor(tempC)
```
Cited as "empirical fit to published Tesla Model Y capacity-vs-temperature
curves," applied uniformly to every model. Sessions with no nearby
temperature reading are used **uncorrected**, not excluded.

Code: [`battery-health.service.ts:472-493`](../../apps/api/src/battery/battery-health.service.ts#L472-L493)

### Fallbacks — quality filter ("the TezLab method")

```
isQuality session: ΔSOC >= 25% AND endSoc >= 90%
usedSamples = qualitySamples.length >= 3 ? qualitySamples : allSamples
method = qualitySamples.length >= 3 ? 'charging_quality' : 'charging_simple'
```

### Confidence

```
n = samples used
confidence = quality method:  min(0.95, 0.50 + (n/10) * 0.45)
             fallback method: min(0.70, 0.30 + (n/15) * 0.40)
```

## `sampleCount` means two different things between the two engines

- Engine A: `sampleCount` = number of **charging sessions** used.
- Engine B: `sampleCount`/`validMethods.length` = number of **estimation
  methods** (out of 3: range/charging/trip) that agreed, regardless of how
  many sessions or trips backed each one.

A UI or API consumer treating these as the same field would silently
compare apples to oranges. This must be resolved by naming (e.g.
`observationCount` vs `methodCount`) before any unified `BatteryHealth`
contract is built — not by picking one meaning and hoping the other
adapts.

## Units

kWh for capacity, % for SOH/degradation — see [`README.md`](README.md#units).

## Confidence models catalogued so far (battery health alone has three)

1. Engine A: 0.30–0.70 (fallback) / 0.50–0.95 (quality), scaled by session count.
2. Engine B (SOH blend): `methodsAgreeing/3` — 0.33/0.67/1.00, not scaled by
   sample depth within a method at all.
3. Engine B (baseline lock): categorical `HIGH`/`MEDIUM`/`NONE`.

Combined with trips/energy, charging, and range's own formulas (see
[`README.md`](README.md#confidence-model)), battery health alone
contributes 3 of what is now at least 6 independently-authored confidence
representations in the codebase.

## Edge cases

1. **[FIXED 2026-09-10] Engine A had a P0 runtime bug.**
   `estimateCapacityFromCharging`/`backfillCapacityFromHistory` filtered
   the non-nullable `ChargingSession.startSoc` column with `{ not: null }`,
   which Prisma 5.x rejects at runtime ("Argument `not` must not be null")
   regardless of TypeScript passing it through untyped. Every call site
   swallowed the error via `.catch()`, so this service most likely never
   successfully produced a result in production before the fix. See commit
   `ca7c230`.

2. **Temperature correction shape mismatch between the two engines.**
   Engine A: piecewise, non-linear, steepens below 0°C, Model-Y-derived.
   Engine B: linear, `+0.4%/°C` below a 20°C reference, no documented
   source. Same physical effect, two different curves, never reconciled
   against each other or real data.

3. **`min(100, ...)` caps hide real disagreement.** Confirmed empirically,
   not just theoretically: running the live comparison script post-fix
   showed Engine A's raw capacity (81.1 kWh) resolving to a raw SOH above
   100% before clipping, while the *displayed* number for both engines was
   identically `100%`. The cap is reasonable as a *display* rule but
   currently destroys the raw value — there is no `rawSohPercent` field
   anywhere to recover what was actually computed.

4. **`sampleCount` means different things between engines** — see above.

5. **A stale docstring asserted a trigger relationship that was never
   true.** `battery-health.service.ts`'s own comment claimed Engine A was
   "called by BatteryAnalyticsService.updateBatteryMetrics() after each
   session" — false on inspection of the actual `updateBatteryMetrics`
   body. Worth noting as a general caution: comments describing
   *cross-service* call relationships are exactly the kind that silently
   rot, since neither service's own test (if either had one) would catch
   the other's docstring going stale.

6. **Both engines still write to the same `BatteryHealth` table today** —
   the canonical-engine decision above is documentation-only so far, not
   yet enforced in code. `getBatteryHealth()` still reads
   `findFirst({ orderBy: { timestamp: 'desc' } })` with no awareness of
   which engine produced a given row.

7. **Factory-spec (`batteryNominalKwh`) coverage is unverified** across
   both engines — bounded by how complete that table actually is across
   trims/years, not audited in this pass.

8. **Baseline lock is permanent, with no recalibration path** — see "What's
   not changing yet" and the Baseline lock section above.

## Algorithm version

Not tracked in either engine — see [`README.md`](README.md#formula-versioning).

## What's not changing yet (explicit, per current instruction)

Not touched in this pass: temperature curve (either engine's), SOH method
weights, the permanent baseline-lock design, confidence formulas, the
Prisma schema, or removing Engine A's code. Only the P0 crash was fixed —
everything else above is documented for a later, deliberate redesign
(raw-value preservation, provenance contract, single canonical writer).

## Tests

None for either engine's calculation logic
(`apps/api/test/` has no `battery-health*.spec.ts` or
`battery-analytics*.spec.ts`). `apps/api/scripts/compare-battery-health-engines.ts`
exists as a **read-only comparison tool**, not a test — it exercises both
engines' real public methods against live data with writes intercepted, to
support the canonical-engine decision above, not to run in CI.
