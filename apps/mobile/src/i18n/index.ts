import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';
import AsyncStorage from '@react-native-async-storage/async-storage';

import en from './locales/en.json';
import de from './locales/de.json';
import ru from './locales/ru.json';
import {
  SUPPORTED_LANGUAGES,
  FALLBACK_LANGUAGE,
  resolveLanguage,
  normalizeLanguageTag,
  type SupportedLanguage,
} from './resolveLanguage';

export { SUPPORTED_LANGUAGES, FALLBACK_LANGUAGE, resolveLanguage, type SupportedLanguage };

const STORAGE_KEY = 'evpulse_language';

const resources = {
  en: { translation: en },
  de: { translation: de },
  ru: { translation: ru },
};

async function readStoredPreferenceRaw(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function getStoredLanguage(): Promise<SupportedLanguage | null> {
  return normalizeLanguageTag(await readStoredPreferenceRaw());
}

function getDeviceLocaleTags(): string[] {
  return Localization.getLocales().map((l) => l.languageTag ?? l.languageCode ?? '');
}

/** Explicit user choice always wins over device locale; persisted for next launch;
 *  applied immediately (no app restart needed) via `i18n.changeLanguage`. */
export async function setLanguage(lang: SupportedLanguage): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, lang);
  await i18n.changeLanguage(lang);
}

let initPromise: Promise<void> | null = null;

/** Locale priority: explicit stored user preference → device locale → 'en' fallback. */
export function initI18n(): Promise<void> {
  if (i18n.isInitialized) return Promise.resolve();
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const storedRaw = await readStoredPreferenceRaw();
    const initialLanguage = resolveLanguage(storedRaw, getDeviceLocaleTags());

    await i18n.use(initReactI18next).init({
      resources,
      lng: initialLanguage,
      fallbackLng: FALLBACK_LANGUAGE,
      supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
      interpolation: { escapeValue: false },
      returnEmptyString: false,
    });
  })();

  return initPromise;
}

export default i18n;
