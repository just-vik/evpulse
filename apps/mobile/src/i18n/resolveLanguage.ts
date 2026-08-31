/**
 * Pure, dependency-free locale resolution logic — deliberately has NO import
 * of AsyncStorage/expo-localization/i18next, so it can be unit-tested (or,
 * absent a mobile test runner, executed directly with plain `node`/`tsc`)
 * without any native/RN mocking. `index.ts` is the only I/O-performing
 * caller: it reads the raw stored value and the device locale tags, then
 * hands both to `resolveLanguage` below.
 */

export const SUPPORTED_LANGUAGES = ['en', 'de', 'ru'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export const FALLBACK_LANGUAGE: SupportedLanguage = 'en';

/** Normalizes a BCP-47 tag (e.g. 'ru-RU', 'de-DE', 'en-US') to a supported base language. */
export function normalizeLanguageTag(tag: string | null | undefined): SupportedLanguage | null {
  if (!tag) return null;
  const base = tag.split('-')[0].toLowerCase();
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base)
    ? (base as SupportedLanguage)
    : null;
}

/**
 * Locale priority: explicit stored user preference → device locale → 'en' fallback.
 *
 * `storedPreference` is the RAW value read from persistent storage:
 *  - `null`/`undefined` means "the user has never chosen a language yet" — falls
 *    through to device locale, then to 'en'.
 *  - an explicit `'en'` (or any normalizable tag) is a real, deliberate user
 *    choice and wins outright, even when the device locale is 'de' or 'ru' —
 *    it is never treated as "no preference" / silently overridden by device locale.
 */
export function resolveLanguage(
  storedPreference: string | null | undefined,
  deviceLocaleTags: readonly (string | null | undefined)[],
): SupportedLanguage {
  const explicit = normalizeLanguageTag(storedPreference);
  if (explicit) return explicit;

  for (const tag of deviceLocaleTags) {
    const normalized = normalizeLanguageTag(tag);
    if (normalized) return normalized;
  }

  return FALLBACK_LANGUAGE;
}
