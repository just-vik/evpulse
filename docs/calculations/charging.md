# Charging: sessions, energy, cost, efficiency

Status: **as-built** — verified against `apps/api/src/charging/` on `main` @
`3aba43e`. See [`README.md`](README.md) for shared units/confidence/
versioning conventions.

## Definition

A charging session is one continuous period of energy flowing into the
battery, detected from a separate per-vehicle state machine
(`ChargingDetectorService`, analogous to but independent from
`TripDetectorService` in [`trips.md`](trips.md)). One session = one row in
`ChargingSession`.

## Tesla source

Fleet Telemetry streaming signals: `charging_state`, `power` (sign
convention: **negative when charging**, opposite of the trip/driving
`power` sign), `current`, `charge_energy_added` (cumulative kWh for the
current physical plug-in), `fast_charger_type`/`fast_charger_brand`,
`soc`, `speed`, GPS.

## Which Tesla states count as charging

```
terminalStates  = ['Complete', 'Disconnected', 'NoPower', 'Stopped']
meetsThreshold  = powerKw > 1.0 || currentA > 3 || isNegativePower
energyGrowing   = charge_energy_added strictly increasing vs. last known value
vehicleStopped  = medianSpeed(last 3) < 5 km/h

activeChargingState = state==='Charging'
                    || (state==='Complete' && (energyGrowing || meetsThreshold || isNegativePower))

inferredCharging = state not terminal
                 && power flowing into battery (rawPower < -1)
                 && powerKw > 20 && medianSpeed < 2
                 && state not in {Disconnected, NoPower, Stopped}

isActiveState = vehicleStopped && (activeChargingState || inferredCharging)
             && (energyGrowing || meetsThreshold)
```

`inferredCharging` exists because Fleet Telemetry can send a `power` batch
without `charging_state` in the same packet. It specifically requires
*negative* power (into the battery) to avoid misreading battery
preconditioning (heating the pack before a Supercharger stop, which draws
20–30 kW *from* the battery — positive power) as charging.

