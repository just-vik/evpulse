import type { ReactNode } from 'react';
import { View, StyleSheet, useWindowDimensions, type ViewStyle } from 'react-native';
import { breakpoint } from '@/theme/tokens';

export type Breakpoint = 'compact' | 'regular' | 'expanded';

/**
 * Portrait iPhone only for P0/P1 (docs/MOBILE_PRODUCT_DESIGN.md, Responsive rules).
 * 'expanded' is a reserved category — nothing renders a dedicated layout for it yet;
 * callers fall back to the 'regular' behaviour until tablet/landscape is a separate,
 * explicit decision (app.json `supportsTablet`/`orientation` unchanged).
 *
 * Uses `useWindowDimensions()` (not `Dimensions.get()` at module scope) so it reacts
 * to rotation/size-class changes instead of freezing the value read at import time.
 */
export function useBreakpoint(): Breakpoint {
  const { width } = useWindowDimensions();
  if (width < breakpoint.compact) return 'compact';
  if (width < breakpoint.regular) return 'regular';
  return 'expanded';
}

/** Metric grids: 1 column on compact phones, 2 otherwise (never lower than 1, never
 *  higher than 2 until an 'expanded' layout is explicitly designed). */
export function useMetricGridColumns(): 1 | 2 {
  const bp = useBreakpoint();
  return bp === 'compact' ? 1 : 2;
}

interface Props {
  children: ReactNode;
  style?: ViewStyle;
}

/** Thin layout wrapper — today a no-op pass-through so call sites don't need to
 *  change when 'expanded' (max-width centering) is designed later. */
export function ResponsiveContainer({ children, style }: Props) {
  return <View style={[styles.container, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  container: { width: '100%' },
});
