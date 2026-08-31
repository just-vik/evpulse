import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { useAuthStore } from '@/store/authStore';
import { useSecurityStore } from '@/store/useSecurityStore';
import { useVehicleStore } from '@/store/useVehicleStore';
import { colors } from '@/theme/tokens';

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
      <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!token) return <Redirect href="/(auth)/login" />;
  return <Redirect href="/(app)/(tabs)" />;
}
