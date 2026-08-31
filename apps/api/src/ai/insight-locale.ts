/**
 * Deterministic i18n text for the rule-based AI insight fallback (ai.service.ts).
 * Used whenever Groq is unavailable/misconfigured or its response can't be parsed —
 * must stay dependency-free (no LLM calls) so it is always available.
 */

export type InsightLanguage = 'en' | 'de' | 'ru';

export function normalizeInsightLanguage(language: string | null | undefined): InsightLanguage {
  const base = (language ?? 'en').split('-')[0]?.toLowerCase();
  return base === 'ru' || base === 'de' ? base : 'en';
}

export interface LocalizedInsightText {
  title: string;
  description: string;
  reasons: string[];
}

export type RuleBasedInsightId =
  | 'battery-critical'
  | 'battery-low'
  | 'battery-optimal'
  | 'health'
  | 'vampire'
  | 'efficiency-poor'
  | 'efficiency-great'
  | 'all-good';

export interface RuleBasedInsightParams {
  soc?: number;
  degradationPercent?: number;
  sohPercent?: number;
  estimatedCapacityKwh?: number;
  nominalCapacityKwh?: number;
  drainPercent?: number;
  drainPerHour?: number;
  drainTrendPerDay?: number;
  efficiency?: number;
  avgEfficiency7d?: number;
  outsideTemp?: number;
}

function fmt0(v: number | null | undefined): string {
  return Number.isFinite(v as number) ? String(Math.round(v as number)) : '?';
}
function fmt1(v: number | null | undefined): string {
  return Number.isFinite(v as number) ? (v as number).toFixed(1) : '?';
}
function fmt2(v: number | null | undefined): string {
  return Number.isFinite(v as number) ? (v as number).toFixed(2) : '?';
}

type TextBuilder = (p: RuleBasedInsightParams) => LocalizedInsightText;

