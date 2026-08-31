import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { useAuthStore } from '@/store/authStore';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export function usePushNotifications() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const registeredRef = useRef(false);

  useEffect(() => {
    if (!accessToken) {
      registeredRef.current = false;
      return;
    }
    if (registeredRef.current) return;

    const register = async () => {
      if (!Device.isDevice) return;

      const { status: existing } = await Notifications.getPermissionsAsync();
      let finalStatus = existing;
      if (existing !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== 'granted') return;

      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'default',
          importance: Notifications.AndroidImportance.HIGH,
        });
      }

      // SDK 52: projectId must be passed explicitly; without it getExpoPushTokenAsync throws.
      // If projectId is not configured (local dev / Expo Go without EAS setup) → skip silently.
      const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
      if (!projectId) return;

      let tokenData: Awaited<ReturnType<typeof Notifications.getExpoPushTokenAsync>>;
      try {
        tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
      } catch {
        return;
      }

      const url = process.env.EXPO_PUBLIC_PUSH_REGISTER_URL;
      if (url) {
        await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'X-Client': 'mobile',
          },
          body: JSON.stringify({
            token: tokenData.data,
            platform: Platform.OS,
          }),
        }).catch(() => {});
      }
      registeredRef.current = true;
    };

    void register();
  }, [accessToken]);
}
