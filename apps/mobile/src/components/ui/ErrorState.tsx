import { Text, View, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { color, radius, space, type as tType } from '@/theme/tokens';

interface Props {
  message: string;
  onRetry?: () => void;
  /** Small inline variant for use inside an otherwise-loaded screen (one
   *  section failed) vs. the default full-block variant (nothing loaded). */
  compact?: boolean;
}

export function ErrorState({ message, onRetry, compact }: Props) {
  const { t } = useTranslation();
  return (
    <View style={[styles.container, compact && styles.compact]}>
      <Ionicons
        name="alert-circle-outline"
        size={compact ? 18 : 28}
        color={color.semantic.danger}
      />
      <Text style={[styles.message, compact && styles.messageCompact]}>{message}</Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          style={styles.retry}
          accessibilityRole="button"
          accessibilityLabel={t('common.retry') ?? undefined}
        >
          <Text style={styles.retryText}>{t('common.retry')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: space.xs, paddingVertical: space.lg, paddingHorizontal: space.lg },
  compact: { paddingVertical: space.sm, flexDirection: 'row', justifyContent: 'center' },
  message: { ...tType.caption, color: color.text.secondary, textAlign: 'center' },
  messageCompact: { marginLeft: space.xs },
  retry: {
    marginTop: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border.strong,
    paddingVertical: 6,
    paddingHorizontal: space.md,
  },
  retryText: { ...tType.caption, color: color.text.primary, fontWeight: '600' },
});
