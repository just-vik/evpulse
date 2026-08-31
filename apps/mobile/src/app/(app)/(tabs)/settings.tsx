import { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Switch,
  Alert,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { colors, spacing, radius } from '@/theme/tokens';
import { useAuthStore } from '@/store/authStore';
import { useSecurityStore } from '@/store/useSecurityStore';
import { useTeslaOAuth } from '@/features/auth/useTeslaOAuth';
import { useVehicleSummary } from '@/features/vehicles/useVehicleSummary';

export default function SettingsScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const clearSession = useAuthStore((s) => s.clearSession);
  const biometricLockEnabled = useSecurityStore((s) => s.biometricLockEnabled);
  const setBiometricLockEnabled = useSecurityStore((s) => s.setBiometricLockEnabled);
  const { connectTesla, pollTeslaStatus, busy } = useTeslaOAuth();
  const { vehiclesQuery, vehicleId, setSelectedVehicleId } = useVehicleSummary();
  const [polling, setPolling] = useState(false);

  const onConnectTesla = useCallback(async () => {
    const res = await connectTesla();
    if (!res.ok) {
      Alert.alert('Tesla', 'Could not start Tesla linking.');
      return;
    }
    Alert.alert(
      'Tesla',
      'Complete sign-in in the browser, then return here. We will check your connection.',
      [
        {
          text: 'Check status',
          onPress: async () => {
            setPolling(true);
            for (let i = 0; i < 12; i++) {
              await new Promise((r) => setTimeout(r, 2000));
              try {
                const ok = await pollTeslaStatus();
                if (ok) {
                  await vehiclesQuery.refetch();
                  Alert.alert('Tesla', 'Connected.');
                  setPolling(false);
                  return;
                }
              } catch {
                /* retry */
              }
            }
            setPolling(false);
            Alert.alert('Tesla', 'Not connected yet — try again in a minute.');
          },
        },
      ],
    );
  }, [connectTesla, pollTeslaStatus, vehiclesQuery]);

  const onToggleBio = async (v: boolean) => {
    if (v) {
      const has = await LocalAuthentication.hasHardwareAsync();
      if (!has) {
        Alert.alert('Biometrics', 'No biometric hardware available.');
        return;
      }
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!enrolled) {
        Alert.alert('Biometrics', 'Enroll Face ID / fingerprint in system settings first.');
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.sub}>Account · Tesla · security</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Vehicle</Text>
        {vehiclesQuery.isLoading ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          (vehiclesQuery.data ?? []).map((v) => (
            <Pressable
              key={v.id}
              style={[
                styles.vehicleRow,
                vehicleId === v.id && styles.vehicleRowActive,
              ]}
              onPress={() => void setSelectedVehicleId(v.id)}
            >
              <Text style={styles.vehicleText}>{v.displayName ?? v.model}</Text>
              <Text style={styles.vehicleHint}>{v.id.slice(0, 8)}…</Text>
            </Pressable>
          ))
        )}
      </View>

      <Pressable
        style={[styles.buttonPrimary, (busy || polling) && styles.disabled]}
        onPress={() => void onConnectTesla()}
        disabled={busy || polling}
      >
        <Text style={styles.buttonPrimaryText}>
          {polling ? 'Checking Tesla…' : 'Connect Tesla (browser)'}
        </Text>
      </Pressable>

      <View style={styles.rowBetween}>
        <Text style={styles.label}>Biometric app lock</Text>
        <Switch
          value={biometricLockEnabled}
          onValueChange={(v) => void onToggleBio(v)}
          trackColor={{ false: colors.border, true: colors.primary }}
        />
      </View>
      <Text style={styles.hint}>
        When enabled, returning from background requires Face ID / fingerprint.
      </Text>

      <Pressable style={styles.buttonGhost} onPress={() => void signOut()}>
        <Text style={styles.buttonGhostText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '700' },
  sub: { color: colors.textSecondary, fontSize: 14 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardTitle: { color: colors.textPrimary, fontWeight: '600', marginBottom: spacing.xs },
  vehicleRow: {
    padding: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  vehicleRowActive: { borderColor: colors.primary, backgroundColor: `${colors.primary}18` },
  vehicleText: { color: colors.textPrimary, fontWeight: '600' },
  vehicleHint: { color: colors.textMuted, fontSize: 12 },
  buttonPrimary: {
    backgroundColor: colors.primary,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  buttonPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.6 },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  label: { color: colors.textPrimary, fontSize: 15, fontWeight: '500' },
  hint: { color: colors.textMuted, fontSize: 12 },
  buttonGhost: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  buttonGhostText: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
});
