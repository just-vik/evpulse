/**
 * EVPulse design tokens — apps/mobile/src/theme/tokens.ts
 * Spec: docs/MOBILE_DESIGN_TOKENS.md (source of truth). Dark-first, portrait iPhone only for P0.
 */

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

const bg = {
  app: '#0A0C10',
  surface1: '#12151B',
  surface2: '#1A1E26',
  surface3: '#232833',
  scrim: '#05060899',
};

const border = {
  subtle: '#262C36',
  strong: '#3A4250',
};

const brand = {
  teal300: '#5EEAD4',
  teal400: '#2DD4BF', // primary interactive accent
  teal500: '#14B8A6',
  teal600: '#0F9488',
  violet300: '#C4B5FD',
  violet400: '#A78BFA', // secondary — Insights/AI/Pro semantic accent ONLY
  violet500: '#8B5CF6',
};

const text = {
  primary: '#F1F3F6',
  secondary: '#AEB6C4',
  tertiary: '#727C8C', // contrast floor — never render body text darker than this
  onTeal: '#04211C',
  onViolet: '#FFFFFF',
};

const semantic = {
  success: '#34D399',
  warning: '#FBBF24',
  danger: '#F87171',
  info: '#60A5FA',
};

const qualityNeutral = '#8B93A3';

const quality = {
  realtime: semantic.success,
  delayed: semantic.warning,
  stale: qualityNeutral,
  offline: text.tertiary,
};

const confidence = {
  high: semantic.success,
  medium: semantic.warning,
  low: qualityNeutral, // never danger red — low confidence is "not enough data," not an error
};

export const color = {
  bg,
  border,
  brand,
  text,
  semantic,
  quality,
  confidence,
};

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const type = {
  display: { fontSize: 40, lineHeight: 46, fontWeight: '700' as const },
  h1: { fontSize: 28, lineHeight: 34, fontWeight: '700' as const },
  h2: { fontSize: 22, lineHeight: 28, fontWeight: '600' as const },
  h3: { fontSize: 18, lineHeight: 24, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' as const },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: '600' as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '500' as const, letterSpacing: 0.4 },
};

// Numeric display — units never compete visually with the value.
// `fontVariant` is deliberately NOT `as const`: that produces a readonly
// tuple, which isn't assignable to RN's mutable `FontVariant[]` and (via
// NamedStyles<T> constraint inference) silently collapses every property in
// any StyleSheet.create() call that spreads this object to `ViewStyle |
// TextStyle | ImageStyle`, masking real type errors everywhere else in the file.
export const numeric = {
  metricValue: {
    ...type.h1,
    color: color.text.primary,
    fontVariant: ['tabular-nums'] as ['tabular-nums'],
  },
  metricValueDisplay: {
    ...type.display,
    color: color.text.primary,
    fontVariant: ['tabular-nums'] as ['tabular-nums'],
  },
  metricUnit: { ...type.caption, color: color.text.tertiary },
};

// Hero number caps Dynamic Type scale so it never overflows its card.
export const maxFontScale = {
  display: 1.3,
};

// ---------------------------------------------------------------------------
// Spacing & radius
// ---------------------------------------------------------------------------

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 40,
  buttonVertical: 14,
  gridGap: 12,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  pill: 999,
};

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

export const elevation = {
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.24,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  raised: {
    shadowColor: '#000',
    shadowOpacity: 0.32,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  overlay: {
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
};

// ---------------------------------------------------------------------------
// Breakpoints — portrait iPhone only for P0/P1. `expanded` is a reserved
// token (docs/MOBILE_DESIGN_TOKENS.md §6) with nothing to render into until
// tablet/landscape support is a separate, explicit decision.
// ---------------------------------------------------------------------------

export const breakpoint = {
  compact: 380,
  regular: 600,
  // 'expanded' (>= regular) intentionally has no dedicated layout in P0/P1.
};

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

export const motion = {
  fast: { duration: 150 },
  base: { duration: 250 },
  slow: { duration: 400 },
};

// ---------------------------------------------------------------------------
// Backward-compatible flat exports.
// `apps/mobile/src/app/(auth)/callback.tsx` (explicitly out of P0 design
// scope — see docs/MOBILE_PRODUCT_DESIGN.md) still imports the old flat
// shape. Keep these as thin aliases onto the new tokens above rather than
// migrating that screen, and drop them once callback.tsx is touched in a
// later phase.
// ---------------------------------------------------------------------------

export const colors = {
  background: color.bg.app,
  surface: color.bg.surface1,
  surface2: color.bg.surface2,
  border: color.border.subtle,

  primary: color.brand.teal400,
  cyan: color.brand.teal300,
  green: color.semantic.success,
  purple: color.brand.violet400,
  warning: color.semantic.warning,
  danger: color.semantic.danger,

  textPrimary: color.text.primary,
  textSecondary: color.text.secondary,
  textMuted: color.text.tertiary,
};

export const spacing = space;

export const typography = {
  h1: { fontSize: type.h1.fontSize, fontWeight: type.h1.fontWeight },
  h2: { fontSize: type.h2.fontSize, fontWeight: type.h2.fontWeight },
  h3: { fontSize: type.h3.fontSize, fontWeight: type.h3.fontWeight },
  body: { fontSize: type.body.fontSize, fontWeight: type.body.fontWeight },
  caption: { fontSize: type.caption.fontSize, fontWeight: type.caption.fontWeight },
};
