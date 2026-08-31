import type { ReactNode } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { color, space, type as tType } from '@/theme/tokens';

interface Props {
  title: string;
  right?: ReactNode;
}

export function SectionHeader({ title, right }: Props) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.xs,
  },
  title: {
    ...tType.micro,
    color: color.text.secondary,
    textTransform: 'uppercase',
  },
});
