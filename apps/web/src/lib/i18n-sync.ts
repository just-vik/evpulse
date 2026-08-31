import i18n from '@/lib/i18n';

const LOCALE_COOKIE = 'NEXT_LOCALE';
const MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Apply UI language immediately (not only via I18nProvider effects).
 * Keeps i18next, <html lang>, and a cookie in sync for reloads / SSR.
 */
export function applyLanguagePreference(lang: string | undefined) {
  const lng = lang ?? 'en';
  if (typeof window === 'undefined') return;
  void i18n.changeLanguage(lng);
  document.documentElement.lang = lng;
  try {
    document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(lng)};path=/;max-age=${MAX_AGE};samesite=lax`;
  } catch {
    /* ignore */
  }
}
