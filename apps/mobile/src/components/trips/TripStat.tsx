import { Text, View, StyleSheet } from 'react-native';
import { color, space, type as tType } from '@/theme/tokens';

interface Props {
  label: string;
  value: string;
  unit?: string;
}

/** Small stat tile — e.g. "Avg · 77 km/h". Used for TripStats values (avgSpeed,
 *  maxSpeed, elevationGain, ...) that come straight from the backend, unmodified. */
export function TripStat({ label, value, unit }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.value} numberOfLines={1}>
        {value}
        {unit ? <Text style={styles.unit}> {unit}</Text> : null}
      </Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, gap: 2 },
  value: { ...tType.h3, color: color.text.primary, fontVariant: ['tabular-nums'] },
  unit: { ...tType.caption, color: color.text.secondary, fontWeight: '400' },
  label: { ...tType.caption, color: color.text.secondary },
});
