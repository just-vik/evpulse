import { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Switch, Alert } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { color, space, radius, type as tType } from '@/theme/tokens';
import { Screen } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { Card } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatusChip } from '@/components/ui/StatusChip';
import { LoadingSkeleton } from '@/components/ui/LoadingSkeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { useAuthStore } from '@/store/authStore';
import { useSecurityStore } from '@/store/useSecurityStore';
import { useTelemetryStore } from '@/store/useTelemetryStore';
import { useTeslaOAuth } from '@/features/auth/useTeslaOAuth';
import { useVehicleSummary } from '@/features/vehicles/useVehicleSummary';
import { API_ORIGIN } from '@/services/api';
import { setLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n';

const LANGUAGE_NATIVE_NAME: Record<SupportedLanguage, string> = {
  en: 'English',
  de: 'Deutsch',
  ru: 'Русский',
};

export default function SettingsScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const qc = useQueryClient();
  const clearSession = useAuthStore((s) => s.clearSession);
  const biometricLockEnabled = useSecurityStore((s) => s.biometricLockEnabled);
  const setBiometricLockEnabled = useSecurityStore((s) => s.setBiometricLockEnabled);
  const socketConnected = useTelemetryStore((s) => s.connected);
  const { connectTesla, pollTeslaStatus, busy } = useTeslaOAuth();
  const { vehiclesQuery, vehicleId, setSelectedVehicleId } = useVehicleSummary();
  const [polling, setPolling] = useState(false);

  const onConnectTesla = useCallback(async () => {
    const res = await connectTesla();
    if (!res.ok) {
      Alert.alert(t('more.alerts.teslaTitle'), t('more.alerts.linkFailed'));
      return;
    }
    Alert.alert(t('more.alerts.teslaTitle'), t('more.alerts.completeInBrowser'), [
      {
        text: t('more.alerts.checkStatus'),
        onPress: async () => {
          setPolling(true);
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const ok = await pollTeslaStatus();
              if (ok) {
                await vehiclesQuery.refetch();
                Alert.alert(t('more.alerts.teslaTitle'), t('more.alerts.connected'));
                setPolling(false);
                return;
              }
            } catch {
              /* retry */
            }
          }
          setPolling(false);
          Alert.alert(t('more.alerts.teslaTitle'), t('more.alerts.notConnectedYet'));
        },
      },
    ]);
  }, [connectTesla, pollTeslaStatus, vehiclesQuery, t]);

  const onToggleBio = async (v: boolean) => {
    if (v) {
      const has = await LocalAuthentication.hasHardwareAsync();
      if (!has) {
        Alert.alert(t('more.alerts.biometricsTitle'), t('more.alerts.noHardware'));
        return;
      }
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!enrolled) {
        Alert.alert(t('more.alerts.biometricsTitle'), t('more.alerts.notEnrolled'));
        return;
      }
    }
    await setBiometricLockEnabled(v);
  };

  async function signOut() {
    await clearSession();
    qc.clear();
    router.replace('/(auth)/login');
  }

  return (
    <Screen header={<ScreenHeader title={t('more.title')} subtitle={t('more.subtitle')} />}>
      <SectionHeader title={t('more.vehicle')} />
      <Card>
        {vehiclesQuery.isPending ? (
          <LoadingSkeleton variant="row" height={40} />
        ) : vehiclesQuery.isError ? (
          <ErrorState compact message={t('more.errorVehicles')} onRetry={() => vehiclesQuery.refetch()} />
        ) : (vehiclesQuery.data ?? []).length === 0 ? (
          <Text style={styles.hint}>{t('more.noVehicles')}</Text>
        ) : (
          (vehiclesQuery.data ?? []).map((v) => (
            <Pressable
              key={v.id}
              style={[styles.vehicleRow, vehicleId === v.id && styles.vehicleRowActive]}
              onPress={() => void setSelectedVehicleId(v.id)}
              accessibilityRole="button"
            >
              <Text style={styles.vehicleText}>{v.displayName ?? v.model}</Text>
              <Text style={styles.vehicleHint}>{v.id.slice(0, 8)}…</Text>
            </Pressable>
          ))
        )}
      </Card>

      <SectionHeader title={t('more.teslaConnection')} />
      <Pressable
        style={[styles.buttonPrimary, (busy || polling) && styles.disabled]}
        onPress={() => void onConnectTesla()}
        disabled={busy || polling}
        accessibilityRole="button"
      >
        <Text style={styles.buttonPrimaryText}>
          {polling ? t('more.checkingTesla') : t('more.connectTesla')}
        </Text>
      </Pressable>

      <SectionHeader title={t('more.security')} />
      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>{t('more.biometricLock')}</Text>
          <Switch
            value={biometricLockEnabled}
            onValueChange={(v) => void onToggleBio(v)}
            trackColor={{ false: color.border.subtle, true: color.brand.teal400 }}
          />
        </View>
        <Text style={styles.hint}>{t('more.biometricHint')}</Text>
      </Card>

      <SectionHeader title={t('more.language')} />
      <Card style={styles.languageRow}>
        {SUPPORTED_LANGUAGES.map((lang) => {
          const active = i18n.language === lang;
          return (
            <Pressable
              key={lang}
              onPress={() => void setLanguage(lang)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={styles.languagePressable}
            >
              <StatusChip label={LANGUAGE_NATIVE_NAME[lang]} tone={active ? 'brand' : 'neutral'} />
            </Pressable>
          );
        })}
      </Card>

      <SectionHeader title={t('more.help')} />
      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>{t('more.appVersion')}</Text>
          <Text style={styles.hint}>{Constants.expoConfig?.version ?? '—'}</Text>
        </View>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>{t('more.apiConnection')}</Text>
          <StatusChip
            label={socketConnected ? t('more.connected') : t('more.disconnected')}
            tone={socketConnected ? 'success' : 'neutral'}
          />
        </View>
        <Text style={styles.hint} numberOfLines={1}>
          {API_ORIGIN}
        </Text>
      </Card>

      <Pressable style={styles.buttonGhost} onPress={() => void signOut()} accessibilityRole="button">
        <Text style={styles.buttonGhostText}>{t('more.signOut')}</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  vehicleRow: {
    padding: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border.subtle,
  },
  vehicleRowActive: { borderColor: color.brand.teal400, backgroundColor: `${color.brand.teal400}18` },
  vehicleText: { color: color.text.primary, fontWeight: '600' },
  vehicleHint: { color: color.text.tertiary, fontSize: 12 },
  buttonPrimary: {
    backgroundColor: color.brand.teal400,
    paddingVertical: space.buttonVertical,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  buttonPrimaryText: { ...tType.bodyStrong, color: color.text.onTeal },
  disabled: { opacity: 0.6 },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: { color: color.text.primary, fontSize: 15, fontWeight: '500' },
  hint: { color: color.text.tertiary, fontSize: 12 },
  languageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  languagePressable: { minHeight: 44, justifyContent: 'center' },
  buttonGhost: {
    backgroundColor: color.bg.surface1,
    borderColor: color.border.subtle,
    borderWidth: 1,
    paddingVertical: space.buttonVertical,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  buttonGhostText: { ...tType.bodyStrong, color: color.text.primary },
});
