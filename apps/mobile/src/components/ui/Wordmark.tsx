import { Text, View, StyleSheet } from 'react-native';
import { color, type as tType } from '@/theme/tokens';

interface Props {
  size?: 'default' | 'large';
}

/**
 * Temporary text-only wordmark until the final "Signal Path" mark ships
 * (docs/MOBILE_DESIGN_TOKENS.md §9). Renders in exactly two places per that
 * spec — the login screen and the root loading gate — never in every tab
 * header, and never reuses the old bolt-icon app asset as an in-app mark.
 *
 * Note: the spec calls for a teal→violet gradient on "Pulse" via a masked
 * gradient text effect. Doing that in React Native requires
 * @react-native-masked-view/masked-view, which isn't a project dependency —
 * adding a native module for a purely decorative text effect is out of
 * scope for a P0 foundation pass, so "Pulse" renders as a solid teal.400
 * instead. Revisit if/when the real logo work replaces this wordmark.
 */
export function Wordmark({ size = 'default' }: Props) {
  const fontSize = size === 'large' ? 34 : tType.h2.fontSize;
  return (
    <View style={styles.row}>
      <Text style={[styles.text, { fontSize, color: color.text.primary }]}>EV</Text>
      <Text style={[styles.text, { fontSize, color: color.brand.teal400 }]}>Pulse</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  text: { fontWeight: '700', letterSpacing: -0.3 },
});
