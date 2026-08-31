# EVPulse Mobile Product & UX Design Specification

Status: **Design specification only. No runtime code has been changed.** Nothing in `apps/mobile/src` or
`apps/web/src` has been touched by this document — it exists to get design direction agreed before any P0
implementation begins (see §8). Companion documents: [`MOBILE_DESIGN_TOKENS.md`](./MOBILE_DESIGN_TOKENS.md),
[`MOBILE_SUBSCRIPTIONS.md`](./MOBILE_SUBSCRIPTIONS.md).

Scope note: the audit (§1) covers `apps/mobile` in full plus the relevant parts of `apps/web` (which is
considerably more feature-complete — i18n, subscriptions, insight confidence scoring, vehicle commands — none of
which exist on mobile yet). The IA, design system, and wireframes below target **mobile first**, and are written
so the same tokens/IA/component contracts extend to web without a second redesign — web mostly needs to catch up
to its *own* existing data model in the UI, mobile needs to catch up to both.

---

## Phase 1 — UX Audit

### 1.1 Screen-by-screen table

| Screen | Current purpose | UX problem | Data available (unused today) | Design recommendation | Priority |
|---|---|---|---|---|---|
| Home (`(tabs)/index.tsx`) | Live SOC/range/state dashboard, 2×2 metric grid | Answers "what is my car doing" but not "what should I do" — no today-summary, no active-charge card, no alerts, no insight. `0%`/`0 km` flashes before first load (no skeleton). Discards backend `dataQuality` field, computes its own cruder online/offline boolean. | `dataQuality: REALTIME/DELAYED/STALE/OFFLINE`, `power` field (both read via `as any` casts already, i.e. fetched but untyped/unused), `TripsTodaySummary`, `ChargingSummary`, `CostSummary` (all exist on web via `useVehicleAggregates`), insight feed (`lib/insights.ts`, web-only) | Rebuild as the "what's my car doing, what do I do next" screen per §2.2 — hero state, Today summary, one alert slot, one insight slot | **P1** |
| Trips (`(tabs)/trips.tsx`) | Trip list + map preview + aggregate stats | Map overlay text can overflow/overlap (no `numberOfLines` clamp on `mapOverlayText`, 4px vertical padding). No outlier/low-quality-GPS flagging — a glitched trip renders as a normal "⚡ High" efficiency badge. Average efficiency stat is skewed by unfiltered outliers. No error state (failed fetch renders identical to "no trips"). | Web's `trips` i18n block reveals a whole unbuilt feature surface: date-range filters (7d/30d/90d presets), parking-gap/vampire-drain detection, a "backfill" data-repair action — none ported to mobile. `Trip.startBattery/endBattery/startTemp/endTemp`, `TripPoint[]` per-point route detail. | Rename to **Drive**; add outlier/confidence badge per trip (§4.2), fix map overlay, add error state, port date filters | **P1** (map bug is P0-adjacent, see below) |
| Charge (`(tabs)/charging.tsx`) | Charging session list + active-session card + aggregate stats | Currency hardcoded to `€` even though `SessionRow.currency` is fetched and ignored (latent bug for non-EUR sessions). No error state. No tariff/home-vs-Supercharger cost breakdown beyond a type badge. | `ChargingSession.chargerName`, `energyRateKw`, `latitude/longitude/address` (session location, unused) | Rename to **Charge**; use `session.currency` for formatting; add tariff source + home/Supercharger cost split (§2.2); add error state | **P1** |
| Stats (`(tabs)/analytics.tsx`) | Battery health, SOH trend chart, driving efficiency, charging stats | Charts render with zero confidence/sample-size messaging — a 2-sample SOH trend looks as authoritative as a 200-sample one. Mobile's local `HealthPayload` type only captures 4 of ~20 fields the backend's real `BatteryHealth` type exposes, silently dropping `confidenceScore`, `isEstimate`, `baselineConfidence`, etc. Partial-fetch-failure looks identical to "no data" (only shows an error if *both* health and degradation queries fail). Chart axis labels at 9px, below any usable minimum. | `BatteryHealth.confidenceScore`, `lowData`, `baselineConfidence('HIGH'/'MEDIUM'/'NONE')`, `baselineHighKwh/baselineMediumKwh`, `cycles`, `tripSoh/chargingSoh/ratedRangeSoh`; web's `usePeriodComparison` minimum-N-of-6 gating pattern (unused on mobile) | Rename to **Insights**; type the full `BatteryHealth` shape; add confidence badge + methodology explainer per chart (§4.1); adopt the min-N gating pattern from web | **P1** (data-trust fixes are **P2**) |
| Settings (`(tabs)/settings.tsx`) | Vehicle selector, Tesla OAuth link, biometric toggle, sign out | **Confirmed bug:** the only tab screen with no `useSafeAreaInsets`/top-inset handling — title sits 16px below the physical top edge and overlaps the status bar/Dynamic Island. No error state for a failed vehicle fetch. No empty state for zero linked vehicles. Five `Alert.alert()` dialogs entirely in hardcoded English (OS-level, especially need i18n). No push-notification status shown (registration fails silently, per `usePushNotifications.ts`). | Web's `User.preferences` (`theme`, `units`, `timezone`, `language`) — mobile's `UserProfile` has no preferences at all; web's full `Notification` inbox model, `PremiumGate`/subscription state — none surfaced on mobile | Rename to **More**; fix safe-area (P0); restructure per §2.2 (Vehicle / Subscription / Notifications / Automations / Privacy / Security / Language·Units / Tesla / Help) | **Safe-area fix: P0.** Restructure: **P1** |
| Login (`(auth)/login.tsx`) | Email/password sign-in | Minimal but functional; no branding shown beyond the "EVPulse" text label — no wordmark treatment. Generic error text undistinguished (network vs. auth vs. validation all render the same red line). | — | Add wordmark placement (per tokens doc §9), differentiate error causes | **P2** |
| Auth callback (`(auth)/callback.tsx`) | Debug dump of OAuth deep-link params | Explicitly a dev/debug screen per its own source comment; flagged in `EAS_APP_STORE_CHECKLIST.md` as not fully wired for a native redirect (currently in-app-browser + polling, not a true deep-link completion). Not user-facing polish in scope. | — | Leave as dev tool; do not polish visually. Resolve the underlying OAuth redirect gap as a **backend/infra** item, out of this design scope. | **P3+ / infra, not design** |
| Root gate (`app/index.tsx`) | Auth/session bootstrap → redirect | Blank spinner on every cold start — no wordmark, missed branding moment. | — | Show wordmark on the splash→gate transition (tokens doc §9) | **P2** |
| Root layout (`app/_layout.tsx`) | Providers: SafeAreaProvider, QueryClientProvider, StatusBar, telemetry socket, push | Structurally sound — `SafeAreaProvider` is correctly mounted app-wide, so the Settings bug is a per-screen omission, not a missing provider. No i18n provider mounted (web has one via `providers/I18nProvider.tsx`; mobile has zero i18n dependency). | — | Add i18n provider (i18next + `react-i18next`, mirroring web's `apps/web/src/lib/i18n.ts` wiring) as part of **P0** | **P0** (i18n plumbing) |
| Biometric gate (`hooks/useBiometricGate.tsx`) | App-lock overlay on background→foreground | Functional; hardcoded English strings (including native biometric-prompt strings, which are especially visible/OS-level) | — | Route all strings through i18n | **P1** |

### 1.2 Cross-cutting findings (not tied to one screen)

- **No shared component library.** `apps/mobile/src` has no `components/` directory at all — every screen
  reimplements its own cards, badges, and rows from scratch with near-duplicate `StyleSheet.create()` blocks.
  This is *why* Settings drifted out of sync on safe-area handling and bottom padding while the other four tabs
  stayed consistent with each other — there's no single source of truth to inherit from. Phase 3 (§3.3) is a
  direct answer to this.
- **Data-quality signal exists in the API and is discarded on mobile.** The backend already returns
  `dataQuality: REALTIME|DELAYED|STALE|OFFLINE` (web reads and gates insights on it) and a rich
  `BatteryHealth.confidenceScore`/`baselineConfidence` model. Mobile's local, narrower TypeScript interfaces
  simply don't declare these fields, so even where the API sends them, mobile drops them on the floor. This is
  the direct root cause of complaint #6 (charts can create false alarm) — the confidence data to prevent that
  already exists server-side.
- **No i18n on mobile at all**, despite web having a mature, near-complete three-locale (`en`/`de`/`ru`) i18next
  setup with parallel key structures. This is a plumbing gap (zero i18n dependency installed), not a translation
  gap — de/ru content largely already exists in web's locale files and can inform mobile's copy once i18n is
  wired.
- **Error states are inconsistent to nonexistent.** Home and Stats show a minimal inline error hint; Trips,
  Charge, and Settings show *no* error state — a failed fetch is visually identical to "you have no data," which
  actively misleads the user (they'll conclude "I have no trips" rather than "the app couldn't load my trips").
- **No vehicle commands, no automations, no notification inbox, no subscription awareness** exist on mobile at
  all — all four are real, built features on web (`useVehicleCommands`, `Automation*` types, `Notification` type,
  `useSubscription`) that mobile hasn't caught up to. These are addressed by the new **Drive/Charge/Insights/More**
  IA in Phase 2, not bolted onto the current five screens.
- **No `SafeArea`-driven `<Screen>` primitive** — four of five tab screens independently reimplement
  `useSafeAreaInsets()` + `paddingTop: insets.top`, and the fifth (Settings) simply forgot. A shared primitive
  makes this structurally impossible to omit going forward (tokens doc §7).

---

## Phase 2 — Product information architecture

### 2.1 Navigation

Five tabs → five tabs, renamed and re-scoped around what the owner actually asks, not around what data model
each screen happens to query:

```
Home   Drive   Charge   Insights   More
```

Rationale for keeping five (not collapsing to four): the current IA already separates trips from charging, and
that split matches how a Tesla owner actually thinks about "where did I go" vs. "what did charging cost me" —
merging them would save a tab but cost clarity. "Analytics/Stats" becomes **Insights** because the tab's job
isn't to show numbers, it's to explain them (battery health, cost forecast, AI reports) — "Insights" states the
job the way "Stats" doesn't.

### 2.2 Screen content specs

**Home** — answers "what's my car doing, and what do I do next":
1. Header: `VehicleStatusChip` (vehicle name + `dataQuality` dot, not a generic "online/offline" boolean)
2. `BatteryHeroCard` — SOC, range, charge/drive/park state, data-quality indicator on the card itself (not
   inferred client-side from a stale timestamp)
3. Today summary row — trips today, km driven, energy used (from `useVehicleAggregates`-equivalent, unbuilt on
   mobile today)
4. Active charge card (only rendered when charging — session progress, time-to-full, cost-so-far)
5. Critical alert slot (only rendered when one exists — low SOC, failed session, etc. — never an empty
   placeholder card)
6. One actionable insight (top-priority card from the insight feed, with a "See all" link to Insights — not a
   feed dumped onto Home)
7. Recent trip summary (most recent trip, condensed — full list lives in Drive)

No empty space: every card above either renders real content or doesn't render at all (no "you have no alerts!"
filler card) — the screen's height is allowed to vary run to run rather than padding itself out to fill a fixed
template.

**Drive** (renamed from Trips):
- Map (current/most-recent route)
- Filter row (date presets: 7d/30d/90d/custom — porting web's existing but mobile-absent filter feature)
- Trip list, each row carrying a confidence/outlier badge (§4.2) and cost/efficiency, not just efficiency
- Trip detail (tap-through): full route map, start/end battery & temp, efficiency with confidence context

**Charge**:
- Active session card (when charging)
- History list, home vs. Supercharger/public visually distinguished (not just a text badge)
- Tariff source shown per session (estimated vs. actual, home tariff vs. detected public rate)
- Cost summary (period totals, using `session.currency` correctly — fixes the hardcoded-€ bug)
- Charging efficiency / energy-loss card
- Charging schedule (Pro — automations-gated, see subscriptions doc)

**Insights** (renamed from Analytics/Stats):
- Battery health, led with a confidence badge, not a bare percentage
- Vampire drain (porting web's existing, mobile-absent feature)
- Driving efficiency, gated by the same minimum-sample rule web already applies elsewhere
- Cost forecast, with `rateSource`/`dataSource` provenance shown (matches web's `useCostForecast` shape)
- AI reports (Pro+) — each card follows the explainable structure in §4.4, never decorative
- "Explain this" affordance on every computed number (opens a plain-language methodology sheet)

**More** (renamed from Settings):
- Vehicle (current content, restructured)
- Subscription (plan, manage, restore — per subscriptions doc)
- Notifications (channel prefs + in-app inbox — porting web's `Notification` model)
- Automations (Pro+)
- Privacy / data export (never paywalled — subscriptions doc §7)
- Security / biometric (current content, i18n'd)
- Language / units / timezone (new — mobile has zero user preference storage today)
- Tesla connection (current OAuth linking content)
- Help / diagnostics

### 2.3 User flows

1. **New user onboarding** — Login screen (wordmark shown) → account created → empty-state Home ("Connect your
   Tesla to see live data" card, not a blank dashboard) → prompted straight into flow 2.
2. **Tesla OAuth connection** — More → Vehicle → "Connect Tesla" → in-app browser → Tesla auth → return to app →
   poll (existing 2s×12 pattern) → success toast → vehicle appears in Home.
3. **First telemetry data** — Home shows a loading skeleton (not `0%`/`0km`) until the first real socket message
   arrives, then crossfades in (`motion.base`, tokens doc §8) — the current flash-of-zero is eliminated here.
4. **Low SOC alert** — Push notification (if enabled) + Home critical-alert slot + Insights flags it in context —
   three surfaces, one alert object, no duplicated logic.
5. **Charging completed** — Push notification with session summary (kWh, cost, time) → tapping opens Charge →
   that specific session, not just the Charge tab root.
6. **Trip detail** — Drive list row tap → full-screen trip detail (map, efficiency + confidence badge, cost if
   home-charged-equivalent is computable) → back to list preserves scroll position and filter state.
7. **Battery-health explanation** — Insights → Battery Health card → "Explain this" → bottom sheet: current SOH,
   confidence badge + what confidence means, sample count, baseline method (`baselineConfidence`), "not enough
   data yet" state if `lowData` is true — never a bare number with no path to "why."
8. **Start subscription** — More → Subscription (or a `PremiumFeatureLock` tap-through from any gated card) →
   paywall (wireframe below) → StoreKit purchase → backend verification → entitlement refresh → gated content
   unlocks in place (no forced navigation away from where the user was).
9. **Subscription expiry** — Entitlement flips server-side → gated cards swap to `PremiumFeatureLock` in place →
   history views show the `ClampedBanner`-equivalent → no data loss, no forced logout (subscriptions doc §3).
10. **Restore purchase** — More → Subscription → "Restore Purchases" → StoreKit restore → backend re-verify →
    success/no-subscription-found state (subscriptions doc §4).
11. **Export/delete data** — More → Privacy → Export (async job, emailed link — matches typical GDPR export
    patterns) / Delete account (destructive — `ConfirmActionModal`, double confirmation, matches this project's
    own "risky action" bar for irreversible operations).

---

## Phase 3 — Design system

### 3.1 Brand

Covered in full in [`MOBILE_DESIGN_TOKENS.md`](./MOBILE_DESIGN_TOKENS.md) §1 and §9 (color rationale, logo
placeholder rule, splash/header/loading/empty-state placement). Summary: cyan/teal primary, restrained violet
secondary (shared with web's existing wordmark gradient), text-wordmark-only until a final mark exists, logo
appears at exactly two points in the product (splash, login) — not on every screen header.

### 3.2 Color / type / layout tokens

Covered in full in `MOBILE_DESIGN_TOKENS.md` (§2–§8). Not duplicated here.

### 3.3 Component system

New `apps/mobile/src/components/` directory (doesn't exist today — see audit §1.2). Every component below closes
a specific duplication or inconsistency the audit found; none are speculative.

| Component | Purpose | States | Variants | Empty/Loading/Error | Accessibility | Responsive | Data contract |
|---|---|---|---|---|---|---|---|
| `Screen` | Shared layout root — owns safe-area top inset + tab-bar-aware bottom padding (fixes the Settings bug structurally, tokens doc §7) | default, `scrollable` | — | n/a (layout only) | n/a | Applies `bp.expanded` max-width centering | `{ children, scrollable?: boolean, header?: ReactNode }` |
| `AppHeader` | Screen title + optional `VehicleStatusChip` | default | with/without chip | n/a | Title is an `h1`-role heading for screen readers | Title truncates before chip does at `bp.compact` | `{ title: string, chip?: ReactNode }` |
| `VehicleStatusChip` | Vehicle name + live data-quality dot (replaces the crude client-computed online/offline boolean) | realtime/delayed/stale/offline (maps to tokens doc §2.5) | — | offline → dot uses `color.quality.offline`, label reads "Last seen Xm ago" | Dot has an accessible label, not color-only signal (WCAG 1.4.1) | — | `{ vehicleName: string, dataQuality: 'REALTIME'\|'DELAYED'\|'STALE'\|'OFFLINE', lastSeenAt?: string }` |
| `BatteryHeroCard` | Home's primary SOC/range/state display | charging, driving, parked, sleeping, offline | — | Loading → skeleton (§below), never `0%` flash; Error → inline retry, not blank | SOC announced as "Battery 62 percent, 310 kilometers range" (one VoiceOver utterance, not 3 separate labels) | Hero number caps Dynamic Type scale at 1.3× (tokens doc §3.3) | `{ soc, rangeKm, state, dataQuality, powerKw? }` |
| `MetricCard` | Generic labelled-value card (grid item) | default, pressed (if tappable) | 1-col / 2-col / 3-col (per `bp`) | Loading → skeleton block matching final dimensions (prevents layout shift) | Label read before value | Grid column count driven by breakpoint, not per-screen logic | `{ label, value, unit?, icon?, onPress? }` |
| `InsightCard` | One explainable AI/rule insight | info/success/warning/danger (maps `severity`) | with/without confidence badge | n/a — feed always has ≥1 card (the existing "all-good" fallback pattern from `lib/insights.ts`, ported) | Confidence stated in text, not color-only | — | `{ severity, title, description, reasons?: string[], confidence?: number, action?, params? }` — mirrors web's existing `Insight` type exactly, no mobile-only reshaping |
| `AlertCard` | Critical/actionable alert (Home slot, Insights list) | info/warning/critical | dismissible / persistent | n/a (only renders when an alert exists) | Announced immediately on appear if critical (accessibility live region) | — | `{ severity, title, message, actionLabel?, onAction? }` |
| `EmptyState` | "Nothing here yet" — replaces ad hoc empty `Text` lines scattered per screen today | — | icon+title+body, optional CTA | n/a | — | — | `{ icon, title, body, actionLabel?, onAction? }` |
| `Skeleton` / `LoadingState` | Shape-matched loading placeholder | pulsing | card / list-row / chart | n/a | Marked `accessibilityElementsHidden` (skeletons shouldn't be read aloud) | — | `{ variant: 'card'\|'row'\|'chart', height? }` |
| `ErrorState` | Failed-fetch state — **new**, closes the audit's biggest gap (Trips/Charge/Settings have none today) | — | inline (small, within a card) / full-screen | n/a | Retry button is the first focusable element | — | `{ message, onRetry }` |
| `ChartCard` | Wraps a chart with title + **mandatory** confidence/sample-size line (§4.1) — no chart ships without this wrapper | default | line / bar | Insufficient-sample → shows "not enough data yet" state instead of a misleadingly smooth curve | Chart itself has a text-equivalent summary for screen readers (not just an SVG) | Axis label minimum size = `type.micro` (11px, not today's 9px) | `{ title, confidence?: 'high'\|'medium'\|'low', sampleCount?, data, kind }` |
| `MapCard` | Route/location preview | default | with/without overlay caption | No-GPS-data → `EmptyState`, not a blank map | Route summarized in text alongside the visual map | Overlay caption clamps to 2 lines with a scrim gradient sized to content, not a fixed 4px pad (fixes the audit's overlap bug) | `{ region, polyline?, caption?, quality?: 'good'\|'low-gps' }` |
| `SubscriptionBadge` | Plan indicator (Free/Pro/Pro+) | — | 3 plan variants (Fleet reserved, not surfaced in mobile UI — subscriptions doc §1) | — | — | — | `{ plan: 'FREE'\|'PRO'\|'PRO_PLUS' }` |
| `PremiumFeatureLock` | In-place lock over gated content (replaces "hide the section entirely" — user should see *what* they're missing) | — | per-feature copy (mirrors web's `PremiumGate` `PremiumFeature` union) | n/a | Lock icon has text label, not icon-only | — | `{ feature: 'automations'\|'ai-reports'\|'export'\|'advanced-confidence', requiredPlan: 'PRO'\|'PRO_PLUS', onUpgrade }` |
| `BottomSheet` | Reusable sheet (battery-health explainer, filters, restore-purchase result) | — | fixed-height / content-height | — | Focus trapped while open, dismiss announced | Full-width on `bp.compact/regular`, capped width on `bp.expanded` | `{ children, onDismiss }` |
| `ConfirmActionModal` | Double-confirmation for destructive/risky actions (delete account, disconnect Tesla) | — | single-confirm / type-to-confirm (for delete account specifically) | — | Focus starts on Cancel, not the destructive action, to prevent accidental confirm | — | `{ title, body, confirmLabel, destructive: boolean, onConfirm }` |
| `Toast` | Transient confirmation (vehicle linked, restore complete) | success/error/info | — | Auto-dismiss ≥4s (enough time to read on a screen reader) | Announced as a live region | — | `{ message, kind }` |
| `SegmentedControl` | Date-range presets (Drive filters), plan billing-period toggle | — | — | — | Behaves as a radio group for VoiceOver | — | `{ options: string[], value, onChange }` |
| `FilterChip` | Applied-filter indicator (Drive date range, Insights period) | active/inactive | — | — | — | — | `{ label, active, onPress }` |

---

## Phase 4 — Data trust

### 4.1 Battery health

- Every SOH/degradation figure ships with a confidence badge: **high** (`baselineConfidence: 'HIGH'`, ≥10 full
  charges per the backend's own `baselineHighKwh` methodology), **medium** (`baselineConfidence: 'MEDIUM'`,
  ≥15 partial charges), or **low/not-enough-data** (`lowData: true`, `confidenceScore < 0.6`) — these thresholds
  already exist in the backend's `BatteryHealth` type; mobile currently just doesn't type or render them (audit
  §1.1).
- Sample count (`cycles`, or `DegradationPayload.samples`) is always shown next to the confidence badge, in
  plain language: "Based on 4 charge cycles — low confidence" rather than a bare number that implies precision it
  doesn't have.
- "Not enough data" is a real, designed state (not an edge case tacked on) — appears in place of the SOH trend
  chart when `lowData` is true, with a plain-language explanation of what's still needed ("Keep driving and
  charging normally — we need a few more full charges to estimate this confidently").
- Methodology is one tap away ("Explain this" → bottom sheet, flow 7 in §2.3) — states which of `tripSoh`,
  `chargingSoh`, `ratedRangeSoh` contributed, in plain language, not as raw field names.

### 4.2 Trips

- Outlier detection: a trip is flagged (not hidden) when its `efficiencyWhkm` falls outside a sane range for its
  `distanceKm` (very short trips are naturally noisy — mirrors the audit's finding that web's own insight engine
  already requires `distanceKm > 2` before judging efficiency; the same floor applies here) or when GPS point
  density/gaps in the polyline suggest incomplete route capture.
- Flagged trips get a small "Unusual — tap for details" badge, not silent exclusion — the trip still counts as a
  trip, it's just visually marked as not representative before it's allowed to skew an "avg efficiency" stat.
- **Aggregate stats (avg efficiency, best session) explicitly exclude flagged outliers from the calculation**,
  and state that they did ("Avg. efficiency (12 of 14 trips)") — this directly closes the brief's example
  complaint: a `9 Wh/km` "best session" born from a GPS glitch never gets to claim the "best" label unqualified.
- Incomplete-route state: if a trip's polyline has large gaps, the map shows the partial route with a visibly
  dashed/faded gap rather than silently drawing a straight line across missing data (which looks like a real
  driven segment but isn't).
- Low-quality-GPS state: reuses `MapCard`'s `quality: 'low-gps'` variant (§3.3) — caption reads "GPS signal was
  weak during this trip; distance/route may be approximate."
- Manual review/merge is a **future** affordance (fragmented trips that are really one trip split by a signal
  drop) — flagged here as a real problem the outlier badge surfaces, but the merge *action* itself is out of
  scope for this pass; note it for a later backlog item once outlier detection ships and real-world fragmentation
  rates are visible.

### 4.3 Charging

- Cost is always labeled **estimated** vs. **actual** — actual when `costTotal`/`manualCost` is present from a
  known tariff, estimated when derived from a default rate (mirrors web's `CostForecastResponse.rateSource:
  'sessions'|'settings'|'default'|'override'` — reuse this enum verbatim, don't invent a mobile-only one).
- Tariff source is shown per session or period ("Estimated at your default rate of €0.32/kWh" vs. "Actual cost
  from linked session data").
- Home vs. Supercharger/public is a visual distinction (icon + label), not just a text badge buried in a row —
  matters because cost-per-kWh and "was this predictable" both hinge on it.
- Efficiency/energy-loss: charging efficiency (energy added to battery vs. energy drawn from the wall/charger, if
  derivable) is shown as its own figure, distinct from driving efficiency — these are two different physical
  quantities and the current app has no charging-side efficiency concept at all.
- Incomplete session state: a session with no `endedAt` (still `status: 'charging'`) is the **active session
  card**, not a list row with blank fields — the list never shows a row with missing data dressed up as complete.

### 4.4 AI

Every AI/insight card follows a fixed structure — **observation → reason → confidence → action → source data** —
matching the shape web's `Insight` type already carries (`title`/`description`, `reasons[]`, `confidence`,
`action`, `params`) rather than inventing a new one for mobile:

- **Observation**: what was seen ("Efficiency was 30% worse than usual over the last 3 trips")
- **Reason**: why, if knowable ("Outside temperature averaged -2°C")
- **Confidence**: stated in plain language, tied to sample size, never omitted
- **Action**: what to actually do, if anything ("This is expected in cold weather — no action needed" is a valid
  action)
- **Source data**: what it's based on, one tap away (links to the underlying trips/sessions)

No generic praise content ("Great job!") ships unless it carries real information — the existing web fallback
"all good" card is acceptable *only* because it's a designed empty-state ("nothing needs your attention right
now"), not decorative flattery; mobile's port of this must keep that framing, not turn it into cheerleading copy.

---

## Phase 5 — Text wireframes

Notation: `[ ]` = card boundary, `···` = scrollable content continues, `<Tab>` = active tab bar item.

### Home
```
┌─────────────────────────────────┐
│ EVPulse Y  · ● realtime          │  ← AppHeader + VehicleStatusChip
├─────────────────────────────────┤
│ [  62%              ⚡ Charging  ]│  ← BatteryHeroCard
│ [  310 km range                 ]│
│                                   │
│ [ Today: 2 trips · 41 km · 8kWh ]│  ← Today summary
│                                   │
│ [ ⚡ Charging — 22 kWh · €6.40   ]│  ← Active charge (conditional)
│ [   full in ~1h 40m              ]│
│                                   │
│ [ ⚠ SOC will drop below 20%     ]│  ← Alert (conditional)
│ [   before tomorrow's commute    ]│
│                                   │
│ [ 💡 Efficiency down 30% —       ]│  ← One insight
│ [   cold weather (-2°C). Normal. ]│
│ [   See all insights →           ]│
│                                   │
│ [ Last trip: Home → Office       ]│
│ [   12 km · 178 Wh/km            ]│
└─────────────────────────────────┘
 <Home>  Drive   Charge  Insights  More
```

### Drive
```
┌─────────────────────────────────┐
│ Drive                            │
├─────────────────────────────────┤
│ [        map (route)          ] │
│ [  Home → Office · 12 km       ] │  ← caption clamped 2 lines
│                                   │
│ [7d] [30d] [90d] [Custom]        │  ← SegmentedControl / FilterChips
│                                   │
│  Today
│ [ Home → Office   12km  178Wh/km]│
│ [ Office → Home   13km  ⚠Unusual]│  ← outlier badge
│  Yesterday
│ [ ··· ]
└─────────────────────────────────┘
```

### Charge
```
┌─────────────────────────────────┐
│ Charge                           │
├─────────────────────────────────┤
│ [ ⚡ Charging now                ]│
│ [  22/75 kWh · €6.40 (actual)   ]│
│ [  Home · full ~1h 40m          ]│
│                                   │
│  This month: 320 kWh · €94.10    │
│                                   │
│  Home  ▮▮▮▮▮▮▯▯ 78%               │
│  Public ▮▮▯▯▯▯▯▯ 22%              │
│                                   │
│ [ Yesterday · Home · 41kWh €9.80]│
│ [ Aug 28 · Supercharger · est.  ]│
│ [   62kWh · ~€21.70 (estimated) ]│
└─────────────────────────────────┘
```

### Insights
```
┌─────────────────────────────────┐
│ Insights                         │
├─────────────────────────────────┤
│ [ Battery Health      🟢 High   ]│  ← confidence badge
│ [  SOH 96.2% · -0.3%/mo         ]│
│ [  Based on 14 full charges     ]│
│ [  Explain this →                ]│
│                                   │
│ [ Vampire drain: 0.8%/night     ]│
│ [  Normal for this model         ]│
│                                   │
│ [ Cost forecast: €41/mo         ]│
│ [  Based on session data (high  ]│
│ [  confidence)                   ]│
│                                   │
│ [ 🔒 AI Reports — Pro+          ]│  ← PremiumFeatureLock
│ [   Unlock →                     ]│
└─────────────────────────────────┘
```

### More
```
┌─────────────────────────────────┐
│ More                             │
├─────────────────────────────────┤
│  Vehicle
│ [ Model Y · Connected ✓         ]│
│  Subscription
│ [ Pro plan · Renews Sep 15      ]│
│  Notifications
│  Automations              🔒 Pro │
│  Privacy & data export           │
│  Security (Face ID: On)          │
│  Language & units                │
│  Tesla connection                │
│  Help & diagnostics              │
└─────────────────────────────────┘
```

### Subscription paywall
```
┌─────────────────────────────────┐
│           ✕                      │
│         EVPulse Pro+              │
│  See everything your car tells   │
│  you — automations, AI reports,  │
│  unlimited alerts.                │
│                                   │
│ [ Monthly        Annual (26%off)]│  ← two equal cards, no dark-pattern default
│ [ €8.99/mo        €79.99/yr     ]│
│                                   │
│  ✓ Automations   ✓ Unlimited alerts
│  ✓ AI reports    ✓ CSV/API export
│                                   │
│  Try 14 days free, then €8.99/mo.│
│  Cancel anytime in Settings.      │
│                                   │
│ [        Start free trial       ]│
│  Restore purchases                │
└─────────────────────────────────┘
```

### Expired subscription
```
┌─────────────────────────────────┐
│ Insights                         │
├─────────────────────────────────┤
│ [ ⓘ Your Pro plan ended Aug 20. ]│
│ [   Your data is safe. Showing  ]│
│ [   the last 7 days.            ]│
│ [   Resubscribe →                ]│
│                                   │
│ [ Battery Health      🟢 High   ]│  ← Pro/Free-tier features unaffected
│ [  ··· ]                         │
│                                   │
│ [ 🔒 AI Reports — Pro+          ]│  ← was unlocked, now locked, data intact
│ [   Resubscribe to unlock →      ]│
└─────────────────────────────────┘
```

### Battery health detail (bottom sheet, flow 7)
```
┌─────────────────────────────────┐
│  Battery Health          ✕       │
├─────────────────────────────────┤
│  96.2% SOH          🟢 High confidence
│  -0.3% / month                   │
│                                   │
│  Based on 14 full charge cycles  │
│  over the last 92 days.          │
│                                   │
│  How we calculate this:          │
│  We compare your battery's       │
│  measured capacity against its   │
│  original 75 kWh rating using    │
│  full (>90%) charge sessions.    │
│                                   │
│  Trip-based estimate:   96.4%    │
│  Charge-based estimate: 96.0%    │
│  Rated-range estimate:  96.1%    │
└─────────────────────────────────┘
```

### Trip detail
```
┌─────────────────────────────────┐
│ ← Home → Office                  │
├─────────────────────────────────┤
│ [          map (full route)   ] │
│                                   │
│  12.4 km · 22 min · 178 Wh/km    │
│  Battery: 68% → 65%              │
│  Outside: 4°C                    │
│                                   │
│  This trip looks normal — no     │
│  confidence flags.               │
│                                   │
│  (if flagged instead:)           │
│  ⚠ Unusual efficiency — GPS      │
│  signal was weak for part of     │
│  this trip. Distance may be      │
│  approximate.                    │
└─────────────────────────────────┘
```

---

## Accessibility rules

- WCAG AA contrast floor enforced via tokens (design tokens doc §2.3) — `color.text.tertiary` is the darkest text
  gray permitted anywhere; this needs to be run through an automated checker (Stark/axe or equivalent) once
  implemented, not just eyeballed.
- Color is never the only signal — every `color.quality.*`/`color.confidence.*`/severity use is paired with a
  text label (VehicleStatusChip, InsightCard, AlertCard contracts in §3.3 all specify this explicitly).
- Dynamic Type respected everywhere except the capped-scale hero number (tokens doc §3.3), which caps rather than
  disables scaling.
- VoiceOver: composite values announced as one utterance (`BatteryHeroCard` contract) rather than reading out
  4 separate `Text` nodes as 4 disconnected announcements — a real regression risk with the current unstructured
  approach where SOC/range/state are three sibling `Text`s with no grouping.
- Destructive actions (`ConfirmActionModal`) default focus to Cancel, never to the destructive button.
- Skeletons are hidden from screen readers (`accessibilityElementsHidden`) so loading states don't get read aloud
  as if they were content.
- Minimum touch target 44×44pt on every interactive element (current chip/badge touch targets in charging.tsx
  and trips.tsx are visually smaller than this in places — e.g. the 8×8 status dot has no separate larger hit
  area — needs auditing per-component during implementation, not just specified here).

## Responsive rules

**Reality check, read first:** `app.json` currently sets `orientation: "portrait"` and `supportsTablet: false`.
**P0 and P1 design and build for portrait iPhone only** — that's the actual target device shape for the whole
foundation and Home-rebuild phases, full stop. `bp.expanded` (iPad/landscape) below is a **reserved token and a
future milestone, not a P0/P1 deliverable** — it exists now so the layout primitives (`Screen`, breakpoint-driven
grids) don't have to be rebuilt later, but no screen ships an iPad or landscape layout until `supportsTablet` and
`orientation` are deliberately changed in `app.json`, which is **its own separate decision** requiring a new
native build and its own test pass — not something that happens as a side effect of a P1+ phase landing.

Full breakpoint values in design tokens doc §6. Behavioral summary:

- `bp.compact` (iPhone SE/mini): metric grids collapse to 1 column before they'd render sub-150pt cards; nothing
  is ever cut off, only re-flowed. **In scope for P0/P1** — this is still portrait iPhone.
- `bp.regular` (standard iPhones): current baseline design target, 2-column grids. **In scope for P0/P1.**
- `bp.expanded` (iPad / split view / landscape): content max-width 680pt centered (never full-bleed edge-to-edge
  text on a 1024pt-wide iPad); Drive shows map + list side-by-side instead of stacked; metric grids go 3–4
  columns. **Not in scope until `supportsTablet` is explicitly flipped** — see the reality-check note above.
- Landscape on iPhone: locked out by `orientation: "portrait"` today and **stays locked out through P0–P3** of
  this backlog. The layout primitives are written so landscape *could* be enabled later without a second
  redesign, but "could later" is not a claim that any current phase ships it.

---

## Phase 6 — Phased implementation backlog

- **P0 — Foundation Sprint (portrait iPhone only; no Tesla API, DB, billing, or infra changes):**
  1. `<Screen>` layout primitive
  2. Safe-area fix on every screen (closes the confirmed Settings bug)
  3. Adaptive layout helpers (`useWindowDimensions`-driven breakpoint logic per tokens doc §6 — implemented now,
     but only ever exercised at `bp.compact`/`bp.regular` since `bp.expanded` has nothing to render into until
     tablet support is a separate decision)
  4. Mobile i18n foundation: i18next + react-i18next wired with en/de/ru (mirroring web's existing
     `apps/web/src/lib/i18n.ts` setup), locale files seeded from web's existing translations where keys overlap
  5. Brand tokens landed (design tokens doc, full file)
  6. Temporary EVPulse wordmark (text-only, tokens doc §9) on splash + login + root-gate spinner
  7. Shared `Card` / `MetricCard` / `SectionHeader` / `EmptyState` / `ErrorState` — the minimal component subset
     needed to retrofit the existing 5 screens without a full rebuild; the rest of §3.3's component set (charts,
     sheets, subscription components, etc.) lands in later phases as their consuming screens are rebuilt
  8. Settings → **More** (rename + safe-area fix; full restructure per §2.2 stays P1)
  9. Analytics → **Insights** (rename only; confidence badges and full data-trust rework stay P2)
  10. Fix the Trips map-overlay text clipping bug and the Home `0%`/blank flash on first load (both are
      structural/bug fixes achievable with the `Screen`/`ErrorState`/skeleton primitives already in this phase,
      not full screen rebuilds)

  **Explicitly excluded from P0:** StoreKit / real payments, any Stripe changes, backend billing refactor, iPad
  support, landscape support, automations, Tesla vehicle commands, Home Assistant, AI reports, the full Drive
  (trips) screen rebuild, and any change to Prisma/Docker/telemetry. P0 is a foundation-and-safe-fixes pass that
  is visible and shippable on its own without touching anything load-bearing in the already-recovered production
  infrastructure.
- **P1 — Premium Home + full screen rebuilds:** rebuild Home per §2.2 (Today summary, active charge, alert slot,
  one insight); rebuild Drive/Charge/More to their full §2.2 content specs (beyond the P0 renames); build out the
  remainder of the shared component set (§3.3) that the rest of the backlog depends on; fix the Charge
  hardcoded-€ bug as part of this pass (the map-overlay clipping fix already landed in P0).
- **P2 — Trusted data and charts:** confidence badges on battery health, outlier flagging on trips, tariff-source
  labeling on charging costs, `ChartCard`'s mandatory confidence line, `ErrorState` added to every screen that
  currently lacks one (Trips, Charge, Settings).
- **P3 — Subscription UI + backend entitlements:** paywall, expired-state, restore-purchase UI against the
  canonical `FREE | PRO | PRO_PLUS | FLEET` model (subscriptions doc §0, already decided); backend
  `/billing/mobile/verify-transaction` + `/billing/me`-equivalent for mobile, sharing the same entitlement shape
  web's `useSubscription()` already reads; web's `UpgradeModal.tsx` pricing/copy updated to match §1 of the
  subscriptions doc as part of this phase (currently still shows the old `PRO €4.99/FLEET €19.99` Stripe copy).
- **P4 — StoreKit/TestFlight:** real purchase flow via StoreKit 2 + direct App Store Server API integration
  (default — subscriptions doc §5; RevenueCat only if that trade-off is deliberately re-opened at this point),
  App Store Server Notifications V2 ingestion, sandbox + TestFlight verification (cannot be done in Expo Go —
  requires a Development Build at minimum).
- **P5 — Widgets, Live Activity, Apple Watch:** stretch scope, not detailed further here — revisit once P0–P4 are
  shipped and real usage data exists to prioritize against.

## Existing mobile files that will need to change

(Compiled from the audit; none of these have been touched.)

```
apps/mobile/src/theme/tokens.ts                          — replaced per design tokens doc
apps/mobile/src/app/_layout.tsx                           — add i18n provider
apps/mobile/src/app/index.tsx                             — add wordmark to bootstrap spinner
apps/mobile/src/app/(app)/(tabs)/_layout.tsx              — rename tabs (Drive/Charge/Insights/More), new icons
apps/mobile/src/app/(app)/(tabs)/index.tsx                — full rebuild (Home)
apps/mobile/src/app/(app)/(tabs)/trips.tsx                — rebuild + rename (Drive); fix map overlay bug
apps/mobile/src/app/(app)/(tabs)/charging.tsx             — rebuild + rename (Charge); fix currency bug
apps/mobile/src/app/(app)/(tabs)/analytics.tsx            — rebuild + rename (Insights); type full BatteryHealth
apps/mobile/src/app/(app)/(tabs)/settings.tsx             — P0 safe-area fix, then rebuild + rename (More)
apps/mobile/src/app/(auth)/login.tsx                      — wordmark, i18n, error-cause differentiation
apps/mobile/src/app/(auth)/callback.tsx                   — out of design scope (infra/backend issue)
apps/mobile/src/hooks/useBiometricGate.tsx                — i18n strings
apps/mobile/src/hooks/usePushNotifications.ts             — surface registration failure in UI (More screen)
apps/mobile/src/services/api.ts                           — add typed endpoint/response layer (currently untyped ad hoc calls per screen)
apps/mobile/src/features/vehicles/useVehicleSummary.ts    — extend to fetch dataQuality, aggregates
apps/mobile/app.json                                      — NOT touched in P0-P3 (portrait/no-tablet stays as-is; NSLocationWhenInUseUsageDescription + Android location perms flagged as likely-unused, see APP_STORE_CHECKLIST.md); i18n-related config only
(new) apps/mobile/src/components/*                        — full component library per §3.3
(new) apps/mobile/src/locales/{en,de,ru}.json              — mirror apps/web/src/locales structure
(new) apps/mobile/src/hooks/useSubscription.ts             — mirrors web's hook shape (P3)
(new) apps/mobile/src/services/billing.ts                  — StoreKit 2 / App Store Server API integration (P4, default per subscriptions doc §5)
```

Backend (NestJS) and infra changes referenced in the subscriptions doc (§5–6: receipt verification endpoints,
App Store Server Notifications ingestion) are **not** included in this file list — those are backend/API changes
requiring separate confirmation, per your instruction not to touch backend/Docker/DB/Tesla API/Git without it.
