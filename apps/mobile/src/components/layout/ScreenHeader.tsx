import type { ReactNode } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, space, type as tType } from '@/theme/tokens';

interface Props {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}

/** Screen title + optional trailing content (e.g. a status chip). Rendered
 *  inside `<Screen>`'s already-safe-area-padded region, so it is never at
 *  risk of sitting under the status bar / Dynamic Island. */
export function ScreenHeader({ title, subtitle, right }: Props) {
  return (
    <View style={styles.row}>
      <View style={styles.texts}>
        <Text accessibilityRole="header" style={styles.title} numberOfLines={1} ellipsizeMode="tail">
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.xs,
    gap: space.sm,
  },
  texts: { flex: 1, minWidth: 0 },
  title: { ...tType.h1, color: color.text.primary },
  subtitle: { ...tType.body, color: color.text.secondary, marginTop: 2 },
  right: { flexShrink: 0, alignItems: 'flex-end', marginTop: 4 },
});
