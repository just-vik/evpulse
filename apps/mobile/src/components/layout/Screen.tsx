import type { ReactNode } from 'react';
import { View, ScrollView, StyleSheet, type ViewStyle, type ScrollViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space } from '@/theme/tokens';

export const TAB_BAR_BASE_HEIGHT = 74;

/**
 * Single source of truth for safe-area behaviour across all top-level screens.
 * Fixes the bug where Settings (now More) was the only tab missing top-inset
 * handling and rendered its title under the status bar / Dynamic Island.
 */
export function useScreenInsets() {
  const insets = useSafeAreaInsets();
  const tabBarHeight = TAB_BAR_BASE_HEIGHT + insets.bottom;
  return {
    insets,
    paddingTop: insets.top,
    // Tab-bar-aware bottom padding so content never hides behind the tab bar
    // or the home indicator.
    paddingBottom: tabBarHeight + space.md,
    tabBarHeight,
  };
}

interface ScreenProps {
  children: ReactNode;
  /** true (default): wraps children in a ScrollView with top+bottom inset padding applied once.
   *  false: only the top inset + background are applied; the caller (e.g. a FlatList-based
   *  screen) is responsible for its own scroll container and must use `useScreenInsets()`
   *  directly for its `paddingBottom` — never apply both. */
  scrollable?: boolean;
  header?: ReactNode;
  refreshControl?: ScrollViewProps['refreshControl'];
  contentContainerStyle?: ViewStyle;
  style?: ViewStyle;
}

export function Screen({
  children,
  scrollable = true,
  header,
  refreshControl,
  contentContainerStyle,
  style,
}: ScreenProps) {
  const { paddingTop, paddingBottom } = useScreenInsets();

  if (!scrollable) {
    return (
      <View style={[styles.root, { paddingTop }, style]}>
        {header}
        {children}
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop }, style]}>
      {header}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom }, contentContainerStyle]}
        refreshControl={refreshControl}
      >
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg.app },
  scroll: { flex: 1 },
  content: { paddingHorizontal: space.md, gap: space.md },
});
