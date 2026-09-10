# Costs (charging, trip, cost/km, monthly, TCO, fleet)

Status: **mixed** — this spec covers a *chain* of cost concepts, not one
formula. Some levels are real and working; several don't exist. Verified
against `apps/api/src` on `main` @ `856ffc8`. See [`README.md`](README.md)
for shared conventions.

## Status by level

| Level | Status | Where |
|---|---|---|
| Charging cost (per session) | **Implemented** | `charging-cost.service.ts` — see [`charging.md`](charging.md#cost) |
| Trip cost (per trip) | **Implemented, but a different concept than it sounds** | `trip-detector.service.ts`, `trip-gap-recovery.service.ts` |
| Energy cost (30-day rollup) | **Implemented** | `vehicle-analytics.service.ts` |
| Cost per km | **Implemented, coarse (period ratio, not per-trip)** | `vehicle-analytics.service.ts` |
| Monthly/weekly cost forecast | **Implemented** | `cost-forecast.service.ts` |
| TCO (energy+maintenance+insurance+depreciation) | **NOT IMPLEMENTED** | — |
| Fleet economics | **NOT IMPLEMENTED** | — (no fleet module exists at all, confirmed during the earlier metric-inventory pass) |

## The central finding: five independent tariff calculations, four different hardcoded defaults

This is the most consequential thing found while writing this spec. Cost
appears in five separate places in the codebase, **each with its own
tariff-resolution logic**, none calling into a shared source of truth:

| Implementation | Fallback chain | Hardcoded default |
|---|---|---|
| `ChargingCostService` (the real per-session engine, [`charging.md`](charging.md#cost)) | Supercharger catalog API → configured ToD rate → `thirdPartyRate`/`homeChargingRate` | `0.45` (public) / `0.32` (home) |
| `VehicleAnalyticsService.getCostSummary` | persisted `session.costTotal`/`cost` → charger-type-keyword-matched `homeRate`/`pricePerKwh` | `pricePerKwh` param default `0.25` |
| `CostForecastService.resolveRate` | weighted avg of ≥3 sessions with known `costTotal` → `homeChargingRate`/`chargingCost` setting | `0.25` |
| `TripDetectorService` (trip finalize, `costTotal` field) | `homeChargingRate` → `chargingCost` setting | `0.25` |
| `TripGapRecoveryService` (recovered trips) | `homeChargingRate` setting only | `0.35` |

Four different default rates (`0.25`, `0.32`, `0.35`, `0.45`) for
conceptually the same "I don't know your real rate" fallback, authored
independently across five files. None of this is presented to the user as
inconsistent today because each number only ever shows up in its own
context — but a user comparing "cost per km" (from `VehicleAnalyticsService`,
defaults to €0.25/kWh when uninformed) against a specific trip's `costTotal`
(defaults to €0.25 too, but via a different code path with different
settings-field priority) against their actual charging history
(`ChargingCostService`, defaults to €0.32/€0.45) could see numbers that
don't reconcile, without any single formula being "wrong."

## Charging cost (per session)

Fully documented in [`charging.md`](charging.md#cost). This is the most
mature of the five — real Supercharger catalog API pricing, `costSource`
persisted, location-aware. Not repeated here.

## Trip cost — a different concept than "what you paid to charge"

`Trip.costTotal` ("€ cost of energy used") is **not** derived from what was
actually paid for the electricity that trip consumed. It's a notional
figure: this trip's own [`energy.md`](energy.md) consumption, priced at a
flat configured/default rate:

```
rateEurKwh = settings.homeChargingRate
          ?? settings.chargingCost
          ?? 0.25                        // TripDetectorService path

rateEurKwh = settings.homeChargingRate ?? 0.35   // TripGapRecoveryService path (different default!)

trip.costTotal = round(energyUsedKwh × rateEurKwh, 2)
```

This always uses a home/default rate regardless of where the vehicle was
actually charged for the energy that trip used — there's no linkage between
a trip's energy and the specific charging session(s) that supplied it (nor
would that generally be traceable, since a battery doesn't tag electrons by
origin). **`Trip.costTotal` and `ChargingSession.costTotal` are genuinely
different quantities that happen to share a field name** — one is "notional
cost of energy driven," the other is "actual cost of energy purchased."
Nothing in the API or (as far as verified) the frontend currently
distinguishes these when labeled just "cost."

Code: [`trip-detector.service.ts:1354-1363`](../../apps/api/src/trips/trip-detector.service.ts#L1354-L1363),
[`trip-gap-recovery.service.ts:185-192`](../../apps/api/src/trips/trip-gap-recovery.service.ts#L185-L192)

## Energy cost (30-day rollup) and cost per km

`VehicleAnalyticsService.getCostSummary(vehicleId, pricePerKwh=0.25)`:

```
window = last 30 days
totalCost = Σ over charging sessions in window of:
  session.costTotal ?? session.cost            // prefer the real persisted value
  ?? (energyAddedKwh × effectiveRate)           // else re-derive: home/AC-keyword-matched → homeRate, else pricePerKwh

costPerKm = totalCost / Σ(trip.distanceKm in window)     // null if no distance
```

This is a **period-aggregate ratio**, not a per-trip or per-drive figure:
total charging spend over 30 days divided by total distance driven over 30
days. It does not (and structurally cannot, for the reason above) attribute
specific charging cost to specific trips.

`effectiveRate`'s home/AC detection here is a **third, independent**
charger-type classification (string-matching `chargerType` for
`wall`/`home`/`ac`/`slow`), separate from `ChargingCostService`'s own
charger-type branches in [`charging.md`](charging.md#cost).

Code: [`vehicle-analytics.service.ts:354-432`](../../apps/api/src/analytics/vehicle-analytics.service.ts#L354-L432)

## Monthly / weekly cost forecast

`CostForecastService` — the best-designed of the five tariff resolvers,
with explicit source labeling:

```
resolveRate():
  1. if >=3 sessions have both costTotal and energyAddedKwh:
       rate = Σcost / Σenergy  (weighted average of real prices), source='sessions'
  2. else if settings.homeChargingRate or .chargingCost configured:
       rate = that value, source='settings'
  3. else: rate = 0.25, source='default'

avgEnergyPerDay:
  1. from DailyEnergy rows in the last 30 days: Σ / 30              (divide by period length,
                                                                       not row count — avoids a
                                                                       few active days inflating
                                                                       the average)
  2. fallback: Σ(trip.energyUsedKwh) over last 30 days / 30

weeklyCost  = avgEnergyPerDay × 7  × rate
monthlyCost = avgEnergyPerDay × 30 × rate
```

Both `rateSource` and `dataSource` are returned in the result — this is
already the "show your work" provenance pattern the product wants,
implemented once, just not shared with the other four cost paths.

Code: [`cost-forecast.service.ts:28-111`](../../apps/api/src/analytics/cost-forecast.service.ts#L28-L111)

## TCO (Total Cost of Ownership)

**NOT IMPLEMENTED.** No depreciation, insurance, or maintenance-cost
calculation exists anywhere in `apps/api/src` (confirmed by grep across the
whole tree; zero matches for `depreciation`, `insuranceCost`,
`maintenanceCost`, `totalCostOfOwnership`). Building this is net-new work,
not a formula to audit or fix.

## Fleet economics

**NOT IMPLEMENTED.** No fleet business module exists at all (confirmed
during the earlier cross-metric inventory) — this repo is genuinely
single-tenant today. Fleet-level cost/km, utilization-adjusted cost, or
cost-center rollups are net-new work, not something to trace in existing
code.

## Units

€ (EUR hardcoded throughout, per [`README.md`](README.md#units) and
[`charging.md`](charging.md#units) — no exception found in any of the five
implementations above).

## Data-quality rules / Confidence

None of the five cost paths carry a confidence score or HIGH/MEDIUM/LOW
label — the closest thing is `CostForecastService`'s `rateSource`/
`dataSource` strings, which are provenance labels, not a confidence measure.
This is a fifth distinct (non-)confidence representation alongside the four
already catalogued in [`README.md`](README.md#confidence-model).

## Edge cases

1. **Five independent tariff calculations, four different hardcoded
   defaults** — the central finding above. Not a bug in any single file;
   a consistency gap across files that only becomes visible when read
   together, which is presumably why it survived this long.

2. **`Trip.costTotal` and `ChargingSession.costTotal` are different
   concepts sharing a name** — see "Trip cost" above. Anyone consuming the
   API without reading the source could reasonably conflate them.

3. **`getCostSummary`'s cost-per-km is a period ratio, not a per-trip
   figure** — reasonable for "what did the last 30 days cost me," wrong to
   present as "this trip cost X/km" without qualification.

## Algorithm version

Not tracked — same gap as every other spec in this directory, compounded
here by there being five formulas instead of one. See
[`README.md`](README.md#formula-versioning).

## Tests

None found for any of the five implementations (`vehicle-analytics`,
`cost-forecast`, or the trip-finalize/gap-recovery cost blocks) —
`apps/api/test/` has no spec touching any of them.
