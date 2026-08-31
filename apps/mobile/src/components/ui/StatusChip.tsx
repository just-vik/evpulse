import { Text, View, StyleSheet } from 'react-native';
import { color, radius, space, type as tType } from '@/theme/tokens';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';

const TONE_COLOR: Record<StatusTone, string> = {
  success: color.semantic.success,
  warning: color.semantic.warning,
  danger: color.semantic.danger,
  info: color.semantic.info,
  neutral: color.text.tertiary,
  brand: color.brand.teal400,
};

interface Props {
  label: string;
  tone?: StatusTone;
  /** Escape hatch for callers that need an exact token color not covered by
   *  `tone` (e.g. confidence.high/medium/low) — still a token, never a raw hex. */
  tintColor?: string;
}

export function StatusChip({ label, tone = 'neutral', tintColor }: Props) {
  const tint = tintColor ?? TONE_COLOR[tone];
  return (
    // Alpha-suffixed token color, not a raw hardcoded hex — derived from the
    // resolved token at render time for a tinted pill background/border.
    <View style={[styles.chip, { borderColor: `${tint}55`, backgroundColor: `${tint}1A` }]}>
      <Text style={[styles.text, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    minHeight: 22,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  text: { ...tType.micro, textTransform: 'none' },
});
