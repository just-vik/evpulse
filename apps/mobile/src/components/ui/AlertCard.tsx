import { Text, View, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { color, radius, space, type as tType } from '@/theme/tokens';

export type AlertSeverity = 'info' | 'warning' | 'danger';

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  info: color.semantic.info,
  warning: color.semantic.warning,
  danger: color.semantic.danger,
};

const SEVERITY_ICON: Record<AlertSeverity, keyof typeof Ionicons.glyphMap> = {
  info: 'information-circle-outline',
  warning: 'warning-outline',
  danger: 'alert-circle-outline',
};

interface Props {
  severity: AlertSeverity;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** Critical/actionable alert — only ever rendered when a real condition
 *  exists (never an empty placeholder card). */
export function AlertCard({ severity, title, message, actionLabel, onAction }: Props) {
  const tint = SEVERITY_COLOR[severity];
  return (
    <View
      style={[styles.card, { borderColor: `${tint}55`, backgroundColor: `${tint}14` }]}
      accessibilityLabel={`${title}. ${message}`}
    >
      <View style={styles.row}>
        <Ionicons name={SEVERITY_ICON[severity]} size={18} color={tint} />
        <Text style={[styles.title, { color: tint }]}>{title}</Text>
      </View>
      <Text style={styles.message}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" style={styles.action}>
          <Text style={[styles.actionText, { color: tint }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space.md, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  title: { ...tType.bodyStrong },
  message: { ...tType.caption, color: color.text.secondary },
  action: { marginTop: 2 },
  actionText: { ...tType.caption, fontWeight: '700' },
});