Code: [`charging-detector.service.ts:121-158`](../../apps/api/src/charging/charging-detector.service.ts#L121-L158)

## Current implementation

Runs per telemetry tick inside `ChargingDetectorService.checkChargingState`,
same "inline in the ingest path" shape as trip detection — no separate
batch job. Session start/end write directly to `ChargingSession`; energy
accumulates in an in-memory per-vehicle cache between ticks.

## Session start

Two additional mechanisms beyond the state check above:

- **Pending-charging debounce (BMS negotiation delay).** On slow home
  chargers, BMS negotiation can take 30–120s: Fleet Telemetry may report
  `charging_state='Charging'` in one batch and the actual power reading only
  in a later one. If `state==='Charging'` but power/energy don't yet confirm
  it, the detector remembers `pendingChargingAt`/`pendingChargingSoc`
  (5-minute window) so that when power *does* arrive and confirms the
  session, the session's recorded `startTime`/`startSoc` reflect the true
  start, not the moment power was confirmed.
- **GPS is only recorded if `medianSpeed < 5`** — avoids saving a session's
  start coordinates while the vehicle is still rolling to a stop.

Code: [`charging-detector.service.ts:160-229`](../../apps/api/src/charging/charging-detector.service.ts#L160-L229)

## Session end / pause tolerance

```
PAUSE_THRESHOLD_KW = 0.5   // power floor considered "dipped"
PAUSE_GRACE_MS     = 3 min
```

While `isCharging`, a power dip below the threshold does **not** end the
session immediately — it starts a grace timer. Within `PAUSE_GRACE_MS`, the
point is recorded and the session held open. Past the grace window, the
session still isn't ended if `charging_state==='Charging'` or energy is
still growing (sparse REST/MQTT batches commonly drop the power field for
minutes while the car keeps charging). Only a genuine terminal state or a
sustained real stop ends the session.

Code: [`charging-detector.service.ts:232-309`](../../apps/api/src/charging/charging-detector.service.ts#L232-L309)

## Minimum session duration / ghost-session rejection

Not a fixed "minimum duration" — a **multi-rule discard check** applied at
session end, to filter false positives (regen spikes, BMS flickers, stale
buffer replay, brief preconditioning bleed-through):

```
isGhost =
  roundedEnergyKwh < 0.05                                         // Rule A: <50 Wh, never real
  || (durationMs < 5min && socDelta < 0.5 && roundedEnergyKwh < 0.1) // Rule B: short + no real SOC rise
  || (socDelta < -1 && roundedEnergyKwh < 5)                       // Rule C: SOC dropped → not charging
```

A discarded ghost session is **deleted** from the DB (`chargingSession.delete`),
not marked/soft-rejected — there is no record that a ghost was ever detected
besides a log line.

Code: [`charging-detector.service.ts:493-515`](../../apps/api/src/charging/charging-detector.service.ts#L493-L515)

## Restart / recovery

Same pattern as trip detection: on a cold in-memory cache, checks the DB for
an open session (`ChargingSession.endTime IS NULL`). If found, seeds
`isCharging=true` and — importantly — computes `chargeEnergyAddedAtStart`
so the *baseline* for the energy-delta calculation accounts for energy
already recorded before the restart (`latestChargeEnergy -
alreadyRecordedEnergyAddedKwh`), preventing an undercount after a
mid-session process restart.

Code: [`charging-detector.service.ts:87-108`](../../apps/api/src/charging/charging-detector.service.ts#L87-L108)

## Energy: source selection

A real primary→fallback ladder, chosen at session end, not per-tick:

```
chargeEnergyDelta = latestChargeEnergyAdded - chargeEnergyAddedAtStart   // Tesla, charger-side cumulative

finalEnergy = (chargeEnergyDelta > 0 && chargeEnergyDelta > sessionEnergy * 0.5)
  ? chargeEnergyDelta     // primary: Tesla charger-side delta (persisted as source: tesla_api_delta)
  : sessionEnergy         // fallback: Σ(powerKw * Δt), capped at 6-min gaps per tick (source: power_integral)
```

The `> sessionEnergy * 0.5` sanity guard exists specifically to catch the
case where the charger stays physically connected across two logically
separate sessions — `charge_energy_added` is cumulative *since physical
plug-in*, not since our session start, so without this guard a
reconnect-without-unplug could carry over a stale, inflated delta.

**Gap in provenance**: which source won is logged (`source: tesla_api_delta`
vs `power_integral`) but **not persisted** on the `ChargingSession` row — no
`energySource` column exists, unlike `costSource` below which is stored.

Code: [`charging-detector.service.ts:294-309`](../../apps/api/src/charging/charging-detector.service.ts#L294-L309)

## Efficiency

```
theoreticalGainKwh = (ΔSOC / 100) × detectedCapacityKwh   // detectedCapacity from battery-health.md, fallback 72
efficiency = energyAddedKwh / theoreticalGainKwh
```

Only computed when `ΔSOC >= 2` and `energyAddedKwh > 0`. Result is discarded
(left `null`) unless it falls in `[0.70, 1.25]` — outside that range is
treated as bad SOC data or sensor noise, not a real efficiency reading.
**These bounds are heuristic**, chosen from typical AC home (0.90–0.96) and
DC fast (0.85–0.93) ranges per the inline comment, not derived from a cited
external source — treat them as "known reasonable," not "physically
universal."

Values `>1.0` are expected and normal for AC charging: `charge_energy_added`
is measured charger-side, so it includes AC→DC conversion losses (~5–15%)
that a battery-side theoretical gain doesn't account for. This is *not* a
true charger-meter-vs-battery-meter comparison (Tesla doesn't expose both
separately here) — it's energy-added-vs-theoretical-SOC-gain, which is a
different (still useful, but distinct) quantity.

Code: [`charging-detector.service.ts:517-534`](../../apps/api/src/charging/charging-detector.service.ts#L517-L534)

## Cost

Ladder, evaluated once per session at `calculateSessionCost`:

```
1. session.costSource in {'manual', 'tesla_api'} → skip entirely (authoritative, never overwritten)
2. Tesla Supercharger site match via GPS + catalog API (real market rate)   → costSource = 'supercharger_<provider>'
3. No site match, but explicit Tesla Supercharger charger type             → costSource = 'supercharger' (configured time-of-day rate)
4. High-power (>50kW) DC, non-Tesla-branded, or GPS/catalog unavailable    → costSource = 'tariff', rate = settings.thirdPartyRate ?? 0.45
5. Public AC (city/fast) or 3rd-party DC <50kW                             → costSource = 'tariff', rate = settings.thirdPartyRate ?? 0.45
6. Home/wall/AC-home (default bucket)                                      → costSource = 'tariff', rate = settings.homeChargingRate ?? 0.32

costTotal = round(costPerKwh × energyAddedKwh, 2 decimals)
currency  = 'EUR'   // hardcoded, not configurable
```

This is already the location-classification (home / Supercharger / public
DC / third-party) the product wants, and `costSource` **is** persisted per
session — this is more mature provenance-tracking than the energy ladder
above.

**Known, not-yet-fixed issues** (per your instruction: documented here, not
changed in this pass):
- `€0.32` / `€0.45` fallback rates are hardcoded constants, used whenever
  `settings.homeChargingRate` / `settings.thirdPartyRate` is unconfigured —
  there's no user-visible signal distinguishing "your actual configured
  rate" from "we guessed."
- `currency: 'EUR'` is a literal string — no multi-currency support at all,
  not even a schema field that's simply unused.

Code: [`charging-cost.service.ts:63-228`](../../apps/api/src/charging/charging-cost.service.ts#L63-L228)

## Units

kWh for energy, € (EUR only, see above) for cost, ratio (unitless, displayed
as %) for efficiency.

## Data-quality rules / Confidence

No numeric confidence score exists anywhere in charging (unlike trips/energy's
0–1 point score or battery health's 0–1 `confidenceScore`) — only the
categorical `costSource`/`chargerType` strings, and the ghost-session
boolean discard. See [`README.md`](README.md#confidence-model) — this is
one of the three concretely different confidence representations already
on record.

## Edge cases

1. **Energy source (Tesla vs. integral) isn't persisted** — see "Energy:
   source selection" above. Auditing why a specific session's energy figure
   looks off requires grepping logs by timestamp, not querying the DB.

2. **Ghost sessions are deleted, not flagged.** If the ghost-detection rules
   (Rule A/B/C above) ever have a false positive — a short, low-energy
   session that was actually real — there is no trace of it left to recover
   or even notice happened.

3. **Efficiency clamp bounds are unsourced heuristics.** `[0.70, 1.25]` is
   plausible but not backed by a cited reference; a legitimately unusual
   but real session (e.g. a very cold DC fast-charge with high losses) could
   fall outside it and silently lose its efficiency figure.

4. **Hardcoded currency and default rates** — see "Cost" above.

## Algorithm version

Not tracked — same gap as every other spec in this directory. See
[`README.md`](README.md#formula-versioning).

## Tests

None found for `ChargingDetectorService` or `ChargingCostService`
specifically (`apps/api/test/` has no `charging-*.spec.ts`). Given the
density of timing/threshold constants here (pending-charging 5min window,
pause grace 3min, three ghost-session rules, the `sessionEnergy*0.5` sanity
guard, the `[0.70,1.25]` efficiency clamp), this is the same
"characterize-before-you-touch" situation as `trip-detector.service.ts` in
[`trips.md`](trips.md#tests).
