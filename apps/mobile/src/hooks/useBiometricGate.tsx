import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  AppStateStatus,
  StyleSheet,
  Text,
  View,
  Pressable,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { colors, radius, spacing } from '@/theme/tokens';
import { useSecurityStore } from '@/store/useSecurityStore';

interface Props {
  children: React.ReactNode;
}

export function BiometricGate({ children }: Props) {
  const enabled = useSecurityStore((s) => s.biometricLockEnabled);
  const [locked, setLocked] = useState(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const everBackground = useRef(false);

  const authenticate = useCallback(async () => {
    const has = await LocalAuthentication.hasHardwareAsync();
    if (!has) {
      setLocked(false);
      return;
    }
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!enrolled) {
      setLocked(false);
      return;
    }
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock EVPulse',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    setLocked(!res.success);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLocked(false);
      return;
    }
    const sub = AppState.addEventListener('change', (next) => {
      if (
        appState.current.match(/inactive|background/) &&
        next === 'active' &&
        everBackground.current
      ) {
        void authenticate();
      }
      if (next.match(/inactive|background/)) everBackground.current = true;
      appState.current = next;
    });
    return () => sub.remove();
  }, [enabled, authenticate]);

  if (enabled && locked) {
    return (
      <View style={styles.overlay}>
        <Text style={styles.title}>Locked</Text>
        <Text style={styles.hint}>Confirm your identity to continue.</Text>
        <Pressable style={styles.btn} onPress={() => void authenticate()}>
          <Text style={styles.btnText}>Unlock</Text>
        </Pressable>
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
    gap: spacing.sm,
    zIndex: 100,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: '700',
  },
  hint: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },
  btn: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: radius.md,
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
