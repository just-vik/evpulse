import { Text, View, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { color, radius, space, type as tType } from '@/theme/tokens';

interface Props {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon, title, body, actionLabel, onAction }: Props) {
  return (
    <View style={styles.container}>
      <Ionicons name={icon} size={32} color={color.text.tertiary} />
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} style={styles.action} accessibilityRole="button">
          <Text style={styles.actionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: space.xs,
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
  },
  title: { ...tType.bodyStrong, color: color.text.primary, textAlign: 'center' },
  body: { ...tType.caption, color: color.text.secondary, textAlign: 'center' },
  action: {
    marginTop: space.sm,
    backgroundColor: color.brand.teal400,
    borderRadius: radius.md,
    paddingVertical: space.buttonVertical,
    paddingHorizontal: space.lg,
  },
  actionText: { ...tType.bodyStrong, color: color.text.onTeal },
});
