# EVPulse Design Tokens

Status: **Specification only — nothing in this file is implemented yet.** Companion to
[`MOBILE_PRODUCT_DESIGN.md`](./MOBILE_PRODUCT_DESIGN.md) and [`MOBILE_SUBSCRIPTIONS.md`](./MOBILE_SUBSCRIPTIONS.md).
Target: `apps/mobile/src/theme/tokens.ts` (replacing the current 41-line token file) and, longer term, a shared
token source consumed by both `apps/mobile` and `apps/web` (web currently hardcodes Tailwind classes rather than
reading `apps/mobile`'s tokens — unifying that is a P3+ concern, not in scope for this pass).

---

## 1. Brand rationale

- Current mobile primary (`#3B82F6`, generic "SaaS blue") is retired as the primary accent. Generic blue is what
  every dashboard-style app defaults to; it doesn't say "EV telemetry" and it visually collides with nothing in
  particular, which is itself the problem — it has no point of view.
- **Cyan/teal becomes the primary accent** — reads as "signal / live data / energy," is distinct from Tesla red,
  Tessie's orange, and TezLab's blue/green, and is not a color any competitor owns.
- Web's existing violet→fuchsia wordmark gradient (`apps/web/src/components/branding/EVPulseLogo.tsx`) is **kept
  and promoted to the platform's secondary accent** rather than replaced — this gives mobile and web one shared
  brand language instead of inventing a third palette. Today mobile (blue primary, no violet) and web (violet
  wordmark, Tailwind default grays) don't visually agree with each other at all; this token set is the
  reconciliation point.
- Violet is reserved for **intelligence surfaces only** — AI insight cards, confidence/explainability chips, and
  the Pro/premium badge. It never appears on a primary action button. This keeps "AI" from becoming a decorative
  color slapped on everything (a hard rule from the brief) and keeps teal legible as *the* interactive color.
- No lightning bolt, no generic EV-charging-plug icon as the primary mark. See §9 for the logo placeholder rule.

## 2. Color tokens (dark-first)

Dark is the only shipped theme for v1 (`app.json` already sets `userInterfaceStyle: "dark"`). Web already models
`User.preferences.theme: 'light'|'dark'|'auto'` — so token *names* below are theme-agnostic (`bg.app`, not
`black`) specifically so a light theme can be added later by swapping values, not restructuring the token tree.

### 2.1 Surfaces

| Token | Hex | Usage |
|---|---|---|
| `color.bg.app` | `#0A0C10` | Screen background (was `#0B0B0F`) |
| `color.bg.surface1` | `#12151B` | Card background, tab bar (was `#111217`) |
| `color.bg.surface2` | `#1A1E26` | Nested card / row-on-card (was `#1A1C23`) |
| `color.bg.surface3` | `#232833` | Modal / bottom sheet / overlay surface |
| `color.bg.scrim` | `#05060899` (60% alpha) | Modal backdrop, biometric lock overlay |
| `color.border.subtle` | `#262C36` | Card borders, dividers (was `#2A2D36`) |
| `color.border.strong` | `#3A4250` | Input focus ring rest state, active card border |

### 2.2 Brand

| Token | Hex | Usage |
|---|---|---|
| `color.brand.teal.300` | `#5EEAD4` | Chart line highlight, hover/pressed tint |
| `color.brand.teal.400` | `#2DD4BF` | **Primary accent** — primary buttons, active tab icon, links, live/charging state |
| `color.brand.teal.500` | `#14B8A6` | Pressed state of primary buttons |
| `color.brand.teal.600` | `#0F9488` | Primary button border / dark decorative use only (fails AA as text-on-dark, don't use for text) |
| `color.brand.violet.300` | `#C4B5FD` | Insight card accent border, subtle |
| `color.brand.violet.400` | `#A78BFA` | **Secondary accent** — AI/Insights icons, confidence chips |
| `color.brand.violet.500` | `#8B5CF6` | Pro/Premium badge fill, upgrade CTA (matches existing web gradient start) |

### 2.3 Text

| Token | Hex | Usage | Contrast on `bg.app` |
|---|---|---|---|
| `color.text.primary` | `#F1F3F6` | Headings, primary values | 16.8:1 |
| `color.text.secondary` | `#AEB6C4` | Labels, supporting copy | 8.9:1 |
| `color.text.tertiary` | `#727C8C` | Timestamps, disabled, micro-copy | 4.6:1 (body-text-safe minimum; do not go darker) |
| `color.text.onTeal` | `#04211C` | Text/icon on `teal.400` fill (teal is a light-toned accent — white text fails AA on it, ~2.1:1) | 8.1:1 on teal.400 |
| `color.text.onViolet` | `#FFFFFF` | Text/icon on `violet.500` fill | 4.9:1 on violet.500 |

**Rule:** `color.text.tertiary` is the contrast floor. Nothing renders body copy darker than that token. Any
new gray must be checked against both `bg.app` and `bg.surface2` (cards nest on cards in a few places, e.g. a
metric row inside a card inside a ScrollView) before it's added here.

### 2.4 Semantic

| Token | Hex | Usage |
|---|---|---|
| `color.semantic.success` | `#34D399` | Good efficiency, healthy battery, completed session |
| `color.semantic.warning` | `#FBBF24` | Low-ish SOC, unusual-but-not-critical trip, plan about to be clamped |
| `color.semantic.danger` | `#F87171` | Critical SOC, failed session, expired subscription blocking read-only |
| `color.semantic.info` | `#60A5FA` | Neutral system messages only (kept distinct from teal so it never reads as "the brand color") |

### 2.5 Data-quality / confidence tokens

This is new — nothing like it exists in mobile's token file today, even though the backend already exposes
`dataQuality: REALTIME|DELAYED|STALE|OFFLINE` (web reads it, mobile discards it — see audit §1.1) and
`BatteryHealth.confidenceScore` / `baselineConfidence`. Phase 4 of the product doc depends on these existing as
first-class tokens, not ad-hoc colors chosen per screen.

| Token | Hex | Meaning |
|---|---|---|
| `color.quality.realtime` | `color.semantic.success` (`#34D399`) | Live socket data < 30s old |
| `color.quality.delayed` | `color.semantic.warning` (`#FBBF24`) | 30s–5min old |
| `color.quality.stale` | `#8B93A3` (neutral, not red — staleness isn't a fault, it's a fact) | 5min–vehicle-asleep threshold |
| `color.quality.offline` | `color.text.tertiary` (`#727C8C`) | No signal; last-known snapshot |
| `color.confidence.high` | `color.semantic.success` | ≥ high confidence threshold (see product doc §4) |
| `color.confidence.medium` | `color.semantic.warning` | Medium confidence |
| `color.confidence.low` | `#8B93A3` (neutral gray, **not** danger red — low confidence is "not enough data yet," not an error state) | Low / insufficient data |

**Rule:** low confidence is never rendered in `danger` red. Red is reserved for things that need action (critical
SOC, failed charge, blocked feature). Using red for "we're not sure yet" trains users to panic at uncertainty
instead of just discounting the number appropriately — this is the exact failure mode complaint #6 in the brief
describes.

## 3. Typography

RN/Expo uses the system font (SF Pro on iOS) by default; no custom font is being introduced for v1 to keep bundle
size down and guarantee Dynamic Type compatibility for free. Numeric values (SOC %, kWh, €, Wh/km) use
`fontVariant: ['tabular-nums']` so digits don't shift width as they update live — the current app has no
tabular-numeral setting anywhere, which is why a live-updating `heroValue` (52px, index.tsx:251) visibly jitters
in width today.

### 3.1 Scale

| Token | Size / Line height | Weight | Maps to iOS Dynamic Type | Usage |
|---|---|---|---|---|
| `type.display` | 40 / 46 | 700 | — (custom, caps at 1.3× scale) | Battery hero % on Home |
| `type.h1` | 28 / 34 | 700 | Title 1 | Screen titles |
| `type.h2` | 22 / 28 | 600 | Title 2 | Section headers |
| `type.h3` | 18 / 24 | 600 | Title 3 | Card titles |
| `type.body` | 15 / 21 | 400 | Body | Default copy (was 14 — bumped 1px, 14 sits below iOS's own Body default of 17 and reads small for a premium product) |
| `type.bodyStrong` | 15 / 21 | 600 | Body (emphasized) | Emphasized inline copy |
| `type.caption` | 13 / 18 | 400 | Footnote | Metric labels, timestamps |
| `type.micro` | 11 / 14 | 500, letterSpacing 0.4 | Caption 2 | Eyebrows, badges — **never used below this size**; the audit found `fontSize: 9` chart axis labels (analytics.tsx:222) which is below this floor and must be raised to at least `type.micro` or removed in favor of fewer, labeled gridlines |

### 3.2 Numeric display styles

Units must never compete visually with the value they're attached to (brief complaint: units competing with SOC/kWh/€/Wh-km numbers).

| Token | Spec |
|---|---|
| `type.metricValue` | `type.display` or `type.h1`, `color.text.primary`, tabular-nums |
| `type.metricUnit` | `type.caption`, `color.text.tertiary`, rendered as a separate `Text` node with 2–4px gap, baseline-aligned to the *bottom* of the value, never inline-larger than 40% of the value's font size |

### 3.3 Dynamic Type

- All `Text` uses `allowFontScaling: true` (RN default) — nothing in the app currently opts out, which is
  correct; keep it that way. No screen should hardcode `numberOfLines` in a way that truncates critical values
  (SOC, alerts) at large accessibility text sizes — truncate secondary copy first (addresses, timestamps).
- `type.display` should cap its scale factor at ~1.3× (via `maxFontSizeMultiplier`) so the battery hero number
  doesn't overflow its card at the largest accessibility sizes; everything else scales freely.

## 4. Spacing & radius

Kept from the existing token file (already a clean 4/8pt grid) with two additions to close gaps the audit found
(literal `14`, `28`, `5`, `'40%'`, `'47.5%'` scattered across screens instead of tokens).

| Token | Value |
|---|---|
| `space.xs` | 4 |
| `space.sm` | 8 |
| `space.md` | 16 |
| `space.lg` | 24 |
| `space.xl` | 32 |
| `space.xxl` | 40 |
| `space.buttonVertical` *(new)* | 14 — codifies the value every button already uses ad hoc |
| `space.gridGap` *(new)* | 12 — for 2-column metric grids; replaces magic `'47.5%'`/`'40%'` width percentages with `flexBasis: '48%'` + explicit `gap: space.gridGap` (RN 0.71+ Flexbox `gap` support, already available on RN 0.81 in this project) |
| `radius.sm` | 8 |
| `radius.md` | 12 |
| `radius.lg` | 18 |
| `radius.xl` | 24 |
| `radius.pill` *(new)* | 999 — chips, badges, segmented control |

## 5. Elevation

RN has no native box-shadow equivalent to CSS elevation tokens, but the current app uses **zero** shadow/elevation
anywhere — every card is flat with only a border, which is part of why the UI reads flat/cheap rather than premium.

| Token | iOS (`shadow*`) | Android (`elevation`) | Usage |
|---|---|---|---|
| `elevation.card` | `shadowColor:#000, shadowOpacity:0.24, shadowRadius:12, shadowOffset:{0,4}` | `elevation: 3` | Standard cards |
| `elevation.raised` | `shadowOpacity:0.32, shadowRadius:20, shadowOffset:{0,8}` | `elevation: 8` | BatteryHeroCard, active-session card, bottom sheets |
| `elevation.overlay` | `shadowOpacity:0.4, shadowRadius:28, shadowOffset:{0,12}` | `elevation: 16` | Modals, ConfirmActionModal |

## 6. Breakpoints (logical width, points)

RN has no CSS media queries; breakpoints are read from `useWindowDimensions()` and drive layout decisions
(column count, max content width), not token values that change per-breakpoint.

**Scope note:** `app.json` currently sets `orientation: "portrait"` and `supportsTablet: false`. `bp.compact`
and `bp.regular` are real, in-scope targets from P0 onward. `bp.expanded` is a **reserved token defined now so
the primitives don't need rework later** — it has nothing to render into until tablet/landscape support is
turned on as its own explicit decision (product design doc, Responsive rules section). Don't build or test
`bp.expanded` layouts as part of P0–P3.

| Token | Range | Devices | Layout behavior |
|---|---|---|---|
| `bp.compact` | < 380pt | iPhone SE, iPhone 13/16 mini | Single column, metric grid becomes 1 col if a 2nd would go < 150pt wide |
| `bp.regular` | 380–599pt | Standard/Plus/Pro Max iPhones (portrait) | Default 2-column metric grid, current design baseline |
| `bp.expanded` | ≥ 600pt | iPad (any orientation/split view), iPhone landscape (rare, still supported) | Content max-width `680pt`, centered; metric grid becomes 3–4 col; Drive tab shows map + list side-by-side instead of stacked |

`app.json` currently sets `"supportsTablet": false`. This spec assumes that flips to `true` no earlier than P1
(see backlog) — until then `bp.expanded` only matters for landscape on large iPhones, which iOS allows even with
`supportsTablet:false`.

## 7. Safe area & layout primitives

Codifies the fix for the Settings-header-under-status-bar bug (settings.tsx is the only tab screen missing
`useSafeAreaInsets`) as a rule, not a one-off patch.

- **Rule:** every top-level screen is wrapped in one shared `<Screen>` layout primitive (new component, see
  product doc §Components) that applies `paddingTop: insets.top` itself. No screen is allowed to manage its own
  top inset ad hoc — this is precisely how Settings drifted out of sync with the other four tab screens.
  - Alternatively, when navigation-level headers are used, header height is derived from
    `insets.top + <fixed header content height>`.
- **Bottom padding rule:** scrollable content's `contentContainerStyle.paddingBottom` = `tabBarHeight + insets.bottom + space.md`, computed once in `<Screen>`, not hand-approximated per screen as `space.xxl + 16` (today's pattern, which under-accounts for `insets.bottom` on Face-ID-generation iPhones — see audit).
- **Tab bar height:** `74 + insets.bottom` (keep current constant — it isn't the bug).
- **Modal/bottom sheet:** always respects `insets.bottom` for its own bottom padding independent of the tab bar (sheets render above the tab bar).

## 8. Motion

Nothing in mobile uses `react-native-reanimated` today despite it being a dependency (unused). Motion tokens are
intentionally minimal and functional — this is a calm, trustworthy product, not a showcase for animation.

| Token | Duration | Easing | Usage |
|---|---|---|---|
| `motion.fast` | 150ms | `easeOut` | Press states, toggle switches |
| `motion.base` | 250ms | `easeInOut` | Card entrance, tab transitions, skeleton→content crossfade |
| `motion.slow` | 400ms | `easeInOut` | Bottom sheet / modal present-dismiss |

Rule: no animation on data changing value (SOC ticking up while charging) beyond the number crossfading — never
spring/bounce a number, it reads as a toy, not a monitoring instrument.

## 9. Brand mark placeholder

- No final logo exists yet ("Signal Path" mark referenced in the brief is a future asset, not delivered here).
  Until it exists, mobile uses a **text wordmark only** — `EVPulse` set in `type.h2`/700, `EV` in
  `color.text.primary`, `Pulse` in a `teal.400 → violet.400` gradient (via `expo-linear-gradient`, already a
  dependency) — deliberately mirroring web's existing `EVPulseLogo.tsx` gradient treatment (currently
  violet→fuchsia only) so the two platforms read as one brand while the icon mark is still pending. **Do not**
  reuse `apps/mobile/assets/icon.png` (the current bolt-style icon) as an in-app UI mark — it stays as the OS
  home-screen icon only until replaced.
- Logo placement rule: wordmark appears exactly twice in the product — the splash screen and the auth/login
  screen. It does **not** appear in the in-app header on every tab (that space belongs to the screen title +
  VehicleStatusChip, per IA in the product doc) — a logo on every screen is a marketing-site habit, not a utility
  app one.
- Splash: `color.bg.app` background, centered wordmark, no spinner (Expo splash is static by OS design) →
  crossfades into the root-gate spinner screen (`app/index.tsx`), which **should** also show the wordmark
  (currently a bare `ActivityIndicator` on blank background — a missed-branding gap the audit flagged).
- Empty states and loading skeletons never use the logo as decoration (brief rule: no decorative AI/brand
  elements) — they use the relevant semantic icon (map pin, battery, plug) instead.
