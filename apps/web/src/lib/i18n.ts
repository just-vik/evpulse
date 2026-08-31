import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from '@/locales/en.json';
import de from '@/locales/de.json';
import ru from '@/locales/ru.json';

/** Must match `name` in uiStore persist + keys inside the persisted JSON */
const UI_STORAGE_KEY = 'ui-storage';
const SUPPORTED_LANGUAGES = ['en', 'de', 'ru'] as const;

function readLanguageFromUiStorage(): (typeof SUPPORTED_LANGUAGES)[number] {
  if (typeof window === 'undefined') return 'en';
  try {
    const m = document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/);
    if (m) {
      const fromCookie = decodeURIComponent(m[1]);
      if ((SUPPORTED_LANGUAGES as readonly string[]).includes(fromCookie)) {
        return fromCookie as (typeof SUPPORTED_LANGUAGES)[number];
      }
    }
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return 'en';
    const parsed = JSON.parse(raw) as {
      state?: { preferences?: { language?: string } };
    };
    const lang = parsed.state?.preferences?.language;
    if (typeof lang === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) {
      return lang as (typeof SUPPORTED_LANGUAGES)[number];
    }
  } catch {
    /* ignore */
  }
  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    de: { translation: de },
    ru: { translation: ru },
  },
  lng: readLanguageFromUiStorage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  pluralSeparator: '_',
  react: { useSuspense: false },
});

export default i18n;
