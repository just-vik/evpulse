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
import { useTranslation } from 'react-i18next';
import { color, radius, space, type as tType } from '@/theme/tokens';
import { useSecurityStore } from '@/store/useSecurityStore';

interface Props {
  children: React.ReactNode;
}

export function BiometricGate({ children }: Props) {
  const { t } = useTranslation();
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
      promptMessage: t('biometric.unlockPrompt'),
      cancelLabel: t('biometric.cancel'),
      disableDeviceFallback: false,
    });
    setLocked(!res.success);
  }, [t]);

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
        <Text style={styles.title}>{t('biometric.locked')}</Text>
        <Text style={styles.hint}>{t('biometric.confirmIdentity')}</Text>
        <Pressable style={styles.btn} onPress={() => void authenticate()} accessibilityRole="button">
          <Text style={styles.btnText}>{t('biometric.unlock')}</Text>
        </Pressable>
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: color.bg.app,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.lg,
    gap: space.sm,
    zIndex: 100,
  },
  title: {
    ...tType.h2,
    color: color.text.primary,
  },
  hint: {
    color: color.text.secondary,
    fontSize: 14,
    textAlign: 'center',
  },
  btn: {
    marginTop: space.md,
    backgroundColor: color.brand.teal400,
    paddingVertical: space.buttonVertical,
    paddingHorizontal: space.xl,
    borderRadius: radius.md,
  },
  btnText: {
    ...tType.bodyStrong,
    color: color.text.onTeal,
    fontSize: 16,
  },
});
