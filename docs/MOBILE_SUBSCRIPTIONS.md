# EVPulse Mobile Subscriptions

Status: **Specification only — no billing code, StoreKit integration, or backend entitlement changes have been
made.** Companion to [`MOBILE_PRODUCT_DESIGN.md`](./MOBILE_PRODUCT_DESIGN.md).

**Revision note:** this document originally proposed a `Free / Drive / Pro / Extra Vehicle` plan structure
independent of web's existing `FREE / PRO / FLEET`. That was flagged in §0 as needing an explicit decision before
implementation. The decision has been made — **one canonical entitlement model, `FREE | PRO | PRO_PLUS | FLEET`,
shared by web and mobile** — and this revision replaces the old structure everywhere below. `Drive` is dropped as
a plan name entirely (it also collided with the **Drive tab** in the new IA, which keeps its name — that
collision is resolved as a side effect of this change, not a separate fix). §5's payment-rail recommendation is
also revised: **StoreKit 2 + App Store Server API + NestJS verification is the default**, not RevenueCat — see §5.

## 0. Canonical entitlement model

One enum, shared by both platforms and both payment rails:

```ts
type Plan = 'FREE' | 'PRO' | 'PRO_PLUS' | 'FLEET'
```

| | Web (Stripe) | Mobile (Apple IAP) |
|---|---|---|
| Payment rail | Stripe Checkout (`createCheckoutSession`) | StoreKit 2 (required by Apple §3.1.1 — see §5) |
| Plans purchased | Same four-value enum | Same four-value enum |

Both storefronts sell entitlements against the *same* `Plan` enum — there is no separate mobile-only tier
structure to keep in sync with web's. The backend's job is to resolve a Stripe subscription or an Apple
transaction to the same `Plan` value and the same `/billing/me` shape (§6), regardless of which storefront sold
it. Web's current `UpgradeModal.tsx` (`PRO €4.99/mo`, `FLEET €19.99/mo`) and its plan-feature-bullet copy need to
be updated to match the pricing in §1 as part of this reconciliation — flagging that as a **web** follow-up, not
in scope for the mobile file list in the product design doc.

UI is free to use a friendlier marketing label for a tier (e.g. calling `PRO` "EVPulse Drive" in copy) — but this
spec does **not** do that: the UI label matches the enum value (Free / Pro / Pro+ / Fleet) everywhere, precisely
to avoid reintroducing the naming confusion this revision exists to remove. Revisit only if there's a concrete
marketing reason later, as its own explicit decision.

Apple's App Store Review Guidelines (§3.1.1) require that if a digital subscription can be purchased inside the
iOS app, it **must** go through StoreKit/IAP — an in-app "upgrade" button that opens Stripe checkout (as
`UpgradeModal.tsx` does on web) would be rejected if shipped inside the iOS binary. Mobile's paywall must call
StoreKit; it may *also* mention that the subscription can be managed at evpulse.app for users who originally
subscribed via web (Apple permits account-management links, not new-purchase links, for external subscriptions —
verify current guideline wording at implementation time, this is a compliance detail that shifts).

## 1. Plans

