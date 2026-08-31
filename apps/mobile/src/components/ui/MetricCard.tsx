import { Text, View, Pressable, StyleSheet, type ViewStyle } from 'react-native';
import { Card } from './Card';
import { LoadingSkeleton } from './LoadingSkeleton';
import { color, type as tType, numeric } from '@/theme/tokens';

interface Props {
  label: string;
  value?: string;
  unit?: string;
  valueColor?: string;
  loading?: boolean;
  onPress?: () => void;
  /** Full-width card (2-col grid becomes 1 row) */
  wide?: boolean;
  style?: ViewStyle;
}

export function MetricCard({ label, value, unit, valueColor, loading, onPress, wide, style }: Props) {
  const inner = (
    <>
      <Text style={styles.label}>{label}</Text>
      {loading ? (
        <LoadingSkeleton variant="row" height={22} />
      ) : (
        <View style={styles.valueRow}>
          <Text
            style={[styles.value, valueColor ? { color: valueColor } : null]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {value ?? '—'}
          </Text>
          {unit ? <Text style={styles.unit}>{unit}</Text> : null}
        </View>
      )}
    </>
  );

  const outer = [styles.outer, wide ? styles.wide : null, style];

  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={outer}>
        <Card style={styles.cardFill}>{inner}</Card>
      </Pressable>
    );
  }

  return <Card style={[styles.cardFill, ...outer]}>{inner}</Card>;
}

const styles = StyleSheet.create({
  outer: { flexGrow: 1, flexBasis: '48%' },
  wide: { flexBasis: '100%' },
  cardFill: { flex: 1, gap: 6 },
  label: {
    ...tType.caption,
    color: color.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  value: { ...numeric.metricValue, fontSize: 20, lineHeight: 24 },
  unit: numeric.metricUnit,
});
