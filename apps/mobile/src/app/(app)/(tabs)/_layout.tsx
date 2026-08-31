import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { color } from '@/theme/tokens';

const TAB_BAR_BASE_HEIGHT = 74;
const TAB_BAR_BASE_PADDING_BOTTOM = 10;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: color.bg.surface1,
          borderTopColor: color.border.subtle,
          height: TAB_BAR_BASE_HEIGHT + insets.bottom,
          paddingTop: 8,
          paddingBottom: TAB_BAR_BASE_PADDING_BOTTOM + insets.bottom,
        },
        tabBarActiveTintColor: color.brand.teal400,
        tabBarInactiveTintColor: color.text.secondary,
      }}
    >
      {/* Home: vehicle/status */}
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.home'),
          tabBarIcon: ({ color: c, size }) => (
            <Ionicons name="car-sport-outline" size={size} color={c} />
          ),
        }}
      />
      {/* Drive: route/map */}
      <Tabs.Screen
        name="trips"
        options={{
          title: t('tabs.drive'),
          tabBarIcon: ({ color: c, size }) => (
            <Ionicons name="map-outline" size={size} color={c} />
          ),
        }}
      />
      {/* Charge: functional bolt icon here is fine — it's a plug/energy
          glyph for the Charge tab, not the app's brand mark. */}
      <Tabs.Screen
        name="charging"
        options={{
          title: t('tabs.charge'),
          tabBarIcon: ({ color: c, size }) => (
            <Ionicons name="flash-outline" size={size} color={c} />
          ),
        }}
      />
      {/* Insights: analytics/explainability */}
      <Tabs.Screen
        name="analytics"
        options={{
          title: t('tabs.insights'),
          tabBarIcon: ({ color: c, size }) => (
            <Ionicons name="bulb-outline" size={size} color={c} />
          ),
        }}
      />
      {/* More: profile/settings/menu */}
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.more'),
          tabBarIcon: ({ color: c, size }) => (
            <Ionicons name="menu-outline" size={size} color={c} />
          ),
        }}
      />
    </Tabs>
  );
}
