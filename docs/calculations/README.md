# EVPulse Calculation Specifications

Index and shared rules for the per-metric specs in this directory. Each spec
describes what the code **actually does today** (verified by reading
`apps/api/src`, cited by file:line), not a proposed redesign. Formulas are
only changed after their current behavior is documented and, where
practical, covered by tests — see [`energy.md`](energy.md)'s "Tests"
section for why that order matters.

## Metric specs

| File | Covers | Status |
|---|---|---|
| [`energy.md`](energy.md) | Trip energy, consumption (Wh/km) | Done |
| [`trips.md`](trips.md) | Trip detection state machine, start/end, distance, gaps | Done |
| [`charging.md`](charging.md) | Charging session detection, energy source ladder, cost, efficiency | Done |
| [`battery-health.md`](battery-health.md) | SOH / degradation estimate — two competing engines found; `BatteryAnalyticsService` now designated canonical, `BatteryHealthService` legacy | Done |
| [`range.md`](range.md) | Range prediction | Done |
| [`costs.md`](costs.md) | Charging/trip/energy cost, cost-per-km, forecast (implemented); TCO, fleet economics (not implemented) | Done |
| [`data-quality.md`](data-quality.md) | Cross-cutting catalogue: data states, outlier thresholds, confidence models, proposed future contract | Done |

## Units

Internal storage and calculation use SI-ish base units; display formatting
is a separate, later step and must not leak into stored values or APIs:

| Quantity | Internal unit | Displayed as |
|---|---|---|
| Energy | kWh | kWh |
| Consumption | Wh/km | kWh/100km |
| Distance | km | km |
| Power | kW | kW |
| Cost | € (float, 2dp) | € |
| SOC / SOH | % (0–100) | % |

Currency is currently hardcoded to EUR in charging cost calculation
(`charging-cost.service.ts`) — there is no multi-currency support, so "unit"
for cost is really "EUR" specifically, not an abstract currency field.

## Data-source hierarchy

The same **pattern** recurs independently across four subsystems (trip
energy, charging energy, charging cost, battery health), but it is not a
shared implementation — each was written separately and could drift:

```
Tesla-reported / measured value
       ↓ (if missing, implausible, or fails a sanity check)
Calculated / derived value
       ↓ (if that also fails)
Configured default / hardcoded fallback
```

Concretely:
- **Charging energy**: `charge_energy_added` delta (Tesla) → power integral (calculated). See [`charging.md`](charging.md#energy-source-selection).
- **Charging cost**: Tesla Supercharger catalog API (measured market rate) → user-configured tariff → hardcoded default (€0.32 home / €0.45 public). See [`charging.md`](charging.md#cost).
- **Trip energy**: power integral only — **no fallback tier exists**. See [`energy.md`](energy.md#fallbacks).
- **Trip distance**: GPS (default) → odometer delta (fallback, only when GPS underestimates). See [`trips.md`](trips.md#distance).

Any new metric should follow this same three-tier shape where a Tesla signal
exists, explicitly document which tier is live for a given result, and
persist *which tier won* — charging cost already does this (`costSource`
column); charging energy computes the same choice but only logs it, doesn't
persist it (documented gap in [`charging.md`](charging.md#energy-source-selection)).

**Tariff resolution specifically does not follow "one ladder, one
implementation"** — [`costs.md`](costs.md#the-central-finding-corrected-one-real-settings-source-mostly-dead-fallback-code-and-one-genuinely-distinct-default)
found five independently-authored tariff-resolution code paths, but tracing
where their inputs actually come from (`VehicleSettings`, guaranteed
non-null per vehicle) showed most of their own hardcoded fallback constants
are dead code, not live divergent behavior. What *is* live: a genuine
disagreement between two declared "default" values for `thirdPartyRate`
(€0.55 at vehicle creation vs €0.45 elsewhere), and a controller-level
€0.13 default (`vehicle-analytics.controller.ts`) that's independent of
`VehicleSettings` entirely and only visible by tracing forward to the
actual API consumer. This is still the clearest concrete argument in the
whole audit for a single shared `TariffResolverService` — just for a more
specific reason than "five random numbers": one real settings-layer
inconsistency plus one orphaned endpoint-level default, buried under a pile
of consolidation-worthy but currently-harmless dead code.

## Confidence model

**There is no single, shared confidence model today** — this section
documents the actual fragmentation, not an aspirational unification:

- **Trip energy/trips**: two separate scores — a per-point 0–1 confidence
  (gates state-machine transitions only, does not gate the energy integral
  itself) and a per-trip 0–100 quality score with HIGH/MEDIUM/LOW labels.
  Neither is exposed in any UI today. See [`energy.md`](energy.md#confidence).
- **Battery health**: turned out to have *three* independently-authored
  confidence representations on its own once both engines were fully
  audited — session-count-scaled 0.30–0.95 (legacy engine), method-count
  ratio 0.33/0.67/1.00 (canonical engine's SOH blend), and a categorical
  HIGH/MEDIUM/NONE (canonical engine's separate baseline-lock mechanism).
  See [`battery-health.md`](battery-health.md#confidence-models-catalogued-so-far-battery-health-alone-has-three).
- **Charging**: no numeric confidence at all — only a `costSource` /
  `chargerType` string indicating which pricing tier was used. See
  [`charging.md`](charging.md#data-quality-rules--confidence).
- **Range**: a fourth, independently-authored 0–1 formula scaled by trip
  count alone (`min(0.95, 0.5 + tripsUsed/40 × 0.45)`), with its own
  high/medium/low thresholds (`>=0.80`/`>=0.60`) that don't match any other
  metric's boundaries. See [`range.md`](range.md#confidence).

- **Costs**: no confidence score at all — the closest analogue is
  `CostForecastService`'s `rateSource`/`dataSource` provenance strings,
  which say *where a number came from*, not *how much to trust it*. See
  [`costs.md`](costs.md#data-quality-rules--confidence).

At least **six** independently-authored confidence representations
counted so far (trips/energy's two-tier score, battery health's three —
see [`battery-health.md`](battery-health.md#confidence-models-catalogued-so-far-battery-health-alone-has-three) —
range's, and costs' provenance-label-not-confidence), none sharing
boundaries or meaning with another. This is the concrete case for
[`data-quality.md`](README.md) once all specs exist — not to force a single
number, but to at least document why they differ and whether any should
converge.

Before building a unified `data-quality.md` cross-cutting model, the
individual specs need to exist first — generalizing now would mean guessing
at commonalities instead of verifying them.

## Formula versioning

**Not implemented anywhere.** No `energy-v1`, `battery-health-v1`, etc. tag
exists in the Prisma schema or in code. This is the one gap that shows up
identically in every metric spec written so far (see each spec's "Algorithm
version" section).

Convention to adopt once formulas actually start changing (not yet applied
to any table): a `<metric>Version` string column alongside the stored value,
defaulted to `'v1'` for all historical rows retroactively when the column is
added, so a future `v2` never silently reinterprets old numbers. This is a
schema decision, not a documentation one — it belongs in the calculation
engine work, not in these spec files.
