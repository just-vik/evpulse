import { Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { color, radius, space, type as tType } from '@/theme/tokens';

/** Insight icon/accent is always violet — reserved for this "intelligence"
 *  surface only (tokens doc §1), never used on a primary action. */
interface Props {
  title: string;
  description: string;
}

export function InsightCard({ title, description }: Props) {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Ionicons name="bulb-outline" size={16} color={color.brand.violet400} />
        <Text style={styles.title}>{title}</Text>
      </View>
      <Text style={styles.description}>{description}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.bg.surface1,
    borderWidth: 1,
    borderColor: `${color.brand.violet400}33`,
    borderRadius: radius.lg,
    padding: space.md,
    gap: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  title: { ...tType.bodyStrong, color: color.text.primary },
  description: { ...tType.caption, color: color.text.secondary },
});
