'use client';

import { useEffect } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/lib/i18n';
import { applyLanguagePreference } from '@/lib/i18n-sync';
import { useUIStore } from '@/stores/uiStore';

function syncI18nFromStore() {
  applyLanguagePreference(useUIStore.getState().preferences.language);
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const language = useUIStore((s) => s.preferences.language);
  const lng = language ?? 'en';

  // After persist rehydrates, apply the real language (avoid overwriting localStorage
  // language with default `en` before hydration completes).
  useEffect(() => {
    if (useUIStore.persist.hasHydrated()) {
      syncI18nFromStore();
    }
    return useUIStore.persist.onFinishHydration(() => {
      syncI18nFromStore();
    });
  }, []);

  useEffect(() => {
    if (!useUIStore.persist.hasHydrated()) return;
    syncI18nFromStore();
  }, [lng]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
