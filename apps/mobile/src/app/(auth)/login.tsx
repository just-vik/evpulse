import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { isAxiosError } from 'axios';
import { useRouter } from 'expo-router';
import { colors, radius, spacing } from '@/theme/tokens';
import { useLogin } from '@/features/auth/useLogin';

export default function LoginScreen() {
  const router = useRouter();
  const { mutateAsync, isPending, error } = useLogin();
  const errMsg = error
    ? isAxiosError(error)
      ? (error.response?.data as { message?: string } | undefined)?.message ??
        error.message
      : (error as Error).message
    : null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function onSubmit() {
    await mutateAsync({ email: email.trim(), password });
    router.replace('/(app)/(tabs)');
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        <Text style={styles.eyebrow}>EVPulse</Text>
        <Text style={styles.title}>Sign in</Text>
        <Text style={styles.hint}>Use your EVPulse account. Tesla OAuth stays on the server.</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={colors.textMuted}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {errMsg ? <Text style={styles.err}>{errMsg}</Text> : null}

        <Pressable
          style={[styles.btn, isPending && styles.btnDisabled]}
          onPress={() => void onSubmit()}
          disabled={isPending}
        >
          {isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.btnText}>Continue</Text>
          )}
        </Pressable>

      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  inner: { flex: 1, padding: spacing.lg, justifyContent: 'center', gap: spacing.sm },
  eyebrow: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '700' },
  hint: { color: colors.textSecondary, fontSize: 14, marginBottom: spacing.md },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 14,
    color: colors.textPrimary,
    fontSize: 16,
  },
  btn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  btnDisabled: { opacity: 0.7 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  err: { color: colors.danger, fontSize: 13 },
});
