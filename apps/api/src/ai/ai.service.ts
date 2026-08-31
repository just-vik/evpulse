import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { localizeRuleBasedInsight, type RuleBasedInsightParams } from './insight-locale';

export interface InsightContext {
  vehicleId: string
  userId?: string            // set server-side from JWT, not from client
  // Current state
  soc: number | null
  chargingState: string | null
  vehicleState: string | null
  outsideTemp: number | null
  batteryRangeKm: number | null
  // Health
  sohPercent: number | null
  degradationPercent: number | null
  estimatedCapacityKwh: number | null
  nominalCapacityKwh: number | null
  // Today's driving
  tripCount: number
  distanceKm: number
  energyKwh: number
  efficiencyWhKm: number | null
  // 30-day aggregates
  chargingSessions: number
  chargingEnergyKwh: number
  totalCost: number | null
  costPerKm: number | null
  // Vampire drain
  vampireDrainPct: number | null
  vampireDrainPerHr: number | null
  // Historical trends (7-day / 3-day)
  avgEfficiency7d?: number | null
  drainTrend3d?: number | null    // positive = drain worsening
  chargingPattern?: string | null // 'overnight' | 'frequent' | 'irregular'
  language?: string | null        // 'en' | 'de' | 'fr' | 'ru' | 'es' — response language
  dataQuality?: 'REALTIME' | 'DELAYED' | 'STALE' | 'OFFLINE' | null
  dataFreshnessSec?: number | null
  historicalSummaries?: string[]  // RAG: weekly summaries retrieved by vector search
}

export interface AIInsight {
  id: string
  severity: 'info' | 'success' | 'warning' | 'danger'
  icon: string
  title: string
  description: string
  reasons?: string[]         // explainability: why this insight was generated
  confidence?: number        // 0-100, how confident the AI is
  anomalyScore?: number      // 0-100, how abnormal the underlying data is
  action?: {
    type: 'navigate' | 'command' | 'ai'
    href?: string
    command?: string
    prompt?: string
    label: string
  }
  priority: number
  /**
   * Raw numeric values behind this insight's text (e.g. { soc: 23 }), present only
   * for the deterministic rule-based fallback. Lets the client re-localize the card
   * client-side (with its own i18n dictionary) instead of trusting server text as final.
   */
  params?: Record<string, number>
}

// Intent types for chat → action bridge
export interface ParsedIntent {
  type: 'command' | 'query' | 'navigate' | 'unknown'
  command?: string
  href?: string
  confidence: number          // 0-1
  originalMessage: string
}

// ─── AI language compliance ────────────────────────────────────────────────
// The prompt's LANGUAGE INSTRUCTION (buildPrompt) asks the model to respond in the
// requested language, but nothing enforces it — LLMs sometimes ignore instructions.
// For Cyrillic-script languages this is cheaply and reliably checkable: real Russian
// insight text always contains Cyrillic characters, so their total absence is a strong
// signal the model answered in English anyway. This can't be extended to de/other
// Latin-script languages the same way (no character-set difference from English), so
// it's deliberately scoped to `ru` only — a real but narrower gap than full coverage.
const CYRILLIC_RE = /[Ѐ-ӿ]/;

export function isRuLanguageCompliant(insights: AIInsight[]): boolean {
  return insights.every(i => CYRILLIC_RE.test(`${i.title} ${i.description}`));
}

// ─── Scoring constants ─────────────────────────────────────────────────────
const REJECTION_PENALTY = 15;      // per rejection
const MAX_REJECTION_PENALTY = 45;  // cap
const SEVERITY_BONUS: Record<string, number> = {
  danger: 20, warning: 10, success: 0, info: 0,
};
const ANOMALY_BOOST_PER_POINT = 5; // per anomaly score unit (0-100 → 0-500, capped)
const FEEDBACK_WINDOW_DAYS = 30;
// Suppression TTL: danger=never, warning=4h, info/success=24h
const SUPPRESSION_TTL_S: Record<string, number> = {
  danger:  0,         // never suppress critical insights
  warning: 4 * 3600,
  info:    24 * 3600,
  success: 24 * 3600,
};

