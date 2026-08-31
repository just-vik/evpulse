import { View, Text, StyleSheet, ScrollView, Platform } from 'react-native';
import { useLocalSearchParams, Link } from 'expo-router';
import { colors, spacing, radius } from '@/theme/tokens';

/**
 * Handles custom scheme returns e.g. tesla-control://auth/callback?...
 * Register the same redirect URI in Tesla Developer Portal when you add a native redirect flow.
 */
export default function AuthCallbackScreen() {
  const params = useLocalSearchParams<Record<string, string>>();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Auth callback</Text>
      <Text style={styles.sub}>
        If you wired a mobile redirect URI, tokens or codes appear below. Otherwise finish Tesla
        linking in the browser and return to the app.
      </Text>
      <View style={styles.card}>
        <Text style={styles.mono}>{JSON.stringify(params, null, 2)}</Text>
      </View>
      <Link href="/(app)/(tabs)/settings" style={styles.link}>
        Back to settings →
      </Link>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: { color: colors.textPrimary, fontSize: 22, fontWeight: '700' },
  sub: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  mono: { color: colors.textSecondary, fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }) },
  link: { color: colors.cyan, fontSize: 15, marginTop: spacing.md },
});
