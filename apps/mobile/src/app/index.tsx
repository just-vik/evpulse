import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useAuthStore } from '@/store/authStore';
import { useSecurityStore } from '@/store/useSecurityStore';
import { useVehicleStore } from '@/store/useVehicleStore';
import { color } from '@/theme/tokens';
import { Wordmark } from '@/components/ui/Wordmark';

export default function Index() {
  const hydrated = useAuthStore((s) => s.hydrated);
  const token = useAuthStore((s) => s.accessToken);
  const hydrateAuth = useAuthStore((s) => s.hydrate);
  const hydrateSec = useSecurityStore((s) => s.hydrateSecurity);
  const hydrateVeh = useVehicleStore((s) => s.hydrateVehicle);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      await hydrateAuth();
      await hydrateSec();
      await hydrateVeh();
      setReady(true);
    })();
  }, [hydrateAuth, hydrateSec, hydrateVeh]);

  if (!ready || !hydrated) {
    return (
      <View style={styles.gate}>
        <Wordmark size="large" />
        <ActivityIndicator color={color.brand.teal400} style={styles.spinner} />
      </View>
    );
  }

  if (!token) return <Redirect href="/(auth)/login" />;
  return <Redirect href="/(app)/(tabs)" />;
}

const styles = StyleSheet.create({
  gate: { flex: 1, backgroundColor: color.bg.app, justifyContent: 'center', alignItems: 'center', gap: 24 },
  spinner: { marginTop: 8 },
});
