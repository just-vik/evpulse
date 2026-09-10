# TariffResolverService — design document

Status: **PROPOSED — design only, nothing implemented.** No code, schema,
or migration exists yet. This document exists to be reviewed and corrected
*before* any of that starts, per the explicit ordering: contract → policy
→ characterization tests of the five current paths → consolidation. See
[`costs.md`](costs.md) and [`charging.md`](charging.md) for the audit
findings this design responds to.

## 1. Responsibility (what this service is and isn't)

`TariffResolverService` answers exactly one question:

> **What rate per kWh should apply to this energy cost calculation?**

It does **not**:
- compute energy (kWh) — that's [`energy.md`](energy.md)
- compute `Trip.costTotal` or `ChargingSession.costTotal` — those are
  **consumers** of a resolved tariff, and the two remain distinct concepts
  (see [`costs.md`](costs.md#trip-cost--a-different-concept-than-what-you-paid-to-charge))
- compute `costPerKm` or any forecast figure
- override or touch an already-set `manualCost` — that value is never
  passed through the resolver at all (see §6)

Every one of the five current call sites keeps its own "what do we count
as cost" logic; only the "what rate" sub-question moves into this service.

## 2. Contract

```ts
type TariffSource =
  | 'supercharger_catalog'   // Tesla's own pricing API, GPS+time matched
  | 'vehicle_settings'       // a configured VehicleSettings field
  | 'historical_sessions'    // weighted average of past persisted costs
  | 'default';               // canonical application default, last resort

interface TariffResolution {
  ratePerKwh: number;
  currency: string;
  source: TariffSource;
}

interface TariffContext {
  vehicleId: string;
  chargerType?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  timestamp: Date;
}
```

`historical_sessions` means a derived tariff from already-persisted
charging costs — not a new way to compute what a specific session actually
cost. See §5 for why this tier is restricted to certain consumers.

**Open question (not yet decided, flagging rather than assuming):**
`TariffContext` as specified has no field for *which* consumer is asking
or *why* — but §5 requires the resolver to behave differently for an
actual-cost calculation (charging a real session) vs. a forecast. Two ways
to resolve this, neither chosen yet:
- (a) add `purpose: 'actual_cost' | 'forecast'` to `TariffContext`, and the
  resolver internally skips the `historical_sessions` tier unless
  `purpose === 'forecast'`
- (b) don't touch the shared resolver's tiers at all; instead
  `CostForecastService` keeps its own historical-averaging step ahead of
  calling the resolver only for the settings/default tail of its own
  ladder

(b) is more conservative (smaller blast radius on the shared service) but
partially defeats the point of consolidation for that one path. Needs a
decision before the contract is final.

## 3. `VehicleSettings` field semantics (canonical meanings, not renamed)

| Field | Canonical meaning | Current seed/default | Notes |
|---|---|---|---|
| `homeChargingRate` | Configured €/kWh for energy charged **at home**. Used only when charging location/type is classified as home, or a consumer explicitly requests the home tariff. | €0.35/kWh | Consistent across every place it's declared — no open issue. |
| `thirdPartyRate` | Configured €/kWh for **public, non-Tesla** third-party charging. Explicitly **not** the Supercharger tariff. | €0.55/kWh at vehicle creation | **Declared as €0.45 in two other places** (`VehicleSettingsService.DEFAULTS`, Prisma schema default) — see [`charging.md`](charging.md#vehiclesettings-is-the-primary-configured-tariff-source--the--032045-fallbacks-above-are-practically-unreachable). This design does not resolve which value is "right" — that's a data decision (does the resolver read the persisted €0.55, or should the declared defaults be reconciled to match it?), not a resolver-logic one. |
| `superchargerRate` | Configured **fallback** €/kWh for Tesla Supercharger when the Tesla catalog can't resolve a price — not the primary source. | €0.49/kWh | Treated as fallback-only in this design, matching current `charging-cost.service.ts` behavior. |
| `chargingCost` | **Not resolved in this pass.** Audit shows it used as an additional configured rate/fallback in existing code (`CostForecastService`, `TripDetectorService`), but its intended distinction from `homeChargingRate` was never established from the code alone. **Do not treat it as a synonym for `homeChargingRate` or `thirdPartyRate`** — its exact domain semantics need a separate decision before it's folded into this resolver or removed. Until then, the resolver should treat it as opaque legacy input, not silently reinterpret it. |

## 4. Tesla Supercharger precedence

```
Tesla Supercharger catalog (GPS + time matched, real market rate)
        ↓ (no site match, GPS unavailable, or catalog call fails)
VehicleSettings.superchargerRate
        ↓ (only if the specific consumer actually wants a non-Supercharger
           tariff here — e.g. an ambiguous high-power DC session that
           turned out not to be Tesla-branded)
other configured tariff (thirdPartyRate)
        ↓
canonical default
```

**Catalog failure semantics** (what counts as "the catalog didn't
resolve," carried over from today's real behavior in
[`charging.md`](charging.md#cost)):
- No GPS coordinates available for the session
- GPS available but no matching Supercharger site within the lookup radius
- The catalog API call itself errors (network, auth, rate limit)

Any of these → fall through to `VehicleSettings.superchargerRate`,
`source: 'vehicle_settings'`. A successful catalog match always wins and is
never blended with settings or history — it's an **external authoritative
price**, not a fallback-derived estimate, and must not be averaged with
`historical_sessions` under any circumstance.

**Open question:** `TariffSource.vehicle_settings` doesn't distinguish
*which* settings field resolved (home / third-party / supercharger-fallback).
Today's `costSource` column already carries finer strings
(`'supercharger'`, `'tariff'`) — does `TariffResolution` need a similar
sub-field, or is coarse `'vehicle_settings'` sufficient and the caller
re-derives which field mattered from its own `chargerType` input? Not
decided here.

## 5. Historical-rate eligibility

```
purpose = forecast:
  ≥3 historical sessions with known costTotal + energyAddedKwh
        ↓ (fewer than 3, or purpose ≠ forecast)
  weighted average of those → source: 'historical_sessions'
        ↓
  VehicleSettings tariff → source: 'vehicle_settings'
        ↓
  canonical default → source: 'default'

purpose = actual_cost (pricing a real session/trip right now):
  historical_sessions tier is SKIPPED ENTIRELY.
  Tesla catalog → VehicleSettings → canonical default only.
```

Rationale (from your framing, kept verbatim): if a past session's price was
wrong or anomalous, `historical_sessions` must not let that error
propagate into new persisted costs. It's legitimate input for *predicting*
a future cost, illegitimate input for *pricing* a session that's actually
happening now. This is the same concern as the `purpose` field in §2 — the
two need to be decided together, not independently.

## 6. Manual override — never enters the resolver

```
if (session.manualCost != null) {
  return session.manualCost;   // exact user-provided value, as-is
}
const tariff = await tariffResolver.resolve(context);
// ... consumer applies tariff.ratePerKwh × energy, per its own cost semantics
```

`manualCost` is checked by the **caller**, before the resolver is ever
invoked — it is not a `TariffSource` value and the resolver never sees a
manually-costed session. This matches `calculateSessionCost`'s existing
`if (costSource === 'manual' ...) return` guard
([`costs.md`](costs.md#manual-cost-override--bypasses-tariff-resolution-entirely))
— the new design formalizes what already exists, doesn't change it.

## 7. Currency policy — deliberately incomplete here

```
Tesla catalog's own currency (when a catalog match resolves)
        ↓
a configured currency (if/when one exists — see below)
        ↓
canonical application currency
```

**Not decided in this document:** what the "canonical application
currency" actually is. Today it's an unexamined hardcoded `'EUR'` literal
scattered across multiple files
([`charging.md`](charging.md#cost), [`costs.md`](costs.md#units)) with no
schema field backing it. This design deliberately does **not** carry that
forward as a silent default — introducing a real currency policy (even if
the answer ends up being "EUR, explicitly, as a documented product
decision" rather than "EUR because nobody thought about it") is a separate
decision this document flags but does not make.

## 8. Architecture

```
                    ┌─ Tesla Supercharger catalog
                    │
TariffResolver ─────┼─ VehicleSettings (home / third-party / supercharger)
                    │
                    ├─ Historical sessions   (forecast purpose only — §5)
                    │
                    └─ Canonical default
                           │
                           ▼
                    TariffResolution
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
           Charging        Trip       Forecast
             cost          cost        cost

manualCost sits BEFORE the resolver, as an explicit bypass — never a tier
inside it (§6).
```

## 9. Migration mapping — old five paths → new resolver

| Current implementation | What it keeps doing itself | What moves to `TariffResolverService` |
|---|---|---|
| `ChargingCostService.calculateSessionCost` | Ghost-session rejection, efficiency calc, GPS-based catalog lookup call, persisting `costTotal`/`costSource` | The catalog→settings→default rate decision (§4); `manualCost` short-circuit stays in this service, ahead of the resolver call |
| `VehicleAnalyticsService.getCostSummary` | Period aggregation, `costPerKm` ratio, preferring persisted `session.costTotal` first | The re-derivation fallback (currently its own charger-type keyword match + `pricePerKwh`) — becomes a resolver call with `purpose: 'actual_cost'` (or `'forecast'`? — this endpoint computes a historical rollup, not a live session price; needs a decision, see below) |
| `CostForecastService.resolveRate`/`forecastForVehicle` | `avgEnergyPerDay` computation, weekly/monthly projection | The entire rate ladder becomes a `purpose: 'forecast'` resolver call — this is the path `historical_sessions` was designed for |
| `TripDetectorService` trip-finalize | Everything about what `Trip.costTotal` means (§ unchanged, see [`costs.md`](costs.md#trip-cost)) | Just the rate lookup — `purpose: 'actual_cost'`, since a trip's notional cost is being fixed at finalize time, not forecast |
| `TripGapRecoveryService` | Same as above, for reconstructed trips | Same resolver call as `TripDetectorService` — this also fixes the missing-`chargingCost`-tier inconsistency between the two paths, since both would call the same resolver instead of hand-rolling their own partial ladders |

**Open question:** `VehicleAnalyticsService.getCostSummary` is a 30-day
*rollup* of what already happened, not a forecast and not pricing a live
session — it doesn't cleanly fit either `purpose` value from §5. This
needs its own decision, not a forced fit into the two-value enum as
currently scoped.

## 10. Decisions that require a schema change (deliberately not made here)

Listed, not resolved — none of these are touched until characterization
tests exist for all five current paths:

1. **`thirdPartyRate` €0.55-vs-€0.45 reconciliation** — does the schema
   default / `VehicleSettingsService.DEFAULTS` change to match the real
   €0.55 seed, or does the seed change to €0.45? Either is a data decision
   affecting real persisted rows, not just declared constants.
2. **`chargingCost`'s fate** — keep as distinct legacy field, formally
   define its semantics, or deprecate/migrate into `homeChargingRate`? Not
   decided (§3).
3. **Currency** — whether `VehicleSettings` (or `ChargingSession`) gets a
   real `currency`/canonical-currency field, vs. continuing with the
   unexamined `'EUR'` literal (§7).
4. **`TariffContext.purpose`** — whether this field gets added at all
   (§2, §5), and how `VehicleAnalyticsService.getCostSummary` maps onto it
   (§9).
5. **Source provenance granularity** — whether `TariffSource` needs a
   sub-field for which `VehicleSettings` column resolved (§4).

## 11. Explicitly not touched in this design pass

Per instruction: Prisma schema, `Trip.costTotal`/`ChargingSession.costTotal`
semantics, `costPerKwh` schema, currency columns, `superchargerRate`
migration, `chargingCost` removal, and actual tariff values. Next step
after this document is reviewed: characterization tests for all five
current paths (pinning today's actual output, including the dead fallback
constants' current — even if unreachable — behavior), *then* migration
design, per the explicit ordering already agreed.
