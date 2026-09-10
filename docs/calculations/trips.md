# Trip Detection

Status: **as-built** — describes what the code does today, verified against
`apps/api/src/trips/trip-detector.service.ts` (~1900 lines) and
`trip-builder.service.ts` on `main` @ `70fd0d4`. See [`README.md`](README.md)
for shared units/confidence/versioning conventions, and
[`energy.md`](energy.md) for the energy/consumption formulas that run
inside this same state machine.

**Read this before trusting any inline code comment in `trip-detector.service.ts`
about timing constants** — two were found to be stale during this audit (see
Edge cases #1). This doc's numbers come from the actual constructor defaults,
not the comments next to where they're used.

## Definition

A trip is one continuous **Drive/Reverse → Park** session (Tesla
`shift_state`), detected from a live per-vehicle state machine — not a
batch job. One trip = one row in `Trip`, built incrementally in memory
(`TripBuilder`) and only written to the DB at start/finalize.

## State machine

Three states, defined in [`trip-state.enum.ts`](../../apps/api/src/trips/trip-state.enum.ts):

```
IDLE ──(fastStart | shiftDriving | speed>5 & dwell)──▶ DRIVING
DRIVING ──(soft stop, hysteresis 20/30/45s)──▶ STOPPING
DRIVING ──(shift=P, or charger detected, or DC fast-charge power>30kW)──▶ finalize ──▶ IDLE
STOPPING ──(resume: smoothSpeed>4 & shift D/R/null)──▶ DRIVING
STOPPING ──(park confirmed | plugged | timed out | paused-at-same-spot)──▶ finalize ──▶ IDLE
```

There is no separate "FINALIZING" or "COMPLETED" state — finalization
(`finalizeTripToDb`) is an action taken *during* the DRIVING→IDLE or
STOPPING→IDLE transition, not a state of its own.

Code: [`trip-detector.service.ts:475-868`](../../apps/api/src/trips/trip-detector.service.ts#L475-L868)

## Trip start (IDLE → DRIVING)

Three independent trigger conditions, any one of which starts a trip
(gated by `!isPlugged && !inCooldown`):

- **`fastStart`**: `smoothSpeed > 8` and the last 2 speed samples were both `> 5`
- **`shiftDriving`**: `shift_state` is `D`/`R` and `smoothSpeed > 5`
- **Adaptive dwell**: `smoothSpeed > 5` sustained for a speed-dependent dwell
  window — `5s` if `speed>15`, `10s` if `speed>10`, else `20s`

The `smoothSpeed > 5` (not `> 2`) floor is a deliberate fix: the lower
threshold produced "ghost trips" from brief D→P reversing/parking manoeuvres
at 2–3 km/h with no dwell.

`startSoc` falls back to the last known SOC in history (`prev.socHistory`)
if the triggering point itself has null SOC — deliberately not defaulted to
`0`, since Fleet Telemetry fields arrive at different rates and a `0`
default would corrupt the trip's energy baseline.

Code: [`trip-detector.service.ts:478-568`](../../apps/api/src/trips/trip-detector.service.ts#L478-L568)

## Trip end

Two distinct paths, both call `finalizeTripToDb`:

**Immediate, from DRIVING** (bypasses the stop hysteresis entirely):
- `isPlugged && isStopped` — charging confirmed while stationary
- `smoothSpeed < 2 && power > 30` — DC fast-charge power signature, even if
  `charging_state` hasn't updated yet (belt-and-suspenders vs. the event engine)
- `shift === 'P' && speed < 5` — explicit park

**Via STOPPING, after hysteresis:**
1. DRIVING → STOPPING requires `isStopped` (`smoothSpeed<2 && |smoothPower|<3 &&
   !highVariance`) sustained for an adaptive window: `45s` if 5-min avg speed
   `>70`, `30s` if `>40`, else `20s`.
2. STOPPING → finalize fires on: `shift==='P'` (`parkConfirmed`), OR `isPlugged`,
   OR a timeout (`idleMs > stopTimeoutMs`: **240s city / 480s highway** by
   constructor default — see Edge cases #1 for why the inline comments say
   otherwise), OR "paused at the same spot" (`pausedAtPoint`: within 0.30 km of
   the stop point for ≥180s city / ≥300s highway — catches multi-stop errands
   without a full timeout wait).
3. On a timeout-based end (not park/plug), `endTime` is backdated to
   `idleSince` so parked time doesn't inflate trip duration.

Code: [`trip-detector.service.ts:640-868`](../../apps/api/src/trips/trip-detector.service.ts#L640-L868)

## Tesla source

- `shift_state`, `speed`, `power`, `latitude`/`longitude`, `odometer`,
  `charging_state`, `charge_energy_added` — all Fleet Telemetry streaming
  signals, consumed per-tick.
- No REST/`vehicle_data` polling path feeds this state machine directly.

## Valid telemetry points / gap handling

Gap threshold is **dynamic**, not a fixed timeout — it self-calibrates to
whichever ingest path is currently active (Fleet Telemetry streaming ≈10s
vs. REST polling 60–300s):

```
dynamicGapMs = clamp(
  max(60_000, median(last 10 intervals) * 2.5, lastInterval * 1.2),
  upper bound: FORCE_END_GAP_MS / 3
)
isGap     = dtMs > dynamicGapMs
isMidGap  = dynamicGapMs < dtMs < FORCE_END_GAP_MS   // hold state, don't end
isLongGap = dtMs >= FORCE_END_GAP_MS                  // force-end (SIGNAL_LOSS)
```

`FORCE_END_GAP_MS` defaults to **6 minutes** (`6 * 60_000`,
`trip-detector.service.ts:96`, overridable via `TRIP_FORCE_END_GAP_MS`).

During a mid-gap, the point is still recorded into the trip buffer (for GPS
continuity and correct end-of-gap state) but state transitions are frozen.

Code: [`trip-detector.service.ts:196-245`](../../apps/api/src/trips/trip-detector.service.ts#L196-L245)

## GPS jump / teleport filtering

While DRIVING, an incoming GPS fix is nulled out (point still recorded, just
without coordinates) if, versus the previous point:

```
isTeleport = distKm > 0.3 && dtMs < 5000
nulled if impliedSpeedKmh > 200 || isTeleport
```

Only applied while moving (`speed >= 2`) — a parked car receiving a stale
REST-poll GPS fix from a different location must not be nulled by this check.

Code: [`trip-detector.service.ts:600-619`](../../apps/api/src/trips/trip-detector.service.ts#L600-L619)

## Distance

- **Live/in-progress trip**: pure GPS haversine over recorded points.
  See [`energy.md`](energy.md#formula).
- **Finalized trip**: GPS haversine by default; replaced by the odometer
  delta only when GPS significantly underestimates it —
  `gpsDistanceKm < max(0.3, odometerDeltaKm × 0.75)`. If the finalizing
  telemetry point itself lacks an odometer reading, the nearest
  `telemetryPoint.odometer` within a ±2min/+30s window around trip end is
  used instead.

Code: [`trip-detector.service.ts:1040-1071`](../../apps/api/src/trips/trip-detector.service.ts#L1040-L1071)

## SOC jumps

No explicit "SOC jump" detector/rejection exists in this file. SOC is used
as: (a) `startSoc` at trip start (with the last-known-value fallback
described above), (b) `socAtStop` captured at the stop-hysteresis point, and
(c) a 2-sample smoothing history (`socHistory`) used only to feed the
per-point confidence score, not to validate physical plausibility of a jump
(e.g. SOC dropping 20% in 10 seconds is not specifically flagged or
rejected). This is a real gap relative to a validated-pipeline model — see
Edge cases #2.

## Merge / split

Handled by a **separate service**, not `trip-detector.service.ts`:
`TripReconcilerService` / `trip-merge-params.ts` merge two adjacent trip
rows when the gap between them is short and they're geographically close:

```
maxGapMs      = 10 min default (TRIP_RECONCILE_MAX_GAP_MS, floor 120s)
maxProximityKm = 2 km default (TRIP_RECONCILE_MAX_PROXIMITY_KM)
```

The 10-minute default's own code comment justifies it as "aligns with
`FORCE_END_GAP_MS`" — see Edge cases #1: that's no longer true today
(`FORCE_END_GAP_MS` is 6 min, not 10). Supercharger stops (20–45 min) are
deliberately *not* covered by this gap window; they're excluded from
merging via a separate `hasChargingBetween` check rather than the gap
threshold.

Code: [`trip-merge-params.ts:31-51`](../../apps/api/src/trips/trip-merge-params.ts#L31-L51)

Full merge mechanics (reconciler pass logic, `trip-cleanup.service.ts`'s
2-day auto-merge window) are out of scope for this doc pass — flagged for a
follow-up, not fabricated here.

## Restart / recovery

On process restart, the in-memory per-vehicle `cache` is empty. Recovery
order on the next telemetry point:

1. Try to restore a persisted detector-state snapshot from Redis.
2. Else, check the DB for an open trip (`Trip.endTime IS NULL`) for this
   vehicle. If found, restore `TripBuilder` from that row and seed
   `tripState = DRIVING`, with `lastTime` set to the trip's original
   `startTime` — not `now` — specifically so gap-detection can still fire
   correctly on the very next point (a `dtMs=0` would otherwise suppress
   the long-gap force-end check).
3. Else, start fresh at `IDLE`.

Code: [`trip-detector.service.ts:165-188`](../../apps/api/src/trips/trip-detector.service.ts#L165-L188)

## Data-quality rules / Confidence

Covered in [`energy.md`](energy.md#data-quality-rules) — both the per-point
0–1 confidence score and the per-trip 0–100 quality score
(`TripBuilder.computeQuality`) apply to trips as a whole, not just to the
energy figure. Not duplicated here.

One trip-specific quality signal not in `energy.md`: **speed variance**
gates the stop detector. `isStopped` requires `!highVariance`
(`variance(last 5 speed samples) <= 25`, i.e. std-dev `<= 5 km/h`) — this
exists specifically so noisy speed readings hovering between 0–10 km/h
don't get misread as a genuine stop.

## Authoritative vs. fallback (summary)

| Signal | Authoritative | Fallback | Fallback trigger |
|---|---|---|---|
| Trip start SOC | current point's `soc` | last known SOC in history | current point's SOC is null |
| Distance (final) | GPS haversine | odometer delta | GPS underestimates by >25% vs. odometer |
| Gap classification | dynamic (self-calibrating) | fixed 60s floor | fewer than 3 observed intervals so far |
| Energy | power integral | *(none)* | see [`energy.md`](energy.md#fallbacks) |

## Edge cases

1. **Two inline comments describe stale timing values — verified
   discrepancies, not just style nits.**
   - The STOPPING-timeout comment (`trip-detector.service.ts:781-786`) says
     "Highway → 10 min" / "City → 5 min", but the actual constructor
     defaults are `STOP_TIMEOUT_HIGHWAY_MS = 480_000` (8 min) and
     `STOP_TIMEOUT_CITY_MS = 240_000` (4 min) (`trip-detector.service.ts:89-90`).
   - The gap-classification comment (`trip-detector.service.ts:232`) says
     `FORCE_END_GAP_MS` defaults to "10 min", but the actual default is
     `6 * 60_000` = 6 min (`trip-detector.service.ts:96`).
   - This second one has a real downstream consequence: `trip-merge-params.ts`'s
     10-minute reconciler gap default justifies itself in its own comment as
     "aligns with FORCE_END_GAP_MS" (i.e. assumes signal-loss splits produce
     ~10-minute gaps that the reconciler then heals) — but the actual
     force-end trigger fires at 6 minutes, not 10. Whether this causes any
     currently-visible under- or over-merging has **not** been verified in
     this pass; it's flagged here as a confirmed numeric mismatch between two
     independently-configured constants that a comment claims are aligned.

2. **No SOC-jump validation.** An implausible SOC change between consecutive
   points (sensor glitch, or a genuine fast top-off the detector doesn't
   know about) is not detected or flagged anywhere in this file — it just
   flows into `startSoc`/`socAtStop`/`socHistory` as-is.

3. **Merge/split logic lives in a different file than detection**, and
   wasn't fully audited in this pass (see "Merge / split" above) — the
   10-minute-vs-6-minute mismatch in #1 is the one concrete finding from a
   partial read; a full audit of `trip-reconciler.service.ts` and
   `trip-cleanup.service.ts` is a separate follow-up.

## Algorithm version

Not tracked — same gap as every other spec in this directory. See
[`README.md`](README.md#formula-versioning).

## Tests

None. Confirmed in [`energy.md`](energy.md#tests) already: `trip-detector.service.ts`
has no dedicated spec file. Given the density of timing constants and edge
cases documented above (three independent start triggers, two independent
end paths, adaptive hysteresis windows, dynamic gap calibration), this file
is the single highest-value target in the whole calculation layer for
characterization tests before any of edge cases #1–2 are touched.