const RULE_BASED_INSIGHT_TEXT: Record<RuleBasedInsightId, Record<InsightLanguage, TextBuilder>> = {
  'battery-critical': {
    en: (p) => ({
      title: 'Battery critically low',
      description: `${fmt0(p.soc)}% remaining — charge immediately.`,
      reasons: [`SOC at ${fmt0(p.soc)}%`, 'Below 10% critical threshold'],
    }),
    ru: (p) => ({
      title: 'Критически низкий заряд',
      description: `Осталось ${fmt0(p.soc)}% — зарядите автомобиль как можно скорее.`,
      reasons: [`Заряд ${fmt0(p.soc)}%`, 'Ниже критического порога 10%'],
    }),
    de: (p) => ({
      title: 'Akku kritisch niedrig',
      description: `Nur noch ${fmt0(p.soc)} % — jetzt laden!`,
      reasons: [`Ladestand ${fmt0(p.soc)} %`, 'Unter dem kritischen Grenzwert von 10 %'],
    }),
  },

  'battery-low': {
    en: (p) => ({
      title: 'Charge soon',
      description: `Battery at ${fmt0(p.soc)}% — recommend charging tonight.`,
      reasons: [
        `SOC at ${fmt0(p.soc)}%`,
        'Not currently charging',
        ...(p.avgEfficiency7d != null ? [`Avg efficiency: ${fmt0(p.avgEfficiency7d)} Wh/km`] : []),
      ],
    }),
    ru: (p) => ({
      title: 'Нужно зарядить',
      description: `Заряд ${fmt0(p.soc)}% — рекомендуется поставить на зарядку сегодня.`,
      reasons: [
        `Заряд ${fmt0(p.soc)}%`,
        'Сейчас не заряжается',
        ...(p.avgEfficiency7d != null ? [`Средний расход: ${fmt0(p.avgEfficiency7d)} Вт·ч/км`] : []),
      ],
    }),
    de: (p) => ({
      title: 'Bald laden',
      description: `Akku bei ${fmt0(p.soc)} % — heute Nacht laden empfohlen.`,
      reasons: [
        `Ladestand ${fmt0(p.soc)} %`,
        'Wird derzeit nicht geladen',
        ...(p.avgEfficiency7d != null ? [`Ø Effizienz: ${fmt0(p.avgEfficiency7d)} Wh/km`] : []),
      ],
    }),
  },

  'battery-optimal': {
    en: (p) => ({
      title: 'Battery in optimal range',
      description: `${fmt0(p.soc)}% — ideal for daily use and long-term health.`,
      reasons: [`SOC at ${fmt0(p.soc)}% (optimal: 20–80%)`, 'Not actively charging — perfect rest state'],
    }),
    ru: (p) => ({
      title: 'Батарея в оптимальном диапазоне',
      description: `${fmt0(p.soc)}% — оптимальный уровень для ежедневного использования и ресурса батареи.`,
      reasons: [`Заряд ${fmt0(p.soc)}% (оптимум: 20–80%)`, 'Не заряжается — идеальный режим покоя'],
    }),
    de: (p) => ({
      title: 'Akku im optimalen Bereich',
      description: `${fmt0(p.soc)} % – ideal für den Alltag und eine lange Batterielebensdauer.`,
      reasons: [`Ladestand ${fmt0(p.soc)} % (optimal: 20–80 %)`, 'Wird nicht geladen – idealer Ruhezustand'],
    }),
  },

  health: {
    en: (p) => ({
      title: 'Battery degradation detected',
      description: `${fmt1(p.degradationPercent)}% capacity lost (SoH: ${fmt1(p.sohPercent)}%).`,
      reasons: [
        `${fmt1(p.degradationPercent)}% capacity loss`,
        `SoH: ${fmt1(p.sohPercent)}%`,
        ...(p.estimatedCapacityKwh != null && p.nominalCapacityKwh != null
          ? [`${p.estimatedCapacityKwh.toFixed(1)} kWh of ${p.nominalCapacityKwh.toFixed(1)} kWh usable`]
          : []),
      ],
    }),
    ru: (p) => ({
      title: 'Обнаружена деградация батареи',
      description: `Потеря ёмкости ${fmt1(p.degradationPercent)}% (SoH: ${fmt1(p.sohPercent)}%).`,
      reasons: [
        `Потеря ёмкости: ${fmt1(p.degradationPercent)}%`,
        `SoH: ${fmt1(p.sohPercent)}%`,
        ...(p.estimatedCapacityKwh != null && p.nominalCapacityKwh != null
          ? [`${p.estimatedCapacityKwh.toFixed(1)} кВт·ч из ${p.nominalCapacityKwh.toFixed(1)} кВт·ч доступно`]
          : []),
      ],
    }),
    de: (p) => ({
      title: 'Batteriedegradation festgestellt',
      description: `Kapazitätsverlust ${fmt1(p.degradationPercent)} % (SoH: ${fmt1(p.sohPercent)} %).`,
      reasons: [
        `Kapazitätsverlust: ${fmt1(p.degradationPercent)} %`,
        `SoH: ${fmt1(p.sohPercent)} %`,
        ...(p.estimatedCapacityKwh != null && p.nominalCapacityKwh != null
          ? [`${p.estimatedCapacityKwh.toFixed(1)} kWh von ${p.nominalCapacityKwh.toFixed(1)} kWh nutzbar`]
          : []),
      ],
    }),
  },

  vampire: {
    en: (p) => ({
      title: (p.drainPercent ?? 0) > 8 ? 'High idle drain' : 'Idle drain',
      description: `~${fmt1(p.drainPercent)}% per parking event (${fmt2(p.drainPerHour)}%/hr).`,
      reasons: [
        `${fmt1(p.drainPercent)}% drain per event`,
        `${fmt2(p.drainPerHour)}%/hr idle drain`,
        ...(p.drainTrendPerDay != null && p.drainTrendPerDay > 0.1
          ? [`Trend: +${fmt2(p.drainTrendPerDay)}%/day worsening`]
          : []),
      ],
    }),
    ru: (p) => ({
      title: (p.drainPercent ?? 0) > 8 ? 'Высокий разряд в покое' : 'Разряд в покое',
      description: `~${fmt1(p.drainPercent)}% за парковку (${fmt2(p.drainPerHour)}%/ч).`,
      reasons: [
        `${fmt1(p.drainPercent)}% потеря за событие`,
        `${fmt2(p.drainPerHour)}%/ч в режиме покоя`,
        ...(p.drainTrendPerDay != null && p.drainTrendPerDay > 0.1
          ? [`Тренд: +${fmt2(p.drainTrendPerDay)}%/сут, ухудшается`]
          : []),
      ],
    }),
    de: (p) => ({
      title: (p.drainPercent ?? 0) > 8 ? 'Hoher Ruheverbrauch' : 'Ruheverbrauch',
      description: `~${fmt1(p.drainPercent)} % pro Parkvorgang (${fmt2(p.drainPerHour)} %/h).`,
      reasons: [
        `${fmt1(p.drainPercent)} % Verlust pro Ereignis`,
        `${fmt2(p.drainPerHour)} %/h im Ruhezustand`,
        ...(p.drainTrendPerDay != null && p.drainTrendPerDay > 0.1
          ? [`Trend: +${fmt2(p.drainTrendPerDay)} %/Tag, verschlechtert sich`]
          : []),
      ],
    }),
  },

  'efficiency-poor': {
    en: (p) => ({
      title: 'High energy use today',
      description: `${fmt0(p.efficiency)} Wh/km — cold weather or city driving.`,
      reasons: [
        `${fmt0(p.efficiency)} Wh/km today`,
        p.avgEfficiency7d != null ? `7-day avg: ${fmt0(p.avgEfficiency7d)} Wh/km` : 'Above 280 Wh/km threshold',
        ...(p.outsideTemp != null && p.outsideTemp < 5 ? [`Outside temp: ${fmt0(p.outsideTemp)}°C`] : []),
      ],
    }),
    ru: (p) => ({
      title: 'Повышенный расход сегодня',
      description: `${fmt0(p.efficiency)} Вт·ч/км — возможно, город или частые разгоны.`,
      reasons: [
        `${fmt0(p.efficiency)} Вт·ч/км сегодня`,
        p.avgEfficiency7d != null ? `Средний за 7 дней: ${fmt0(p.avgEfficiency7d)} Вт·ч/км` : 'Выше порога 280 Вт·ч/км',
        ...(p.outsideTemp != null && p.outsideTemp < 5 ? [`Температура за бортом: ${fmt0(p.outsideTemp)}°C`] : []),
      ],
    }),
    de: (p) => ({
      title: 'Hoher Energieverbrauch heute',
      description: `${fmt0(p.efficiency)} Wh/km – Stadtverkehr oder häufiges Beschleunigen könnten die Ursache sein.`,
      reasons: [
        `${fmt0(p.efficiency)} Wh/km heute`,
        p.avgEfficiency7d != null ? `7-Tage-Ø: ${fmt0(p.avgEfficiency7d)} Wh/km` : 'Über dem Schwellenwert von 280 Wh/km',
        ...(p.outsideTemp != null && p.outsideTemp < 5 ? [`Außentemperatur: ${fmt0(p.outsideTemp)}°C`] : []),
      ],
    }),
  },

  'efficiency-great': {
    en: (p) => ({
      title: 'Excellent efficiency today',
      description: `Only ${fmt0(p.efficiency)} Wh/km — great conditions!`,
      reasons: [
        `${fmt0(p.efficiency)} Wh/km today`,
        p.avgEfficiency7d != null ? `7-day avg: ${fmt0(p.avgEfficiency7d)} Wh/km` : 'Below 160 Wh/km',
      ],
    }),
    ru: (p) => ({
      title: 'Отличная эффективность сегодня',
      description: `Всего ${fmt0(p.efficiency)} Вт·ч/км — отличные условия для поездки!`,
      reasons: [
        `${fmt0(p.efficiency)} Вт·ч/км сегодня`,
        p.avgEfficiency7d != null ? `Средний за 7 дней: ${fmt0(p.avgEfficiency7d)} Вт·ч/км` : 'Ниже 160 Вт·ч/км',
      ],
    }),
    de: (p) => ({
      title: 'Ausgezeichnete Effizienz heute',
      description: `Nur ${fmt0(p.efficiency)} Wh/km – hervorragende Fahrbedingungen!`,
      reasons: [
        `${fmt0(p.efficiency)} Wh/km heute`,
        p.avgEfficiency7d != null ? `7-Tage-Ø: ${fmt0(p.avgEfficiency7d)} Wh/km` : 'Unter 160 Wh/km',
      ],
    }),
  },

  'all-good': {
    en: () => ({
      title: 'Everything looks great',
      description: 'Battery, health, and efficiency all within normal ranges.',
      reasons: ['SOC within normal range', 'No anomalies detected'],
    }),
    ru: () => ({
      title: 'Всё в порядке',
      description: 'Заряд, состояние батареи и эффективность в норме.',
      reasons: ['Заряд в норме', 'Аномалий не обнаружено'],
    }),
    de: () => ({
      title: 'Alles in Ordnung',
      description: 'Akku, Zustand und Effizienz sind im Normalbereich.',
      reasons: ['Ladestand im Normalbereich', 'Keine Auffälligkeiten festgestellt'],
    }),
  },
};

/**
 * Deterministic (no-LLM) localized text for a rule-based fallback insight.
 * Unknown language codes normalize to English; this never throws.
 */
export function localizeRuleBasedInsight(
  id: RuleBasedInsightId,
  language: string | null | undefined,
  params: RuleBasedInsightParams,
): LocalizedInsightText {
  const lang = normalizeInsightLanguage(language);
  return RULE_BASED_INSIGHT_TEXT[id][lang](params);
}
