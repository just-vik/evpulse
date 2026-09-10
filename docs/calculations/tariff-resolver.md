# TariffResolverService — design document

Status: **PROPOSED — contract and policy finalized, nothing implemented.**
No code, schema, or migration exists yet. All five open questions from the
first draft are now resolved below. Next step: characterization tests for
the five current paths (kept as a **separate, distinct test group** from
future contract tests — see §9), then implementation, per the agreed
ordering. See [`costs.md`](costs.md) and [`charging.md`](charging.md) for
the audit findings this design responds to.

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

## 2. Contract (final)

```ts
type TariffPurpose =
  | 'actual_cost'         // pricing a real charging session or trip, now
  | 'historical_summary'  // aggregating already-persisted costs (e.g. getCostSummary)
  | 'forecast';           // predicting future cost

type TariffSource =
  | 'supercharger_catalog'
  | 'vehicle_settings.home'
  | 'vehicle_settings.third_party'
  | 'vehicle_settings.supercharger'
  | 'historical_sessions'
  | 'default'
  // Caller-side only — resolve() NEVER returns this. A consumer that finds
  // session.manualCost != null returns { rate: manualCost, currency,
  // source: 'manual_override' } itself, without calling resolve() at all
  // (§6). Exists purely so every consumer's TariffResolution has one
  // uniform shape regardless of whether the rate came from the resolver
  // or a user override.
  | 'manual_override';

interface TariffContext {
  purpose: TariffPurpose;
  vehicleId: string;
  chargerType?: string;
  location?: {
    latitude: number;
    longitude: number;
  };
  timestamp?: Date;
}

interface TariffResolution {
  rate: number;
  currency: string;
  source: TariffSource;
}
```

Changes from the first draft, all decided:
- **`purpose` is required, three-valued**, not the two-valued optional
  field first proposed — `historical_summary` is its own case, not a forced
  fit into `actual_cost` or `forecast` (§3).
- **`TariffSource` is granular per settings field** — `vehicle_settings`
  alone was rejected as insufficiently diagnostic (§4).
- **`manual_override` added to `TariffSource`**, caller-side only, as above.
- **A resolved rate of exactly `0` is treated as unconfigured**, not a real
  free-electricity rate, for every `VehicleSettings` field the resolver
  reads (home/third-party/supercharger standard rate) — canonicalizing in
  favor of `TripDetectorService`'s `(x ?? 0) > 0` style over
  `TripGapRecoveryService`'s plain `?? fallback`, which is the exact
  divergence `tariff-current-behavior-trip-paths.spec.ts` found. A `0`
  field falls through to the next tier exactly like a missing settings row.
- **`chargingCost` stays excluded** — reconfirmed, not reversed. It is not
  a resolver input, not a synonym for `homeChargingRate`, and not covered
  by resolver tests. Existing callers that read it keep doing so
  themselves until its own semantics are decided separately (§4).

`historical_sessions` means a derived tariff from already-persisted
charging costs, used **only** for `purpose: 'forecast'` — never for pricing
a session happening now, and never as `historical_summary`'s own fallback
mechanism (§3).

## 3. Resolution policy, by purpose

```
actual_cost:
  Tesla Supercharger catalog  → source: 'supercharger_catalog'
        ↓ (no match / no GPS / catalog error)
  VehicleSettings (home / third-party / supercharger, by chargerType)
        ↓
  canonical default

historical_summary:
  Use ChargingSession.costTotal AS PERSISTED — the resolver is not the
  source of truth here at all for sessions that already have a cost.
        ↓ (only for sessions with no persisted costTotal — a data gap,
           not a missing-tariff case)
  VehicleSettings              → source: 'vehicle_settings.*'
        ↓
  canonical default
  # historical_sessions (weighted average) is NEVER used here — a rollup
  # must not paper over its own gaps by re-deriving from other sessions'
  # already-aggregated numbers; that would double-count signal.

forecast:
  ≥3 historical sessions with known costTotal + energyAddedKwh
        ↓ (fewer than 3)
  weighted average               → source: 'historical_sessions'
        ↓
  VehicleSettings                → source: 'vehicle_settings.*'
        ↓
  canonical default
```

`VehicleAnalyticsService.getCostSummary` maps to `historical_summary`,
resolving the open question from the first draft: it is architecturally
"read what's already there, resolver only fills real gaps," not "compute a
rate as if pricing something now or predicting the future." Concretely:

