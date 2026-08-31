import { AiService, InsightContext, isRuLanguageCompliant } from '../src/ai/ai.service';

function baseContext(overrides: Partial<InsightContext> = {}): InsightContext {
  return {
    vehicleId: 'veh-1',
    soc: null,
    chargingState: null,
    vehicleState: null,
    outsideTemp: null,
    batteryRangeKm: null,
    sohPercent: null,
    degradationPercent: null,
    estimatedCapacityKwh: null,
    nominalCapacityKwh: null,
    tripCount: 0,
    distanceKm: 0,
    energyKwh: 0,
    efficiencyWhKm: null,
    chargingSessions: 0,
    chargingEnergyKwh: 0,
    totalCost: null,
    costPerKm: null,
    vampireDrainPct: null,
    vampireDrainPerHr: null,
    ...overrides,
  };
}

function makeService(groqApiKey: string | undefined = undefined) {
  const config = { get: jest.fn().mockReturnValue(groqApiKey) } as any;
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) } as any;
  const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() } as any;
  return new AiService(config, prisma, redis);
}

describe('AiService.ruleBasedInsights — локализация детерминированного fallback', () => {
  it('efficiency-great: RU показывает точное число в Вт·ч/км', () => {
    const service = makeService();
    const ctx = baseContext({ language: 'ru', efficiencyWhKm: 126, distanceKm: 40 });
    const insights = (service as any).ruleBasedInsights(ctx);
    const insight = insights.find((i: any) => i.id === 'efficiency-great');

    expect(insight).toBeDefined();
    expect(insight.title).toBe('Отличная эффективность сегодня');
    expect(insight.description).toContain('126');
    expect(insight.description).toContain('Вт·ч/км');
    expect(insight.description).not.toContain('Wh/km');
    expect(insight.params).toEqual({ efficiency: 126 });
  });

  it('efficiency-great: DE показывает точное число в Wh/km', () => {
    const service = makeService();
    const ctx = baseContext({ language: 'de', efficiencyWhKm: 126, distanceKm: 40 });
    const insights = (service as any).ruleBasedInsights(ctx);
    const insight = insights.find((i: any) => i.id === 'efficiency-great');

    expect(insight.title).toBe('Ausgezeichnete Effizienz heute');
    expect(insight.description).toContain('126');
    expect(insight.description).toContain('Wh/km');
  });

  it('efficiency-great: EN сохраняет исходный текст и число', () => {
    const service = makeService();
    const ctx = baseContext({ language: 'en', efficiencyWhKm: 126, distanceKm: 40 });
    const insights = (service as any).ruleBasedInsights(ctx);
    const insight = insights.find((i: any) => i.id === 'efficiency-great');

    expect(insight.title).toBe('Excellent efficiency today');
    expect(insight.description).toBe('Only 126 Wh/km — great conditions!');
  });

  it('battery-optimal: RU/DE/EN содержат точный SOC (39%)', () => {
    for (const [language, expectedTitle] of [
      ['ru', 'Батарея в оптимальном диапазоне'],
      ['de', 'Akku im optimalen Bereich'],
      ['en', 'Battery in optimal range'],
    ] as const) {
      const service = makeService();
      const ctx = baseContext({ language, soc: 39, chargingState: 'Disconnected' });
      const insights = (service as any).ruleBasedInsights(ctx);
      const insight = insights.find((i: any) => i.id === 'battery-optimal');

      expect(insight.title).toBe(expectedTitle);
      expect(insight.description).toContain('39');
      expect(insight.params).toEqual({ soc: 39 });
    }
  });

  it('battery-critical: локализуется и сохраняет id/severity/icon/priority независимо от языка', () => {
    const results = (['ru', 'de', 'en'] as const).map((language) => {
      const service = makeService();
      const ctx = baseContext({ language, soc: 8 });
      return (service as any).ruleBasedInsights(ctx).find((i: any) => i.id === 'battery-critical');
    });

    for (const insight of results) {
      expect(insight.id).toBe('battery-critical');
      expect(insight.severity).toBe('danger');
      expect(insight.icon).toBe('BatteryWarning');
      expect(insight.priority).toBe(100);
      expect(insight.description).toContain('8');
    }
    // Titles must actually differ across languages (i.e. really localized, not identical fallback text)
    const titles = new Set(results.map((r) => r.title));
    expect(titles.size).toBe(3);
  });

  it('vampire: RU использует "%/ч", DE использует "%/h", EN использует "%/hr"', () => {
    const ctxOverrides = { vampireDrainPct: 6.2, vampireDrainPerHr: 0.31 };
    const ru = (makeService() as any).ruleBasedInsights(baseContext({ language: 'ru', ...ctxOverrides })).find((i: any) => i.id === 'vampire');
    const de = (makeService() as any).ruleBasedInsights(baseContext({ language: 'de', ...ctxOverrides })).find((i: any) => i.id === 'vampire');
    const en = (makeService() as any).ruleBasedInsights(baseContext({ language: 'en', ...ctxOverrides })).find((i: any) => i.id === 'vampire');

    expect(ru.description).toContain('%/ч');
    expect(de.description).toContain('%/h');
    expect(en.description).toContain('%/hr');
    expect(ru.params).toEqual({ drainPercent: 6.2, drainPerHour: 0.31 });
  });

  it('неизвестный язык (fr) откатывается на английский текст', () => {
    const service = makeService();
    const ctx = baseContext({ language: 'fr', efficiencyWhKm: 126, distanceKm: 40 });
    const insights = (service as any).ruleBasedInsights(ctx);
    const insight = insights.find((i: any) => i.id === 'efficiency-great');

    expect(insight.title).toBe('Excellent efficiency today');
  });

  it('all-good: без аномалий возвращает единственную локализованную карточку без чисел', () => {
    const ru = (makeService() as any).ruleBasedInsights(baseContext({ language: 'ru' }));
    expect(ru).toHaveLength(1);
    expect(ru[0].id).toBe('all-good');
    expect(ru[0].title).toBe('Всё в порядке');
  });
});

