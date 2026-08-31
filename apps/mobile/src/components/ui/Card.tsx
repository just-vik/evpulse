import type { ReactNode } from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, space, elevation } from '@/theme/tokens';

interface Props {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  variant?: 'surface1' | 'surface2';
  raised?: boolean;
}

export function Card({ children, style, variant = 'surface1', raised = false }: Props) {
  return (
    <View
      style={[
        styles.base,
        { backgroundColor: variant === 'surface1' ? color.bg.surface1 : color.bg.surface2 },
        raised ? elevation.raised : elevation.card,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border.subtle,
    padding: space.md,
    gap: space.sm,
  },
});