// ─── Intent patterns ──────────────────────────────────────────────────────
const INTENT_PATTERNS: Array<{
  regex: RegExp;
  type: ParsedIntent['type'];
  command?: string;
  href?: string;
  confidence: number;
}> = [
  { regex: /\b(i.?m cold|warm\s*up|heat|preheat|climate on|start\s*heat)\b/i, type: 'command', command: 'auto_conditioning_start', confidence: 0.85 },
  { regex: /\b(too\s*hot|cool\s*down|ac\s*on|cooling|stop\s*heat)\b/i, type: 'command', command: 'auto_conditioning_stop', confidence: 0.80 },
  { regex: /\b(start\s*charg|begin\s*charg|charge\s*now|plug\s*in|start\s*plug)\b/i, type: 'command', command: 'charge_start', confidence: 0.90 },
  { regex: /\b(stop\s*charg|unplug|pause\s*charg|end\s*charg)\b/i, type: 'command', command: 'charge_stop', confidence: 0.90 },
  { regex: /\b(lock\s*(it|car|vehicle|up|doors?)?|secure\s*(it|car)?)\b/i, type: 'command', command: 'door_lock', confidence: 0.80 },
  { regex: /\b(flash|blink\s*(lights?)?|find\s*(my\s*)?car)\b/i, type: 'command', command: 'flash_lights', confidence: 0.75 },
  { regex: /\b(battery|health|soh|degradation)\b/i, type: 'navigate', href: '/battery', confidence: 0.70 },
  { regex: /\b(trip[s]?|driving|efficiency|km|mile)\b/i, type: 'navigate', href: '/trips', confidence: 0.65 },
  { regex: /\b(charg(ing|e[sd]?)\s*(histor|session|cost|log))\b/i, type: 'navigate', href: '/charging', confidence: 0.65 },
];

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: Groq | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    const key = config.get<string>('GROQ_API_KEY');
    if (key) {
      this.client = new Groq({ apiKey: key });
      this.logger.log('Groq AI client initialized');
    } else {
      this.logger.warn('GROQ_API_KEY not set — AI insights will use rule-based fallback');
    }
  }

  // ─── Context builder ──────────────────────────────────────────────────────

  /**
   * Auto-build InsightContext from DB for a given vehicleId.
   * Used by the chat endpoint so the frontend only needs to send vehicleId.
   */
  async buildContextForVehicle(vehicleId: string): Promise<Partial<InsightContext>> {
    const since7d  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const since3d  = new Date(Date.now() - 3  * 24 * 60 * 60 * 1000);

    const [telemetry, vehicleState, batteryHealth, todayTrips, charging30d, drainLogs7d, drainLogs3d] = await Promise.all([
      this.prisma.telemetryPoint.findFirst({
        where: { vehicleId },
        orderBy: { timestamp: 'desc' },
        select: { soc: true, batteryRangeKm: true, outsideTemp: true },
      }),
      this.prisma.vehicleState.findUnique({
        where: { vehicleId },
        select: { state: true, chargingState: true },
      }),
      this.prisma.batteryHealth.findFirst({
        where: { vehicleId },
        orderBy: { timestamp: 'desc' },
        select: { sohPercent: true, degradationPercent: true, estimatedCapacityKwh: true, nominalCapacityKwh: true },
      }),
      this.prisma.trip.findMany({
        where: {
          vehicleId,
          startTime: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          endTime: { not: null },
        },
        select: { distanceKm: true, energyUsedKwh: true },
      }),
      this.prisma.chargingSession.findMany({
        where: { vehicleId, startTime: { gte: since30d } },
        select: { energyAddedKwh: true, cost: true },
      }),
      this.prisma.vampireDrainLog.findMany({
        where: { vehicleId, date: { gte: since7d } },
        select: { drainPct: true, drainPerHr: true, durationHrs: true },
        orderBy: { date: 'desc' },
      }),
      this.prisma.vampireDrainLog.findMany({
        where: { vehicleId, date: { gte: since3d } },
        select: { drainPerHr: true },
        orderBy: { date: 'asc' },
      }),
    ]);

    const distanceKm = todayTrips.reduce((s, t) => s + (t.distanceKm ?? 0), 0);
    const energyKwh  = todayTrips.reduce((s, t) => s + (t.energyUsedKwh ?? 0), 0);
    const chargingEnergyKwh = charging30d.reduce((s, c) => s + (c.energyAddedKwh ?? 0), 0);
    const totalCost  = charging30d.reduce((s, c) => s + (c.cost ?? 0), 0);

    // Vampire drain: weighted avg by duration
    let vampireDrainPct: number | null = null;
    let vampireDrainPerHr: number | null = null;
    if (drainLogs7d.length > 0) {
      const totalHrs = drainLogs7d.reduce((s, l) => s + l.durationHrs, 0);
      vampireDrainPct = drainLogs7d.reduce((s, l) => s + l.drainPct, 0) / drainLogs7d.length;
      vampireDrainPerHr = totalHrs > 0
        ? drainLogs7d.reduce((s, l) => s + l.drainPerHr * l.durationHrs, 0) / totalHrs
        : null;
    }

    // Drain trend: slope of drainPerHr over last 3 days (positive = worsening)
    let drainTrend3d: number | null = null;
    if (drainLogs3d.length >= 2) {
      const rates = drainLogs3d.map(l => l.drainPerHr);
      const first = rates[0];
      const last  = rates[rates.length - 1];
      drainTrend3d = (last - first) / Math.max(rates.length - 1, 1);
    }

    return {
      vehicleId,
      soc:                 telemetry?.soc ?? null,
      batteryRangeKm:      telemetry?.batteryRangeKm ?? null,
      outsideTemp:         telemetry?.outsideTemp ?? null,
      vehicleState:        vehicleState?.state ?? null,
      chargingState:       vehicleState?.chargingState ?? null,
      sohPercent:          batteryHealth?.sohPercent ?? null,
      degradationPercent:  batteryHealth?.degradationPercent ?? null,
      estimatedCapacityKwh: batteryHealth?.estimatedCapacityKwh ?? null,
      nominalCapacityKwh:  batteryHealth?.nominalCapacityKwh ?? null,
      tripCount:           todayTrips.length,
      distanceKm,
      energyKwh,
      efficiencyWhKm:      distanceKm > 0 ? (energyKwh * 1000) / distanceKm : null,
      chargingSessions:    charging30d.length,
      chargingEnergyKwh,
      totalCost:           totalCost > 0 ? totalCost : null,
      costPerKm:           distanceKm > 0 && totalCost > 0 ? totalCost / distanceKm : null,
      vampireDrainPct:     vampireDrainPct != null ? +vampireDrainPct.toFixed(2) : null,
      vampireDrainPerHr:   vampireDrainPerHr != null ? +vampireDrainPerHr.toFixed(3) : null,
      drainTrend3d:        drainTrend3d,
    };
  }

  // ─── Feedback learning ────────────────────────────────────────────────────

  /**
   * Load recent rejections for a vehicle.
   * Returns map of lowercased title → rejection count over last 30 days.
   */
  private async loadRejectionMap(vehicleId: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const rows = await this.prisma.$queryRaw<Array<{ title: string; cnt: bigint }>>`
        SELECT "title", COUNT(*) AS cnt
        FROM "ai_insight_logs"
        WHERE "vehicleId" = ${vehicleId}
          AND "accepted" = false
          AND "createdAt" > NOW() - INTERVAL '30 days'
        GROUP BY "title"
      `;
      for (const row of rows) {
        map.set(row.title.toLowerCase(), Number(row.cnt));
      }
    } catch {
      // Non-fatal — proceed without feedback data
    }
    return map;
  }

  // ─── Suppression (prevents same insight flooding every poll) ─────────────

  /**
   * Mark insight as suppressed — called after user provides feedback.
   * Danger insights are never suppressed.
   */
  async suppressInsight(vehicleId: string, insightId: string, severity: string): Promise<void> {
    const ttl = SUPPRESSION_TTL_S[severity] ?? 24 * 3600;
    if (ttl === 0) return; // never suppress danger
    try {
      await this.redis.set(
        `ai:suppress:${vehicleId}:${insightId}`,
        '1',
        'EX',
        ttl,
      );
    } catch {}
  }

  /**
   * Filter out insights that have been recently suppressed.
   */
  private async filterSuppressed(
    insights: AIInsight[],
    vehicleId: string,
  ): Promise<AIInsight[]> {
    const results: AIInsight[] = [];
    for (const insight of insights) {
      if (insight.severity === 'danger') {
        results.push(insight);
        continue;
      }
      try {
        const suppressed = await this.redis.get(`ai:suppress:${vehicleId}:${insight.id}`);
        if (!suppressed) results.push(insight);
        else this.logger.debug(`Suppressed insight "${insight.title}" for vehicle ${vehicleId}`);
      } catch {
        results.push(insight); // Redis error → show the insight
      }
    }
    return results;
  }

  // ─── Scoring engine ───────────────────────────────────────────────────────

  /**
   * Apply multi-factor scoring to insights:
   *   score = basePriority
   *         + severityBonus      (danger=+20, warning=+10)
   *         + anomalyBoost       (up to +30 from anomalyScore)
   *         - rejectionPenalty   (up to -45 from past rejections)
   *
   * Insights rejected 3+ times are suppressed entirely.
   */
  private scoreInsights(
    insights: AIInsight[],
    rejections: Map<string, number>,
  ): AIInsight[] {
    return insights
      .map(insight => {
        const titleLower = insight.title.toLowerCase();

        // Find matching rejection count
        let maxRejections = 0;
        for (const [key, count] of rejections) {
          const titleWords = titleLower.split(/\W+/).filter(w => w.length > 3);
          const keyWords = key.split(/\W+/).filter(w => w.length > 3);
          const overlaps = titleWords.some(w => keyWords.includes(w)) || titleLower.includes(key);
          if (overlaps && count > maxRejections) maxRejections = count;
        }

        // Suppress entirely after 3+ rejections
        if (maxRejections >= 3) {
          this.logger.debug(`Suppressed by rejections (${maxRejections}x): "${insight.title}"`);
          return null;
        }

        const rejectionPenalty = Math.min(maxRejections * REJECTION_PENALTY, MAX_REJECTION_PENALTY);
        const severityBonus = SEVERITY_BONUS[insight.severity] ?? 0;
        const anomalyBoost = Math.min((insight.anomalyScore ?? 0) * 0.3, 30);

        const newPriority = Math.max(
          0,
          insight.priority + severityBonus + anomalyBoost - rejectionPenalty,
        );

        return { ...insight, priority: Math.round(newPriority) };
      })
      .filter((i): i is AIInsight => i !== null);
  }

  // ─── Main entry point ─────────────────────────────────────────────────────

  async generateInsights(context: InsightContext): Promise<AIInsight[]> {
    const [raw, rejections] = await Promise.all([
      this.client
        ? this.claudeInsights(context).catch(err => {
            this.logger.error('Claude API error, falling back to rule-based:', err);
            return this.ruleBasedInsights(context);
          })
        : Promise.resolve(this.ruleBasedInsights(context)),
      this.loadRejectionMap(context.vehicleId),
    ]);

    const scored = this.scoreInsights(raw, rejections);
    const unsuppressed = await this.filterSuppressed(scored, context.vehicleId);
    return unsuppressed.sort((a, b) => b.priority - a.priority);
  }

  // ─── Claude insights ──────────────────────────────────────────────────────

  private async claudeInsights(context: InsightContext): Promise<AIInsight[]> {
    const prompt = this.buildPrompt(context);

    const response = await this.client!.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.choices[0]?.message?.content ?? '';

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      this.logger.warn('No JSON array found in Claude response');
      return this.ruleBasedInsights(context);
    }

    const raw: any[] = JSON.parse(jsonMatch[0]);

    // Only allow navigation to routes that exist in the app
    const VALID_HREFS = new Set(['/trips', '/charging', '/battery', '/vehicles', '/settings', '/']);

    const insights = raw.slice(0, 4).map((item, i) => {
      let action = item.action ?? undefined;
      if (action?.type === 'navigate' && !VALID_HREFS.has(action.href)) {
        action = undefined; // drop hallucinated routes
      }
      return {
        id: `ai-${i}`,
        severity: item.severity ?? 'info',
        icon: item.icon ?? 'Lightbulb',
        title: item.title ?? 'Insight',
        description: item.description ?? '',
        reasons: Array.isArray(item.reasons) ? item.reasons.slice(0, 3) : undefined,
        confidence: item.confidence ?? 70,
        action,
        priority: item.priority ?? 50,
      };
    });

    // Guard against the model ignoring the LANGUAGE INSTRUCTION — see isRuLanguageCompliant.
    if (context.language === 'ru' && insights.length > 0 && !isRuLanguageCompliant(insights)) {
      this.logger.warn(
        `Groq returned non-Cyrillic text for language=ru (vehicle ${context.vehicleId}) — falling back to rule-based`,
      );
      return this.ruleBasedInsights(context);
    }

    return insights;
  }

  private buildPrompt(ctx: InsightContext): string {
    const historical = [
      ctx.avgEfficiency7d ? `7-day avg efficiency: ${Math.round(ctx.avgEfficiency7d)} Wh/km` : null,
      ctx.drainTrend3d != null
        ? `Drain trend (3d): ${ctx.drainTrend3d > 0 ? '+' : ''}${ctx.drainTrend3d.toFixed(2)}%/day`
        : null,
      ctx.chargingPattern ? `Charging pattern: ${ctx.chargingPattern}` : null,
    ].filter(Boolean).join('\n');

    return `${ctx.language && ctx.language !== 'en' ? `LANGUAGE INSTRUCTION: You MUST write ALL text (title, description, reasons, action labels) in ${this.languageName(ctx.language)}. Do NOT use English for any text field. This is mandatory.\n\n` : ''}You are an AI co-pilot for an EV analytics platform. Analyze the following Tesla vehicle data and return 2-4 actionable insights as a JSON array.

Vehicle data:
- Battery: ${ctx.soc ?? 'unknown'}% (range: ${ctx.batteryRangeKm ?? 'unknown'} km)
- Charging state: ${ctx.chargingState ?? 'not charging'}
- Vehicle state: ${ctx.vehicleState ?? 'unknown'}
- Data quality: ${ctx.dataQuality ?? 'unknown'} (${ctx.dataFreshnessSec ?? 'unknown'} sec old)
- Outside temp: ${ctx.outsideTemp ?? 'unknown'}°C
- Battery health (SoH): ${ctx.sohPercent ?? 'unknown'}% (degradation: ${ctx.degradationPercent ?? 0}%)
- Today: ${ctx.tripCount} trips, ${ctx.distanceKm.toFixed(1)} km, ${ctx.efficiencyWhKm ? Math.round(ctx.efficiencyWhKm) + ' Wh/km' : 'no trips'}
- Last 30 days: ${ctx.chargingSessions} charges, €${(ctx.totalCost ?? 0).toFixed(2)} cost, ${ctx.costPerKm ? '€' + ctx.costPerKm.toFixed(3) + '/km' : 'unknown cost/km'}
- Vampire drain: ${ctx.vampireDrainPct ? ctx.vampireDrainPct.toFixed(1) + '%/event, ' + (ctx.vampireDrainPerHr?.toFixed(2) ?? '?') + '%/hr' : 'no data'}
- Usable capacity: ${ctx.estimatedCapacityKwh?.toFixed(1) ?? 'unknown'} kWh (nominal: ${ctx.nominalCapacityKwh?.toFixed(1) ?? 'unknown'} kWh)
${historical ? '- Historical:\n  ' + historical : ''}

STRICT RULES — follow exactly:
1. CHARGING: Only suggest charging if SOC < 20% (danger) or SOC 20-25% AND not charging (warning). NEVER mention charging if SOC >= 30%.
2. BATTERY HEALTH: Only flag degradation if > 5%. Below 5% is perfectly normal — do not mention it.
3. EFFICIENCY: Only flag if today's trips exist (distanceKm > 2 km). Never comment on efficiency if no trips today.
4. IDLE DRAIN (разряд в покое): Only mention if avgPerHr > 0.5%/hr or drain > 8%. Below that is normal. Use term "разряд в покое" in Russian.
5. GOOD NEWS: If SOC is 30-80% and not charging, this is the IDEAL range — you can mention this positively (low priority).
6. NO TRIPS: If no trips today, focus on battery state and health only. Do not say "inefficient" or "no data" — it's just a rest day.
7. TEMPERATURE: Only mention temp if it's below 0°C or above 35°C (impactful range).
8. Be encouraging and specific. Use real numbers from the data.
9. If data quality is STALE or OFFLINE, never claim exact real-time charging connection/disconnection; explicitly frame status as possibly outdated.

Return ONLY a JSON array. Each insight must have:
{
  "severity": "info" | "success" | "warning" | "danger",
  "icon": one of [BatteryWarning, Zap, ZapOff, Ghost, TrendingUp, TrendingDown, HeartCrack, Heart, HeartHandshake, CheckCircle2, Lightbulb, Euro, Thermometer, Wind, Navigation],
  "title": short actionable title (max 6 words),
  "description": concise explanation with numbers (max 20 words),
  "reasons": array of 2-3 short bullet points explaining WHY (e.g. "SOC dropped 8% overnight", "Temp below 5°C"),
  "confidence": number 50-100,
  "priority": 10-100,
  "action": optional { "type": "navigate"|"command", "label": string, "href"?: one of ["/trips", "/charging", "/battery", "/vehicles", "/settings"], "command"?: string }
}

Focus on: battery state, efficiency (only if trips today), cost, health, vampire drain.`;
  }

  private languageName(code: string): string {
    const map: Record<string, string> = {
      de: 'German', fr: 'French', ru: 'Russian', es: 'Spanish',
      it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish',
    };
    return map[code] ?? code;
  }

  // ─── Rule-based fallback ──────────────────────────────────────────────────

  private ruleBasedInsights(ctx: InsightContext): AIInsight[] {
    const insights: AIInsight[] = [];
    const lang = ctx.language;
    const localize = (id: Parameters<typeof localizeRuleBasedInsight>[0], params: RuleBasedInsightParams) =>
      localizeRuleBasedInsight(id, lang, params);

    // ── Battery SOC ──
    if (ctx.soc != null) {
      if (ctx.soc <= 10) {
        const { title, description, reasons } = localize('battery-critical', { soc: ctx.soc });
        insights.push({
          id: 'battery-critical', severity: 'danger', icon: 'BatteryWarning',
          title, description, reasons,
          confidence: 99,
          anomalyScore: 90,
          action: { type: 'navigate', href: '/charging', label: 'Charging history' },
          priority: 100,
          params: { soc: ctx.soc },
        });
      } else if (ctx.soc <= 20 && ctx.chargingState !== 'Charging') {
        const { title, description, reasons } = localize('battery-low', {
          soc: ctx.soc,
          avgEfficiency7d: ctx.avgEfficiency7d ?? undefined,
        });
        insights.push({
          id: 'battery-low', severity: 'warning', icon: 'BatteryWarning',
          title, description, reasons,
          confidence: 90,
          anomalyScore: 50,
          action: { type: 'navigate', href: '/charging', label: 'Charging history' },
          priority: 80,
          params: { soc: ctx.soc },
        });
      }
    }

    // ── Optimal charge range (30-80%) ──
    if (
      ctx.soc != null &&
      ctx.soc >= 30 && ctx.soc <= 80 &&
      ctx.chargingState !== 'Charging'
    ) {
      const { title, description, reasons } = localize('battery-optimal', { soc: ctx.soc });
      insights.push({
        id: 'battery-optimal', severity: 'success', icon: 'Heart',
        title, description, reasons,
        confidence: 95,
        anomalyScore: 0,
        priority: 15,
        params: { soc: ctx.soc },
      });
    }

    // ── Battery health ──
    if (ctx.degradationPercent != null && ctx.degradationPercent >= 5) {
      const isCritical = ctx.degradationPercent >= 10;
      const healthParams: RuleBasedInsightParams = {
        degradationPercent: ctx.degradationPercent,
        sohPercent: ctx.sohPercent ?? undefined,
        estimatedCapacityKwh: ctx.estimatedCapacityKwh ?? undefined,
        nominalCapacityKwh: ctx.nominalCapacityKwh ?? undefined,
      };
      const { title, description, reasons } = localize('health', healthParams);
      insights.push({
        id: 'health', severity: isCritical ? 'danger' : 'warning', icon: 'HeartCrack',
        title, description, reasons,
        confidence: 85,
        anomalyScore: isCritical ? 80 : 45,
        action: { type: 'navigate', href: '/battery', label: 'Battery analytics' },
        priority: isCritical ? 90 : 60,
        params: { degradationPercent: ctx.degradationPercent, ...(ctx.sohPercent != null ? { sohPercent: ctx.sohPercent } : {}) },
      });
    }

    // ── Idle drain ──
    if (ctx.vampireDrainPct != null && ctx.vampireDrainPct > 3) {
      const isHigh = ctx.vampireDrainPct > 8;
      const anomalyScore = Math.min((ctx.vampireDrainPerHr ?? 0) * 100, 100);
      const { title, description, reasons } = localize('vampire', {
        drainPercent: ctx.vampireDrainPct,
        drainPerHour: ctx.vampireDrainPerHr ?? undefined,
        drainTrendPerDay: ctx.drainTrend3d ?? undefined,
      });
      insights.push({
        id: 'vampire', severity: isHigh ? 'warning' : 'info', icon: 'Ghost',
        title, description, reasons,
        confidence: 80,
        anomalyScore,
        priority: isHigh ? 70 : 35,
        params: {
          drainPercent: ctx.vampireDrainPct,
          ...(ctx.vampireDrainPerHr != null ? { drainPerHour: ctx.vampireDrainPerHr } : {}),
        },
      });
    }

    // ── Efficiency ──
    if (ctx.efficiencyWhKm != null && ctx.distanceKm > 2) {
      const baseline = ctx.avgEfficiency7d ?? 200;
      // Anomaly: how many % above/below baseline
      const deviation = ((ctx.efficiencyWhKm - baseline) / baseline) * 100;
      const anomalyScore = Math.min(Math.abs(deviation), 100);

      if (ctx.efficiencyWhKm > 280) {
        const { title, description, reasons } = localize('efficiency-poor', {
          efficiency: ctx.efficiencyWhKm,
          avgEfficiency7d: ctx.avgEfficiency7d ?? undefined,
          outsideTemp: ctx.outsideTemp ?? undefined,
        });
        insights.push({
          id: 'efficiency-poor', severity: 'warning', icon: 'TrendingUp',
          title, description, reasons,
          confidence: 75,
          anomalyScore,
          action: { type: 'navigate', href: '/trips', label: 'View trips' },
          priority: 50,
          params: { efficiency: ctx.efficiencyWhKm },
        });
      } else if (ctx.efficiencyWhKm < 160) {
        const { title, description, reasons } = localize('efficiency-great', {
          efficiency: ctx.efficiencyWhKm,
          avgEfficiency7d: ctx.avgEfficiency7d ?? undefined,
        });
        insights.push({
          id: 'efficiency-great', severity: 'success', icon: 'TrendingDown',
          title, description, reasons,
          confidence: 85,
          anomalyScore: 0,
          action: { type: 'navigate', href: '/trips', label: 'View trips' },
          priority: 20,
          params: { efficiency: ctx.efficiencyWhKm },
        });
      }
    }

    if (insights.length === 0) {
      const { title, description, reasons } = localize('all-good', {});
      insights.push({
        id: 'all-good', severity: 'success', icon: 'CheckCircle2',
        title, description, reasons,
        confidence: 70,
        priority: 10,
      });
    }

    return insights.sort((a, b) => b.priority - a.priority);
  }

  // ─── Chat ─────────────────────────────────────────────────────────────────

  /**
   * Parse user message into a structured intent for the action bridge.
   * Returns ParsedIntent with type, command/href, and confidence.
   */
  parseIntent(message: string): ParsedIntent {
    const best: ParsedIntent = { type: 'unknown', confidence: 0, originalMessage: message };

    for (const pattern of INTENT_PATTERNS) {
      if (pattern.regex.test(message)) {
        if (pattern.confidence > best.confidence) {
          Object.assign(best, {
            type: pattern.type,
            command: pattern.command,
            href: pattern.href,
            confidence: pattern.confidence,
          });
        }
      }
    }

    return best;
  }

  /**
   * Conversational AI chat — answers questions about the vehicle.
   * Also returns a parsed intent so the caller can optionally execute commands.
   */
  async chat(
    message: string,
    context?: Partial<InsightContext>,
  ): Promise<{ answer: string; intent?: ParsedIntent }> {
    const intent = this.parseIntent(message);

    if (!this.client) {
      // Even without Claude, return the intent
      const hint = intent.type === 'command'
        ? ` I detected you want to: ${intent.command?.replace(/_/g, ' ')}.`
        : '';
      return {
        answer: `AI is not configured. Please set GROQ_API_KEY.${hint}`,
        intent: intent.type !== 'unknown' ? intent : undefined,
      };
    }

    const historicalBlock = context?.historicalSummaries?.length
      ? `\nHISTORICAL CONTEXT (past weeks, most relevant first):\n${context.historicalSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '';

    const systemPrompt = context
      ? `You are an EV AI co-pilot for a Tesla. Answer concisely and specifically using the real data below. Never say you lack data if a value is provided.

VEHICLE DATA:
- Battery: ${context.soc ?? 'unknown'}% SoC, range ${context.batteryRangeKm ?? 'unknown'} km
- State: ${context.vehicleState ?? 'unknown'}${context.chargingState ? `, charging: ${context.chargingState}` : ''}
- Battery health (SoH): ${context.sohPercent != null ? context.sohPercent.toFixed(1) + '%' : 'unknown'}${context.degradationPercent != null ? `, degradation: ${context.degradationPercent.toFixed(1)}%` : ''}
- Capacity: ${context.estimatedCapacityKwh != null ? context.estimatedCapacityKwh.toFixed(1) + ' kWh usable' : 'unknown'}${context.nominalCapacityKwh != null ? ` (nominal ${context.nominalCapacityKwh} kWh)` : ''}
- Outside temp: ${context.outsideTemp != null ? context.outsideTemp + '°C' : 'unknown'}

TODAY'S DRIVING:
- Trips: ${context.tripCount ?? 0}, distance: ${context.distanceKm != null ? context.distanceKm.toFixed(1) + ' km' : '0 km'}, energy: ${context.energyKwh != null ? context.energyKwh.toFixed(2) + ' kWh' : '0 kWh'}
- Efficiency: ${context.efficiencyWhKm != null ? Math.round(context.efficiencyWhKm) + ' Wh/km' : 'no data'}

LAST 30 DAYS:
- Charging sessions: ${context.chargingSessions ?? 0}, total energy: ${context.chargingEnergyKwh != null ? context.chargingEnergyKwh.toFixed(1) + ' kWh' : '0 kWh'}
- Charging cost: ${context.totalCost != null ? context.totalCost.toFixed(2) + ' (currency)' : 'not tracked'}
- Cost per km: ${context.costPerKm != null ? context.costPerKm.toFixed(3) : 'n/a'}
- Idle drain (7d avg): ${context.vampireDrainPerHr != null ? context.vampireDrainPerHr.toFixed(3) + '%/hr' : 'no data'}${historicalBlock}

Answer in the same language the user writes in. Be direct and specific. Use historical context to answer trend questions.`
      : `You are an EV AI co-pilot. Answer concisely and specifically.`;

    try {
      const response = await this.client.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 512,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '';
      return {
        answer: text,
        intent: intent.type !== 'unknown' ? intent : undefined,
      };
    } catch (err: any) {
      this.logger.error('Chat error:', err?.message);
      return {
        answer: 'Sorry, I could not process your question right now.',
        intent: intent.type !== 'unknown' ? intent : undefined,
      };
    }
  }
}
