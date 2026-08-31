'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import {
  BatteryWarning, BatteryFull, Zap, ZapOff, Heart, HeartHandshake,
  HeartCrack, Ghost, TrendingUp, TrendingDown, Euro, CheckCircle2,
  Lightbulb, Thermometer, Navigation, ChevronRight, X, Sparkles,
  RefreshCw, ThumbsUp, ThumbsDown, HelpCircle, AlertCircle,
} from 'lucide-react';
import { generateInsights, roundInsightParams, BATTERY_SOC, type Insight, type InsightSeverity } from '@/lib/insights';
import { executeAction as doAction } from '@/lib/executeAction';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { useCurrency } from '@/hooks/useCurrency';
import { apiClient } from '@/lib/api';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useQuery } from '@tanstack/react-query';

interface Props {
  vehicleId: string;
}

/* ── Icon registry ─────────────────────────────────────────────────────────── */
const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  BatteryWarning, BatteryFull, Zap, ZapOff, Heart, HeartHandshake, HeartCrack,
  Ghost, TrendingUp, TrendingDown, Euro, CheckCircle2, Lightbulb,
  Thermometer, Navigation, Sparkles,
};

/* ── Color palette ──────────────────────────────────────────────────────────── */
const COLORS: Record<InsightSeverity, {
  border: string; bg: string; hoverBg: string; icon: string;
  badge: string; badgeText: string; glow: string;
}> = {
  danger: {
    border: 'border-red-500/40', bg: 'bg-red-500/5', hoverBg: 'hover:bg-red-500/10',
    icon: 'text-red-700 dark:text-red-400', badge: 'bg-red-500/15', badgeText: 'text-red-700 dark:text-red-300',
    glow: 'shadow-red-500/20',
  },
  warning: {
    border: 'border-amber-500/40', bg: 'bg-amber-500/5', hoverBg: 'hover:bg-amber-500/10',
    icon: 'text-amber-700 dark:text-amber-400', badge: 'bg-amber-500/15', badgeText: 'text-amber-700 dark:text-amber-300',
    glow: 'shadow-amber-500/20',
  },
  success: {
    border: 'border-emerald-500/40', bg: 'bg-emerald-500/5', hoverBg: 'hover:bg-emerald-500/10',
    icon: 'text-emerald-700 dark:text-emerald-400', badge: 'bg-emerald-500/15', badgeText: 'text-emerald-700 dark:text-emerald-300',
    glow: 'shadow-emerald-500/20',
  },
  info: {
    border: 'border-sky-500/40', bg: 'bg-sky-500/5', hoverBg: 'hover:bg-sky-500/10',
    icon: 'text-sky-700 dark:text-sky-400', badge: 'bg-sky-500/15', badgeText: 'text-sky-700 dark:text-sky-300',
    glow: 'shadow-sky-500/20',
  },
};

function getSeverityLabel(severity: InsightSeverity, t: (k: string) => string): string {
  return t(`dashboard.severity_${severity}`);
}

/* ── Skeleton ───────────────────────────────────────────────────────────────── */
function InsightSkeleton() {
  return (
    <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 animate-pulse">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="w-8 h-8 rounded-lg bg-[hsl(var(--surface-2))]" />
        <div className="h-4 w-20 rounded-full bg-[hsl(var(--surface-2))]" />
      </div>
      <div className="space-y-2">
        <div className="h-4 w-3/4 rounded bg-[hsl(var(--surface-2))]" />
        <div className="h-3 w-full rounded bg-[hsl(var(--surface-2)/0.8)]" />
        <div className="h-3 w-2/3 rounded bg-[hsl(var(--surface-2)/0.8)]" />
      </div>
    </div>
  );
}