| Plan | Price | Vehicles | Scope |
|---|---|---|---|
| **Free** | €0 | 1 | Read-only current status, 7-day history (matching web's `FREE_DEFAULTS.tripHistoryDays`), privacy/data export, Tesla connection. No ongoing paid telemetry depth. |
| **Pro** | €4.99/mo or €44.99/yr (25% off monthly-equivalent) | 1 | Full trip/charging history, charging costs, battery health, vampire drain, up to 5 alerts. The main paid tier — this is the plan most Tesla owners land on. |
| **Pro+** | €8.99/mo or €79.99/yr (26% off) | 1 (Pro included) | Everything in Pro, plus automations, unlimited alerts, AI reports, advanced battery analysis (full confidence/baseline detail), CSV/API export, Home Assistant integration. For power users. |
| **Extra Vehicle** | €2.99/mo or €24.99/yr | +1 per purchase | Add-on only — requires an active Pro or Pro+ base plan; extends that plan's feature set to a second (third, ...) vehicle. Not sold standalone. |
| **Fleet** | Not priced yet | Multi-vehicle, roles/teams | Reserved enum value for future B2B use (fleet dashboard, team access, invoicing). **Not built or scoped for MVP** — no UI references it until real fleet/B2B demand exists. Kept in the enum now so it doesn't require a breaking schema change later. |

Pro+ is a superset of Pro (Pro+ unlocks everything Pro does, plus its own list) — there is no world where a user
has Pro+ features but not Pro features. This matters for entitlement-check code: checking `plan >= PRO` is one
comparison, not two separate feature flags that can drift apart.

### 1.1 Feature matrix

| Feature | Free | Pro | Pro+ |
|---|:-:|:-:|:-:|
| Live vehicle status (current SOC/range/state) | ✅ | ✅ | ✅ |
| History depth | 7 days | Unlimited | Unlimited |
| Trip list + map | ✅ (7d) | ✅ full | ✅ full |
| Charging session list | ✅ (7d) | ✅ full | ✅ full |
| Cost tracking (per-session, per-period) | — | ✅ | ✅ |
| Battery health — basic (SOH %, degradation %) | ✅ | ✅ | ✅ |
| Battery health — confidence/baseline detail | — | Basic (high/medium/low badge only) | Full (sample count, baseline method, per-source SOH breakdown) |
| Vampire drain analytics | — | ✅ | ✅ |
| Alerts | — | Up to 5 | Unlimited |
| Automations | — | — | ✅ |
| AI reports (explainable insight feed) | Rule-based "all good" fallback only | Rule-based feed | Full AI feed + reports |
| CSV / API export | Manual data-export request only (privacy right, not a feature — see §7) | — | ✅ |
| Home Assistant integration | — | — | ✅ |
| Extra vehicles | — | +€2.99/mo each | +€2.99/mo each |
| Live refresh interval | 60s (matches web `FREE_DEFAULTS.liveRefreshSeconds`) | 15s | 5s |

Live-refresh throttling by plan already exists server-side for web (`SubscriptionData.liveRefreshSeconds`) —
mobile's socket subscription should honor the same field rather than inventing its own throttle.

## 2. Trial, renewal, cancellation

- **14-day free trial of Pro+** for any first-time subscriber (no prior purchase history on the Apple ID for this
  app), configured as an introductory offer on the Pro+ product in App Store Connect. Pro and Extra Vehicle do
  not carry a trial — Pro+'s trial is the only one, positioned as "try the full thing."
- Trial-to-paid conversion is a StoreKit-managed auto-renewal, not a manual charge — the paywall must state the
  exact price and renewal date the trial converts to, in-line, before purchase (Apple requirement, §3 below).
- **Renewal terms shown at point of purchase** (Apple-mandated language, adapted):
  - "€X.XX per [month/year]. Auto-renews unless cancelled at least 24 hours before the end of the current
    period. Manage or cancel in Settings → Apple ID → Subscriptions."
- **Annual savings** shown as a percentage next to the annual price on the paywall (Pro: "25% off", Pro+: "26%
  off"), computed as `1 - (annualPrice / (monthlyPrice * 12))`, never a made-up round number.
- **No dark patterns:** no pre-selected "recommended" annual toggle that's harder to find than a default monthly
  one is a common trick — annual and monthly are presented as two equally-weighted cards, not a toggle defaulted
  to the more expensive/harder-to-cancel option. Cancellation flow is a single tap to "Manage Subscription" that
  deep-links to the native `itms-apps://apps.apple.com/account/subscriptions` sheet — never a custom in-app
  "are you sure, here's what you'll lose" gauntlet.

## 3. Expiry — read-only, not deleted

- On expiry (trial ends unconverted, renewal fails, or user cancels and the period lapses), the account **drops
  to Free entitlements** (or from Pro+ down to Pro, if only the Pro+ add-on lapsed while a Pro base purchase is
  still active — the two are separate StoreKit products and can expire independently), not zero access. All
  previously-recorded trips, charges, health history, and settings remain in the database untouched — per the
  brief's explicit rule, **no data deletion due to expiry**.
- UI response to expiry: any screen previously showing Drive/Pro-gated content that's now hidden shows the
  `PremiumFeatureLock` component (see product doc) in its place, not an error state and not a blank screen. The
  underlying data still exists server-side; the client is being told "you can see this again if you resubscribe,"
  not "this is gone."
- History views clamp to the Free 7-day window using the exact same `ClampedBanner`-style mechanism web already
  has (`apps/web/src/components/billing/ClampedBanner.tsx` — reuse the pattern, not the component, since it's a
  Next.js/Tailwind component) — an amber banner stating "Showing the last 7 days. Your full history is saved —
  [Resubscribe] to see it again," never a silent truncation.
- Automations (Pro+ only) are **paused, not deleted**, on expiry — their definitions remain, `enabled` flips to
  `false` server-side, and the More → Automations screen shows them grayed out with a "Paused — Pro+ required"
  tag rather than removing them from the list.

## 4. Restore purchases

- A visible "Restore Purchases" action lives in More → Subscription (not buried in a submenu) — Apple requires
  this be easily accessible, and it's also the correct recovery path for reinstalls / new devices on the same
  Apple ID.
- Restore calls `StoreKit`'s restore API, which re-syncs local receipt state; the **entitlement itself is still
  server-verified** (§6) — restore changes what the device *claims*, the backend re-validates against Apple
  before actually unlocking anything. A restore that finds no valid subscription shows "No active subscription
  found for this Apple ID" rather than a silent no-op, so the user isn't left wondering whether it worked.

## 5. StoreKit / Apple compliance architecture

- **Default (this spec's recommendation): StoreKit 2 + App Store Server API + NestJS verification, no
  third-party billing SaaS.** Client library is `expo-iap` or Apple's native StoreKit 2 Swift API via an Expo
  config plugin/dev client (either is fine — pick at implementation time based on Expo SDK 54 compatibility);
  server-side, the NestJS backend calls Apple's **App Store Server API** directly to verify transactions and
  ingests **App Store Server Notifications V2** itself. This keeps purchase data, receipts, and entitlement
  resolution entirely inside EVPulse's own infrastructure — no subscriber data is handed to a third-party billing
  processor, which matches this project's self-hosted/data-control posture (the same posture that already keeps
  Tesla telemetry, trips, and billing on infrastructure you run, not a third-party SaaS).
- **Optional trade-off, not the default:** `react-native-purchases` (RevenueCat) remains a documented fallback
  if implementation velocity turns out to matter more than avoiding the third-party dependency — RevenueCat
  handles receipt validation, entitlement caching, and cross-platform (future Android Play Billing) parity out of
  the box, at the cost of routing every purchase event through RevenueCat's servers. If this trade-off is ever
  taken, it should be a **deliberate, explicit decision at that time** (documented as such, not defaulted into),
  not picked for convenience during P4 implementation.
- **Client never decides entitlement.** The client's job is: (1) present products fetched from StoreKit,
  (2) initiate purchase, (3) hand the resulting signed transaction to the NestJS backend, (4) render whatever
  entitlement the backend returns. The client must not locally compute "I have a receipt therefore I'm Pro" and
  unlock UI before the server confirms — this is both an Apple guideline concern (server authority prevents
  jailbreak/receipt-replay abuse) and consistent with how `useSubscription()` already works on web (`plan`/`isPro`
  come from `/billing/me`, not client state).
- **Backend verification flow (new NestJS endpoints, not built yet):**
  1. Mobile completes a StoreKit 2 purchase → receives a signed transaction (JWS).
  2. Mobile `POST /billing/mobile/verify-transaction` with the signed transaction + product id.
  3. Backend verifies the JWS signature and/or calls the App Store Server API
     (`/inApps/v1/transactions/{transactionId}`) directly, resolves it to a canonical `Plan` value (§0), and
     upserts the same `SubscriptionData` shape web already reads from `/billing/me`.
  4. Backend subscribes to **App Store Server Notifications V2** directly (renewal, cancellation, refund,
     price-increase consent, grace period) so entitlement stays correct without the client having to poll — a
     refund or Apple-side cancellation must revoke access even if the user never reopens the app.
  5. Mobile's `useSubscription()` mirrors web's hook shape (`plan, status, isActive, isPro, isProPlus, limits,
     features`) against the same `/billing/me` endpoint — one entitlement source of truth for both platforms.
- **Grace period / billing retry:** Apple gives users a grace period on renewal payment failure — during that
  window `status` should read a distinct `PAST_DUE`-equivalent (web already models `pastDue: boolean` on
  `SubscriptionData` — reuse it) so mobile can show a non-blocking "update your payment method" nudge instead of
  immediately dropping to Free.
- **Testing constraint:** Expo Go **cannot** test real purchases (no native StoreKit module). All subscription
  UI can be built and visually tested in Expo Go against mocked entitlement state, but real purchase flow
  requires a Development Build (`expo-dev-client`) at minimum, and full end-to-end (including sandbox receipt
  validation against the real backend) requires TestFlight. This gates P4 in the backlog behind actually having
  a Development Build set up — flagging so it isn't assumed to "just work" in Expo Go during earlier phases.

## 6. Server-controlled entitlements — summary contract

Mobile must never gate a feature on a locally-stored boolean set once at purchase time. Every gated screen reads
current entitlement from the same `/billing/me`-equivalent call web uses (react-query, short `staleTime`,
revalidated on app foreground) — matching the existing web pattern exactly rather than inventing a mobile-only
shape:

```
GET /billing/me →
{
  plan: 'FREE' | 'PRO' | 'PRO_PLUS' | 'FLEET',
  status: 'ACTIVE' | 'PAST_DUE' | 'INACTIVE',
  vehicleSlots: number,          // 1 + purchased Extra Vehicle add-ons
  tripHistoryDays: number | null, // null = unlimited
  chargingHistoryDays: number | null,
  liveRefreshSeconds: number,
  alerts: { used: number, limit: number | null },
  automationsEnabled: boolean,
  aiReportsEnabled: boolean,
  exportEnabled: boolean,
  trialEligible: boolean,        // controls whether the paywall offers the 14-day Pro trial
  renewsAt: string | null,
  managedVia: 'APPLE' | 'STRIPE' | null, // which storefront owns this subscription, for the "Manage" deep link
}
```

## 7. Privacy/export stays outside the paywall

Data export and account deletion (More → Privacy/Data Export) are **never** gated behind a paid plan, on any
tier, including Free — this is a legal right under GDPR (primary market: Germany/EU), not a premium feature. The
brief's "no dark patterns" rule and EU law both point the same direction here; CSV/API *export as an ongoing
analytics feature* (Pro) is a different thing from a one-time GDPR data-export request (all tiers, free) and the
UI must keep these visibly distinct so a Free user doesn't read "Export — Pro" and think they can't get their own
data out at all.
