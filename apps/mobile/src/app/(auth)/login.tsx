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
import { useTranslation } from 'react-i18next';
import { color, radius, space, type as tType } from '@/theme/tokens';
import { Wordmark } from '@/components/ui/Wordmark';
import { useLogin } from '@/features/auth/useLogin';

export default function LoginScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { mutateAsync, isPending, error } = useLogin();
  const errMsg = error
    ? isAxiosError(error)
      ? (error.response?.data as { message?: string } | undefined)?.message ?? error.message
      : (error as Error).message
    : null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function onSubmit() {
    await mutateAsync({ email: email.trim(), password });
    router.replace('/(app)/(tabs)');
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.inner}>
        <Wordmark size="large" />
        <Text style={styles.title}>{t('login.signIn')}</Text>
        <Text style={styles.hint}>{t('login.hint')}</Text>

        <TextInput
          style={styles.input}
          placeholder={t('login.email') ?? undefined}
          placeholderTextColor={color.text.tertiary}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder={t('login.password') ?? undefined}
          placeholderTextColor={color.text.tertiary}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {errMsg ? <Text style={styles.err}>{errMsg}</Text> : null}

        <Pressable
          style={[styles.btn, isPending && styles.btnDisabled]}
          onPress={() => void onSubmit()}
          disabled={isPending}
          accessibilityRole="button"
        >
          {isPending ? (
            <ActivityIndicator color={color.text.onTeal} />
          ) : (
            <Text style={styles.btnText}>{t('login.continue')}</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg.app },
  inner: { flex: 1, padding: space.lg, justifyContent: 'center', gap: space.sm },
  title: { ...tType.h1, color: color.text.primary, marginTop: space.lg },
  hint: { color: color.text.secondary, fontSize: 14, marginBottom: space.md },
  input: {
    backgroundColor: color.bg.surface1,
    borderWidth: 1,
    borderColor: color.border.subtle,
    borderRadius: radius.md,
    padding: 14,
    color: color.text.primary,
    fontSize: 16,
  },
  btn: {
    backgroundColor: color.brand.teal400,
    borderRadius: radius.md,
    paddingVertical: space.buttonVertical,
    alignItems: 'center',
    marginTop: space.sm,
  },
  btnDisabled: { opacity: 0.7 },
  btnText: { ...tType.bodyStrong, color: color.text.onTeal, fontSize: 16 },
  err: { color: color.semantic.danger, fontSize: 13 },
});