describe('AiService.generateInsights — Groq недоступен → детерминированный локализованный fallback', () => {
  it('без GROQ_API_KEY использует ruleBasedInsights на выбранном языке', async () => {
    const service = makeService(undefined); // no key configured → this.client stays null
    const result = await service.generateInsights(
      baseContext({ language: 'ru', efficiencyWhKm: 126, distanceKm: 40 }),
    );

    const insight = result.find((i) => i.id === 'efficiency-great');
    expect(insight).toBeDefined();
    expect(insight!.title).toBe('Отличная эффективность сегодня');
  });

  it('при ошибке вызова Groq откатывается на ruleBasedInsights на выбранном языке', async () => {
    const service = makeService('fake-key');
    // Force the configured Groq client to fail, exercising the catch → ruleBasedInsights path
    (service as any).client = {
      chat: { completions: { create: jest.fn().mockRejectedValue(new Error('groq unavailable')) } },
    };

    const result = await service.generateInsights(
      baseContext({ language: 'de', efficiencyWhKm: 126, distanceKm: 40 }),
    );

    const insight = result.find((i) => i.id === 'efficiency-great');
    expect(insight).toBeDefined();
    expect(insight!.title).toBe('Ausgezeichnete Effizienz heute');
    expect(insight!.description).toContain('Wh/km');
  });
});

describe('isRuLanguageCompliant — Cyrillic script guard', () => {
  it('true когда весь текст содержит кириллицу', () => {
    expect(isRuLanguageCompliant([
      { id: 'a', severity: 'info', icon: 'Zap', title: 'Хорошие новости', description: 'Всё в порядке.', priority: 10 },
      { id: 'b', severity: 'info', icon: 'Zap', title: 'Заряд 80%', description: 'Норма.', priority: 10 },
    ])).toBe(true);
  });

  it('false когда хотя бы одна карточка полностью латиницей (модель проигнорировала инструкцию)', () => {
    expect(isRuLanguageCompliant([
      { id: 'a', severity: 'info', icon: 'Zap', title: 'Хорошие новости', description: 'Всё в порядке.', priority: 10 },
      { id: 'b', severity: 'info', icon: 'Zap', title: 'Good news', description: 'Everything is fine.', priority: 10 },
    ])).toBe(false);
  });

  it('true для пустого массива (нечего проверять)', () => {
    expect(isRuLanguageCompliant([])).toBe(true);
  });
});

describe('AiService.generateInsights — Groq игнорирует language=ru → откат на ruleBasedInsights', () => {
  function makeGroqResponse(items: Array<Record<string, any>>) {
    return {
      choices: [{ message: { content: JSON.stringify(items) } }],
    };
  }

  it('английский ответ Groq при language=ru отбрасывается, используется детерминированный RU fallback', async () => {
    const service = makeService('fake-key');
    (service as any).client = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue(makeGroqResponse([
            { severity: 'success', icon: 'TrendingDown', title: 'Excellent efficiency today', description: 'Only 126 Wh/km — great conditions!', priority: 20 },
          ])),
        },
      },
    };

    const result = await service.generateInsights(
      baseContext({ language: 'ru', efficiencyWhKm: 126, distanceKm: 40 }),
    );

    // Fell back to the deterministic RU rule-based engine — id is a real rule id, not 'ai-0'.
    const insight = result.find((i) => i.id === 'efficiency-great');
    expect(insight).toBeDefined();
    expect(insight!.title).toBe('Отличная эффективность сегодня');
    expect(result.some((i) => i.id === 'ai-0')).toBe(false);
  });

  it('корректный кириллический ответ Groq при language=ru НЕ переопределяется', async () => {
    const service = makeService('fake-key');
    (service as any).client = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue(makeGroqResponse([
            { severity: 'success', icon: 'TrendingDown', title: 'Отличная эффективность', description: 'Всего 126 Вт·ч/км — отлично!', priority: 20 },
          ])),
        },
      },
    };

    const result = await service.generateInsights(
      baseContext({ language: 'ru', efficiencyWhKm: 126, distanceKm: 40 }),
    );

    const insight = result.find((i) => i.id === 'ai-0');
    expect(insight).toBeDefined();
    expect(insight!.title).toBe('Отличная эффективность');
  });

  it('английский ответ Groq при language=de НЕ триггерит проверку (охват — только ru)', async () => {
    const service = makeService('fake-key');
    (service as any).client = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue(makeGroqResponse([
            { severity: 'success', icon: 'TrendingDown', title: 'Excellent efficiency today', description: 'Only 126 Wh/km!', priority: 20 },
          ])),
        },
      },
    };

    const result = await service.generateInsights(
      baseContext({ language: 'de', efficiencyWhKm: 126, distanceKm: 40 }),
    );

    // Passed through unchanged — de/Latin-script languages aren't covered by this guard.
    const insight = result.find((i) => i.id === 'ai-0');
    expect(insight).toBeDefined();
    expect(insight!.title).toBe('Excellent efficiency today');
  });
});
