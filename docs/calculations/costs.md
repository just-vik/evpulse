# Costs (charging, trip, cost/km, monthly, TCO, fleet)

Status: **mixed** — this spec covers a *chain* of cost concepts, not one
formula. Some levels are real and working; several don't exist. Verified
against `apps/api/src` on `main` @ `21ca2ef`. See [`README.md`](README.md)
for shared conventions.

**Revision note (2nd correction):** the first pass (@ `856ffc8`) reported
"four hardcoded defaults"; a second pass (@ `8016c90`) traced consumers and
found a fifth. This third pass traces one level further — where
`VehicleSettings` values actually come from — and found that **most of
those five "defaults" are dead code**, because `VehicleSettings` is
guaranteed non-null for every vehicle
([`charging.md`](charging.md#vehiclesettings-is-the-primary-configured-tariff-source--the--032045-fallbacks-above-are-practically-unreachable)).
The real picture is smaller and different in kind — see "The central
finding" below, now split into three categories instead of one flat list.

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

## The central finding, corrected: one real settings source, mostly-dead fallback code, and one genuinely distinct default

The original framing ("five independent hardcoded defaults create everyday
inconsistency") overstated the practical risk. Tracing where
`VehicleSettings` values come from
([`charging.md`](charging.md#vehiclesettings-is-the-primary-configured-tariff-source--the--032045-fallbacks-above-are-practically-unreachable))
shows that field is non-nullable and guaranteed to exist for every vehicle
— so most of the resolvers' own hardcoded fallbacks can only fire if that
guarantee is somehow violated, which hasn't been shown to happen. The real
picture splits into three categories:

**1. Actual persisted defaults** — what a real `VehicleSettings` row
contains once created (`vehicles.service.ts`'s seed values, always
non-null thereafter):

| Field | Value |
|---|---|
| `homeChargingRate` | €0.35 (consistent everywhere) |
| `thirdPartyRate` | €0.55 at creation — **but declared as €0.45 in two other places** (see [`charging.md`](charging.md#vehiclesettings-is-the-primary-configured-tariff-source--the--032045-fallbacks-above-are-practically-unreachable)); confirmed inconsistent declarations, reachability of the disagreement not established |
| `superchargerRate` | €0.49 (consistent everywhere it's seeded/declared) |

**2. Application fallback constants** — hardcoded literals in the five
resolvers, **practically unreachable in normal operation** because they
only fire if `settings` (or the specific field they check) were null,
which the schema/creation guarantee rules out for ordinary vehicles:

| Resolver | Fallback literal | Reachable? |
|---|---|---|
| `ChargingCostService` (home bucket) | €0.32 | No — `homeChargingRate` always resolves to €0.35 first |
| `ChargingCostService` (public/3rd-party buckets) | €0.45 | No — `thirdPartyRate` always resolves first (to whichever of €0.55/€0.45 is actually persisted) |
| `ChargingCostService.superchargerRateForTime` | €0.42 | No — `superchargerRate` always resolves to €0.49 first |
| `CostForecastService.resolveRate` | €0.25 | No — `homeChargingRate` (€0.35) always satisfies its `>0` check first |
| `TripDetectorService` trip-finalize | €0.25 | No — same reason |
| `TripGapRecoveryService` | €0.35 | No (and happens to equal the real `homeChargingRate` value anyway, so even if it *were* reached, no visible difference) |
| `VehicleAnalyticsService.getCostSummary` (service signature) | €0.25 | No — shadowed entirely by its controller, see category 3 |

None of these five/six literals are currently proven to produce a wrong
number for any real vehicle — they're dead defensive code, not live
divergent behavior. They're still worth consolidating for maintainability
(six different guesses at "what if settings is missing" is real
technical debt), but this is a smaller, different claim than "users see
inconsistent costs today."

**3. A genuinely distinct, reachable default** — `vehicle-analytics.
controller.ts`'s `€0.13`. Unlike everything in category 2, this is **not**
a `VehicleSettings` fallback at all — it's the rate `GET .../cost-summary`
assumes for non-home-classified charging when the caller doesn't pass
`?rate=`, entirely independent of the settings system. This one is real
and live: a user who never passes `?rate=` gets their non-home charging
costed at €0.13/kWh in this one specific rollup, regardless of their
actual configured `thirdPartyRate`.

**Architectural read, revised:** the actual live inconsistency is narrow —
(a) the `thirdPartyRate` €0.55-vs-€0.45 declaration mismatch (settings
layer, not the resolvers), and (b) the €0.13 controller default disagreeing
with a vehicle's real `thirdPartyRate`/`homeChargingRate` for non-home
sessions in one specific endpoint. Category 2's six dead fallback constants
are a code-cleanliness argument for consolidation, not evidence of a
live pricing bug. Any `TariffResolverService` design should treat these as
different-priority problems: (a) and (b) affect real numbers today, the
category-2 cleanup does not.

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

`VehicleAnalyticsService.getCostSummary(vehicleId, pricePerKwh=0.25)` — but
called exclusively from `GET /analytics/vehicle/:id/cost-summary`
([`vehicle-analytics.controller.ts:74-79`](../../apps/api/src/analytics/vehicle-analytics.controller.ts#L74-L79)),
whose handler resolves `pricePerKwh` itself before calling the service:
`rate ? Number(rate) : 0.13`. The service's own `=0.25` default is
therefore **never reached through the real API** — the actual effective
default a user sees is **€0.13**, a sixth number for the same concept that
only the service's own default-parameter reading would suggest is €0.25.

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

## Manual cost override — bypasses tariff resolution entirely

`ChargingSession.manualCost`, settable via `PUT /charging/sessions/:id/cost`
([`charging.controller.ts:87-94`](../../apps/api/src/charging/charging.controller.ts#L87-L94)).
Not documented anywhere before this pass. This is a **user-entered value**
that sits outside all five resolution paths above — it isn't a sixth
tariff-resolution tier (it doesn't compute a rate from anything), it's an
escape hatch that says "ignore the resolver, I know the real number."
`calculateSessionCost` already checks for this: `if (session.costSource ===
'manual' || ...) return` — a manually-costed session is never overwritten
by recalculation. Any future `TariffResolverService` needs to preserve this
as an explicit bypass, not fold it into the resolution ladder as another
fallback tier — it answers a different question ("what did the user say
they paid") than the resolver's ("what rate should apply here").

## Currency — a second, independent fallback (not a rate one)

`ChargingCostService.getMonthlyCostSummary`
([`charging-cost.service.ts:303-340`](../../apps/api/src/charging/charging-cost.service.ts#L303-L340))
aggregates already-persisted `costTotal` values (no tariff resolution of
its own) but resolves **currency** independently: `sessions.find(s =>
s.currency)?.currency ?? 'EUR'` — the first session in the window that has
a non-null `currency`, else hardcoded `'EUR'`. Every session's own
`currency` field is itself always written as the literal string `'EUR'` by
`ChargingCostService` (see [`charging.md`](charging.md#cost)), so in
practice this fallback is currently unreachable — but it's a second,
separately-authored "what currency" decision, distinct from the five "what
rate" decisions above, and worth keeping distinct in any future contract
rather than assuming rate and currency always resolve together.

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

1. **Five independent tariff-resolution code paths, six dead fallback
   constants, and two live disagreements** — the central finding above.
   The dead constants (category 2) are a maintainability problem, not
   evidence of wrong numbers today; the €0.55/€0.45 `thirdPartyRate`
   declaration mismatch and the €0.13 controller default (category 3) are
   the two things that can actually produce a real, live disagreement for
   a real vehicle. Neither layer was visible from reading any single file
   in isolation — the settings-source mismatch only appeared by tracing
   *backward* to where `VehicleSettings` rows are created, and the €0.13
   shadow only appeared by tracing *forward* to the actual API consumer.

2. **`Trip.costTotal` and `ChargingSession.costTotal` are different
   concepts sharing a name** — see "Trip cost" above. Anyone consuming the
   API without reading the source could reasonably conflate them.

3. **`getCostSummary`'s cost-per-km is a period ratio, not a per-trip
   figure** — reasonable for "what did the last 30 days cost me," wrong to
   present as "this trip cost X/km" without qualification.

4. **`manualCost` is an undocumented bypass, not a resolution tier** — see
   "Manual cost override" above. Easy to miss when designing a consolidated
   resolver, since it looks superficially like "just another fallback."

5. **`TripGapRecoveryService` is missing a fallback tier its sibling has**
   — `TripDetectorService`'s trip-finalize path checks `homeChargingRate`
   then `chargingCost` before the hardcoded default; the gap-recovery path
   only checks `homeChargingRate`. Whether this is deliberate (recovered
   trips are already a degraded-data path) or simply an oversight when the
   two were written separately is not determinable from the code alone.

## Algorithm version

Not tracked — same gap as every other spec in this directory, compounded
here by there being five formulas instead of one. See
[`README.md`](README.md#formula-versioning).

## Tests

None found for any of the five implementations (`vehicle-analytics`,
`cost-forecast`, or the trip-finalize/gap-recovery cost blocks) —
`apps/api/test/` has no spec touching any of them.