/* ── Focus detail panel ─────────────────────────────────────────────────────── */
function FocusPanel({
  insight,
  vehicleId,
  onClose,
}: {
  insight: Insight;
  vehicleId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { accessToken } = useAuthStore();
  const addToast = useUIStore((s) => s.addToast);
  const { t } = useTranslation();
  const c = COLORS[insight.severity];
  const Icon = ICONS[insight.icon] ?? CheckCircle2;
  const [busy, setBusy] = React.useState(false);
  const [feedbackSent, setFeedbackSent] = React.useState(false);

  async function handleAction() {
    if (!insight.action || !accessToken) return;
    setBusy(true);
    try {
      await doAction(insight.action, {
        vehicleId,
        token: accessToken,
        router,
        onSuccess: (msg) => addToast('success', msg),
        onError: (msg) => addToast('error', msg),
      });
    } finally {
      setBusy(false);
      onClose();
    }
  }

  async function sendFeedback(accepted: boolean) {
    if (!accessToken || feedbackSent) return;
    setFeedbackSent(true);
    try {
      await apiClient.recordAIFeedback({
        vehicleId,
        insightId: insight.id,
        title: insight.title,
        severity: insight.severity,
        accepted,
      }, accessToken);
      addToast('success', accepted ? t('dashboard.feedbackHelpful') : t('dashboard.feedbackNotHelpful'));
    } catch {
      setFeedbackSent(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.98 }}
      className={`
        col-span-full rounded-2xl border p-5 backdrop-blur
        ${c.border} ${c.bg} shadow-lg ${c.glow}
      `}
    >
      <div className="flex items-start gap-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center bg-[hsl(var(--secondary)/0.6)] flex-shrink-0 ${c.icon}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${c.badge} ${c.badgeText}`}>
              {getSeverityLabel(insight.severity, t)}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-foreground">{insight.title}</h3>
            {insight.confidence != null && (
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                insight.confidence >= 80 ? 'bg-emerald-500/15 text-emerald-400' :
                insight.confidence >= 60 ? 'bg-amber-500/15 text-amber-400' :
                'bg-[hsl(var(--secondary)/0.6)] text-muted-foreground'
              }`}>
                {insight.confidence}%
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{insight.description}</p>

          {/* Explainability — reasons */}
          {(insight as any).reasons && (insight as any).reasons.length > 0 && (
            <div className="mt-2 p-2 rounded-lg bg-[hsl(var(--secondary)/0.4)] border border-[hsl(var(--border))]">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium flex items-center gap-1 mb-1">
                <HelpCircle className="w-3 h-3" /> {t('dashboard.whyThisInsight')}
              </p>
              <ul className="space-y-0.5">
                {(insight as any).reasons.map((reason: string, i: number) => (
                  <li key={i} className={`flex items-start gap-1.5 text-[11px] ${c.icon}`}>
                    <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5 opacity-70" />
                    <span className="text-foreground">{reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            {insight.action && (
              <button
                onClick={handleAction}
                disabled={busy}
                className={`
                  inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                  border transition-colors disabled:opacity-60
                  ${c.border} ${c.bg} ${c.hoverBg} ${c.icon}
                `}
              >
                {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
                {insight.action.label}
              </button>
            )}
            {/* Feedback */}
            {!feedbackSent ? (
              <div className="flex items-center gap-1 ml-auto">
                <span className="text-[10px] text-muted-foreground mr-1">{t('dashboard.helpful')}</span>
                <button
                  onClick={() => sendFeedback(true)}
                  title={t('dashboard.yesHelpful')}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <ThumbsUp className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => sendFeedback(false)}
                  title={t('dashboard.notHelpful')}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <ThumbsDown className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <span className="text-[10px] text-muted-foreground ml-auto">{t('dashboard.thanksFeedback')}</span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--surface-1))] transition-colors flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </motion.div>
  );
}

/* ── Single insight card ────────────────────────────────────────────────────── */
function InsightCard({
  insight,
  index,
  onFocus,
}: {
  insight: Insight;
  index: number;
  onFocus: (insight: Insight) => void;
}) {
  const { t } = useTranslation();
  const c = COLORS[insight.severity];
  const Icon = ICONS[insight.icon] ?? CheckCircle2;
  const isHighPriority = insight.priority >= 80;

  return (
    <motion.button
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.07 }}
      whileHover={{ scale: 1.015, y: -2 }}
      whileTap={{ scale: 0.98 }}
      onClick={() => onFocus(insight)}
      className={`
        relative flex flex-col gap-2 p-4 rounded-2xl border backdrop-blur text-left w-full h-full
        transition-all cursor-pointer
        ${c.border} ${c.bg} ${c.hoverBg}
        ${isHighPriority ? 'shadow-md ' + c.glow : ''}
        min-w-[200px] flex-shrink-0
        sm:min-w-0 sm:flex-shrink
      `}
    >
      {/* Priority dot for high-priority */}
      {insight.priority >= 80 && (
        <span className="absolute top-3 right-3 w-2 h-2 rounded-full bg-current animate-pulse opacity-70" style={{ color: 'currentColor' }} />
      )}

      <div className="flex items-start justify-between gap-2">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-[hsl(var(--secondary)/0.6)] ${c.icon}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {(insight as any).confidence != null && (insight as any).confidence < 70 && (
            <span className="text-[9px] text-muted-foreground">{(insight as any).confidence}%</span>
          )}
          <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${c.badge} ${c.badgeText}`}>
            {getSeverityLabel(insight.severity, t)}
          </span>
        </div>
      </div>

      <div className="flex-1">
        <p className="text-sm font-semibold text-foreground leading-tight">
          {insight.title}
        </p>
        <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">{insight.description}</p>
      </div>

      {insight.action && (
        <div className={`inline-flex items-center gap-1 text-[11px] font-medium mt-1 ${c.icon}`}>
          {insight.action.label}
          <ChevronRight className="w-3 h-3" />
        </div>
      )}
    </motion.button>
  );
}

/* ── Main section ───────────────────────────────────────────────────────────── */
export function InsightsSection({ vehicleId }: Props) {
  const { accessToken } = useAuthStore();
  const { preferences } = useUIStore();
  const { t, i18n } = useTranslation();
  const uiLanguage = (i18n.resolvedLanguage ?? i18n.language ?? preferences.language ?? 'en').split('-')[0];
  const { currency } = useCurrency();

  const [focusInsight, setFocusInsight] = React.useState<Insight | null>(null);
  const [useAI, setUseAI] = React.useState(true);

  const { status, health, tripsToday, chargingSummary, costSummary, drainStats, isLoading } = useDashboardData(vehicleId);
  const dataQuality = (status as any)?.dataQuality as string | undefined;
  const freshForInsights = dataQuality === 'REALTIME' || dataQuality === 'DELAYED';

  // AI insights from backend
  const aiContext = React.useMemo(() => ({
    vehicleId,
    soc: status?.soc ?? null,
    chargingState: status?.chargingState ?? null,
    vehicleState: status?.vehicleState ?? null,
    outsideTemp: status?.outsideTemp ?? null,
    batteryRangeKm: status?.batteryRangeKm ?? null,
    sohPercent: (health as any)?.sohPercent ?? null,
    degradationPercent: (health as any)?.degradationPercent ?? null,
    estimatedCapacityKwh: (health as any)?.estimatedCapacityKwh ?? null,
    nominalCapacityKwh: (health as any)?.nominalCapacityKwh ?? null,
    tripCount: tripsToday?.tripCount ?? 0,
    distanceKm: tripsToday?.distanceKm ?? 0,
    energyKwh: tripsToday?.energyKwh ?? 0,
    efficiencyWhKm: tripsToday?.efficiencyWhKm ?? null,
    chargingSessions:  (chargingSummary as any)?.sessionCount   ?? 0,
    chargingEnergyKwh: (chargingSummary as any)?.totalEnergyKwh ?? 0,
    totalCost: costSummary?.totalCost ?? null,
    costPerKm: costSummary?.costPerKm ?? null,
    vampireDrainPct: drainStats?.avg?.drainPct ?? null,
    vampireDrainPerHr: drainStats?.avg?.drainPerHr ?? null,
    dataQuality: status?.dataQuality ?? null,
    dataFreshnessSec: status?.dataFreshnessSec ?? null,
    language: uiLanguage,
  }), [status, health, tripsToday, chargingSummary, costSummary, drainStats, vehicleId, uiLanguage]);

  const shouldFetchAI = !isLoading && !!accessToken && useAI && freshForInsights;

  const { data: aiInsights, isLoading: aiLoading, error: aiError } = useQuery({
    queryKey: ['ai-insights', vehicleId, aiContext.soc, aiContext.chargingState, aiContext.efficiencyWhKm, uiLanguage],
    queryFn: () => apiClient.getAIInsights(aiContext, accessToken!),
    enabled: !!(shouldFetchAI && status),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    retry: false,
  });

  React.useEffect(() => {
    if (aiError) setUseAI(false);
  }, [aiError]);

  // Use AI insights if available, else fall back to rule-based
  const insights = React.useMemo(() => {
    let source: Insight[];

    if (freshForInsights && aiInsights && aiInsights.length > 0) {
      const soc = status?.soc ?? null;
      source = (aiInsights as Insight[]).filter(ins => {
        // Suppress battery-low/critical warnings when SOC is actually fine.
        // Match by id (exact) OR by icon='BatteryWarning' + severity warning/danger —
        // the AI may use different IDs but always uses BatteryWarning icon for low-charge.
        if (soc != null) {
          const isCriticalType = ins.id === 'battery-critical'
            || (ins.icon === 'BatteryWarning' && ins.severity === 'danger');
          const isLowType = ins.id === 'battery-low'
            || (ins.icon === 'BatteryWarning' && ins.severity === 'warning');
          if (isCriticalType && soc > BATTERY_SOC.AI_SUPPRESS_CRITICAL) return false;
          if (isLowType      && soc > BATTERY_SOC.AI_SUPPRESS_LOW)      return false;
        }
        return true;
      });
    } else {
      source = generateInsights({
        status: status ?? null,
        health: health as any ?? null,
        tripsToday: tripsToday ?? null,
        vampireDrainPct: drainStats?.avg?.drainPct ?? null,
        vampireDrainPerHr: drainStats?.avg?.drainPerHr ?? null,
        costPerKm: costSummary?.costPerKm ?? null,
        outsideTemp: status?.outsideTemp ?? null,
        currency,
      });
    }

    // English text (whether AI-generated, server rule-based fallback, or local
    // rule-based fallback) is already correct as authored — no i18n pass needed.
    if (uiLanguage === 'en') return source;

    // Re-localize by stable id — never by comparing English text. Works for both
    // the local rule-based fallback and server-delivered insights (real AI output
    // uses non-dictionary ids like "ai-0" and simply falls through to its own,
    // already-localized-by-prompt text via `defaultValue`).
    return source.map((ins: any) => ({
      ...ins,
      title: t(`insights.${ins.id}.title`, { defaultValue: ins.title, ...roundInsightParams(ins.params) }),
      description: t(`insights.${ins.id}.description`, { defaultValue: ins.description, ...roundInsightParams(ins.params) }),
      action: ins.action
        ? { ...ins.action, label: t(`insights.${ins.id}.actionLabel`, { defaultValue: ins.action.label }) }
        : ins.action,
    }));
  }, [aiInsights, status, health, tripsToday, drainStats, costSummary, uiLanguage, t]);

  const top = insights.slice(0, 3);
  const showLoading = isLoading || aiLoading;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs uppercase tracking-widest text-muted-foreground font-medium">
          {t('dashboard.insights')}
        </p>
        <div className="flex items-center gap-3">
          {!aiError && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Sparkles className="w-3 h-3" />
              {aiInsights ? t('dashboard.aiPowered') : t('dashboard.ruleBased')}
            </span>
          )}
          <Link
            href="/insights"
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5"
          >
            {t('common.seeAll', { defaultValue: 'See all' })}
            <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      {/* Focus panel */}
      <AnimatePresence>
        {focusInsight && (
          <div className="mb-3">
            <FocusPanel
              insight={focusInsight}
              vehicleId={vehicleId}
              onClose={() => setFocusInsight(null)}
            />
          </div>
        )}
      </AnimatePresence>

      {/* Cards grid — uniform 3 cols, no mixed spans */}
      <div className={`flex gap-3 overflow-x-auto pb-1 snap-x sm:overflow-visible sm:grid sm:grid-cols-3 ${focusInsight ? 'hidden' : ''}`}>
        {showLoading ? (
          <>
            <InsightSkeleton />
            <InsightSkeleton />
            <InsightSkeleton />
          </>
        ) : (
          top.map((insight, i) => (
            <div key={insight.id} className="snap-start w-[calc(85vw-2rem)] sm:w-auto">
              <InsightCard
                insight={insight}
                index={i}
                onFocus={setFocusInsight}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
