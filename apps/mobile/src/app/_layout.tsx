import 'react-native-gesture-handler';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { colors, color } from '@/theme/tokens';
import { useTelemetrySocket } from '@/hooks/useTelemetrySocket';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { useReactQueryFocusSync } from '@/hooks/useReactQueryFocusSync';
import { initI18n } from '@/i18n';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      retry: 1,
      refetchOnReconnect: true,
      // Explicit, not just relying on the framework default: on foreground
      // (via useReactQueryFocusSync below), a query refetches only if it's
      // both currently mounted/observed AND past its own staleTime — one
      // attempt per focus transition, never a loop or periodic poll.
      refetchOnWindowFocus: true,
    },
  },
});

function AppBootstrap() {
  useTelemetrySocket();
  usePushNotifications();
  // Single AppState→focusManager wiring for the whole app — must not be
  // duplicated per screen (see the hook's own doc comment).
  useReactQueryFocusSync();
  return null;
}

export default function RootLayout() {
  const [i18nReady, setI18nReady] = useState(false);

  useEffect(() => {
    void initI18n().then(() => setI18nReady(true));
  }, []);

  // Gate on i18n init so screens never briefly render raw translation keys
  // instead of text. Locale JSON is bundled synchronously; only the stored
  // language lookup + device locale read are async, so this is sub-frame in
  // practice — a blank background is preferable to a spinner here.
  if (!i18nReady) {
    return <View style={{ flex: 1, backgroundColor: color.bg.app }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          <AppBootstrap />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
