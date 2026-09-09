/**
 * Translation-key parity check for the battery-honesty UI fix.
 *
 * Not an api test — reads apps/web and apps/mobile locale JSON directly from
 * disk (Jest can read any path regardless of which app "owns" the test dir;
 * neither web nor mobile has its own test runner configured in this repo).
 * Prevents the classic i18n regression where a key exists in en.json but was
 * never added to ru.json/de.json, silently falling back to raw key names or
 * English text for those locales in production.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function loadJson(relPath: string): any {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8'));
}

function expectNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected a non-empty string for ${label}, got: ${JSON.stringify(value)}`);
  }
}

describe('battery honesty UI — translation key parity', () => {
  it('web: en/ru/de all define battery.pendingBaseline and battery.insufficient', () => {
    const locales = {
      en: loadJson('apps/web/src/locales/en.json'),
      ru: loadJson('apps/web/src/locales/ru.json'),
      de: loadJson('apps/web/src/locales/de.json'),
    };
    for (const [lang, dict] of Object.entries(locales)) {
      expectNonEmptyString(dict.battery?.pendingBaseline, `${lang}: battery.pendingBaseline`);
      expectNonEmptyString(dict.battery?.insufficient, `${lang}: battery.insufficient`);
      expectNonEmptyString(dict.battery?.estimatedSoh, `${lang}: battery.estimatedSoh`);
    }
  });

  it('mobile: en/ru/de all define insights.pendingBaseline, insights.estStateOfHealth, insights.needMoreChargesForBaseline', () => {
    const locales = {
      en: loadJson('apps/mobile/src/i18n/locales/en.json'),
      ru: loadJson('apps/mobile/src/i18n/locales/ru.json'),
      de: loadJson('apps/mobile/src/i18n/locales/de.json'),
    };
    for (const [lang, dict] of Object.entries(locales)) {
      expectNonEmptyString(dict.insights?.pendingBaseline, `${lang}: insights.pendingBaseline`);
      expectNonEmptyString(dict.insights?.estStateOfHealth, `${lang}: insights.estStateOfHealth`);
      // i18next pluralization: English/German only need _one/_other; Russian also needs _few/_many.
      expectNonEmptyString(dict.insights?.needMoreChargesForBaseline_one, `${lang}: needMoreChargesForBaseline_one`);
      expectNonEmptyString(dict.insights?.needMoreChargesForBaseline_other, `${lang}: needMoreChargesForBaseline_other`);
    }
    expectNonEmptyString(locales.ru.insights?.needMoreChargesForBaseline_few, 'ru: needMoreChargesForBaseline_few');
    expectNonEmptyString(locales.ru.insights?.needMoreChargesForBaseline_many, 'ru: needMoreChargesForBaseline_many');
  });
});