```
ChargingSession.costTotal (persisted)
        ↓
VehicleAnalyticsService's 30-day aggregation
        ↓ (only for sessions missing costTotal)
TariffResolverService.resolve({ purpose: 'historical_summary', ... })
```

## 4. `VehicleSettings` field semantics and provenance granularity

| Field | Canonical meaning | Canonical value | `TariffSource` when used |
|---|---|---|---|
| `homeChargingRate` | Configured €/kWh for energy charged **at home** | €0.35/kWh | `vehicle_settings.home` |
| `thirdPartyRate` | Configured €/kWh for **public, non-Tesla** third-party charging — explicitly not the Supercharger tariff | **€0.55/kWh — decided canonical, see §5** | `vehicle_settings.third_party` |
| `superchargerRate` | Configured **fallback standard/peak rate** for Tesla Supercharger when the catalog can't resolve a price | €0.49/kWh | `vehicle_settings.supercharger` |
| `chargingCost` | **Excluded from the resolver — reconfirmed, not reversed.** Kept as opaque legacy input; not treated as a synonym for the two fields above, not a resolver tier, not covered by resolver tests. Existing callers that currently read it (`CostForecastService`, `TripDetectorService`) keep doing so themselves until its domain semantics are formally decided. | — | — (not a resolver source) |

Provenance is now granular by design (`vehicle_settings.home` vs
`.third_party` vs `.supercharger`) rather than one coarse
`'vehicle_settings'` value — diagnostic value was judged to outweigh the
extra enum surface, matching how `costSource` already distinguishes
`'supercharger'` from `'tariff'` today.

**Supercharger time-of-day pricing is part of the `vehicle_settings.
supercharger` tier**, not a separate one — it's still one field's worth of
"what does VehicleSettings say," just with a time component. Mirrors
`charging-cost.service.ts`'s `superchargerRateForTime()` exactly (same
peak/off-peak window resolution, same `timezone` fallback to
`'Europe/Berlin'`), with the 0-as-unconfigured guard applied to the
standard rate before any peak/off-peak branching:

```
standardRate = (superchargerRate ?? 0) > 0 ? superchargerRate : UNCONFIGURED
if UNCONFIGURED: fall through to canonical default
if superchargerOffPeakRate is null: use standardRate (no ToD pricing configured)
else: use standardRate during [superchargerPeakStart, superchargerPeakEnd)
      local time (vehicle timezone), else superchargerOffPeakRate
```

## 5. `thirdPartyRate`: canonical value decided, reconciliation deferred

**Canonical value: €0.55/kWh** — because that's the value actually written
by `vehicles.service.ts` at vehicle creation, which is the real, live
seed every vehicle gets. The resolver reads `VehicleSettings.thirdPartyRate`
**as-is**, with no reconciliation logic:

```
rate = VehicleSettings.thirdPartyRate   // whatever is actually persisted
```

Not:

```
rate = thirdPartyRate === 0.45 ? 0.55 : thirdPartyRate   // NOT this
```

The €0.45 declared in `VehicleSettingsService.DEFAULTS` and the Prisma
schema default are **not** the resolver's problem to paper over — they're
a data/declaration inconsistency to fix separately (a data-cleanup pass
that reconciles those two declarations to €0.55, out of scope for this
service) so that the *only* place €0.45 could ever surface is if a
`VehicleSettings` row genuinely doesn't exist yet — the same "essentially
unreachable in practice" case documented in
[`charging.md`](charging.md#vehiclesettings-is-the-primary-configured-tariff-source--the--032045-fallbacks-above-are-practically-unreachable).

## 6. Manual override — never enters the resolver

```
if (session.manualCost != null) {
  return session.manualCost;   // exact user-provided value, as-is
  // STOP — do not call the resolver at all
}
const tariff = await tariffResolver.resolve(context);
```

`manualCost` is checked by the **caller**, before the resolver is ever
invoked — it is not a `TariffSource` value and the resolver never sees a
manually-costed session. This matches `calculateSessionCost`'s existing
`if (costSource === 'manual' ...) return` guard
([`costs.md`](costs.md#manual-cost-override--bypasses-tariff-resolution-entirely))
— the design formalizes what already exists, doesn't change it.

## 7. Currency policy — resolved as "not the resolver's to default silently"

```
Tesla Supercharger catalog match  → currency comes from Tesla's own pricing data
VehicleSettings                   → currency must be explicitly determined by
                                     the system/vehicle settings (not assumed)
Historical sessions                → use the currency of the persisted
                                     records being averaged
default tier                      → 'EUR' only once EUR is officially
                                     ratified as the canonical application
                                     currency — NOT a silent `?? 'EUR'`
                                     inside the resolver
```

Decided: the resolver must **not** contain a bare `currency ?? 'EUR'`
anywhere. Until a canonical-currency decision is formally made elsewhere
(product/business decision, not a resolver-logic one), the `default` tier
either surfaces the absence explicitly (e.g. throws, or returns a
resolution the caller must reject) rather than silently defaulting — the
exact mechanism is an implementation detail for when the resolver is
actually built, but "silently assume EUR" is ruled out now.

## 8. Architecture

```
                    ┌─ Tesla Supercharger catalog        (actual_cost)
                    │
TariffResolver ─────┼─ VehicleSettings (home/3rd-party/supercharger)
                    │                                    (all purposes,
                    │                                     as gap-fallback
                    │                                     for historical_summary)
                    ├─ Historical sessions                (forecast only)
                    │
                    └─ Canonical default
                           │
                           ▼
                    TariffResolution
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
           Charging    Trip cost    Forecast /
             cost      (finalize)   cost-summary
           (actual_     (actual_    (forecast /
            cost)        cost)      historical_summary)

manualCost sits BEFORE the resolver, as an explicit bypass — never a tier
inside it (§6).
```

## 9. Migration mapping — old five paths → new resolver

| Current implementation | What it keeps doing itself | Resolver call |
|---|---|---|
| `ChargingCostService.calculateSessionCost` | Ghost-session rejection, efficiency calc, GPS-based catalog lookup, persisting `costTotal`/`costSource`; `manualCost` short-circuit stays here, ahead of the resolver call | `purpose: 'actual_cost'` |
| `VehicleAnalyticsService.getCostSummary` | Period aggregation, `costPerKm` ratio, preferring persisted `session.costTotal` first | `purpose: 'historical_summary'` — resolver used only for sessions missing `costTotal`, never re-derives a full rollup |
| `CostForecastService.resolveRate`/`forecastForVehicle` | `avgEnergyPerDay` computation, weekly/monthly projection | `purpose: 'forecast'` — the one path that legitimately uses `historical_sessions` |
| `TripDetectorService` trip-finalize | Everything about what `Trip.costTotal` means, unchanged (see [`costs.md`](costs.md#trip-cost)) | `purpose: 'actual_cost'` |
| `TripGapRecoveryService` | Same as above, for reconstructed trips | `purpose: 'actual_cost'` — same resolver call as `TripDetectorService`, which also fixes the missing-`chargingCost`-tier inconsistency between the two paths since both now share one ladder |

## 10. Decisions that still require a schema/data change (unchanged from draft 1, still deferred)

1. **`thirdPartyRate` reconciliation** — €0.55 is now the *canonical
   value* (§5), but `VehicleSettingsService.DEFAULTS` and the Prisma schema
   default still declare €0.45. A data-cleanup pass to align those
   declarations is still needed; the resolver design assumes it will
   happen but does not perform it.
2. **`chargingCost`'s fate** — still not decided (§4): keep as distinct
   legacy field, formally define its semantics, or deprecate/migrate?
3. **Currency** — whether `VehicleSettings`/`ChargingSession` gets a real
   currency field, and what the canonical application currency actually is
   (§7) — a product decision, not made here.

## 11. Explicitly not touched in this design pass

Per instruction: Prisma schema, `Trip.costTotal`/`ChargingSession.costTotal`
semantics, `costPerKwh` schema, currency columns, `superchargerRate`
migration, `chargingCost` removal, and actual tariff values. Next step:
characterization tests for the five current paths — see the ordering rule
below.

## 12. Test ordering rule (do not mix these two groups)

1. **Current-behavior tests** — pin what the five existing implementations
   actually return today, including the practically-unreachable dead
   fallback constants (§ [`costs.md`](costs.md#the-central-finding-corrected-one-real-settings-source-mostly-dead-fallback-code-and-one-genuinely-distinct-default)),
   written and passing *before* any resolver code exists. These tests
   describe the current system, not the target one — €0.35/€0.45/€0.55 and
   all.
2. **`TariffResolverService` contract tests** — written against the new
   service once it exists, asserting *this* document's policy (§3–§7).

The two groups must not be merged into one file or one assertion set —
doing so would risk quietly canonizing today's accidental disagreements
(e.g. €0.45 vs €0.55) as if they were an intentional part of the new
contract, instead of the resolver replacing them with one deliberate
answer (§5).
