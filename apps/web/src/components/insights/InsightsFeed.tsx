'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import {
  BatteryWarning, BatteryFull, Zap, ZapOff, Heart, HeartHandshake,
  HeartCrack, Ghost, TrendingUp, TrendingDown, Euro, CheckCircle2,
  Lightbulb, Thermometer, Navigation, ChevronRight, X, Sparkles,
  RefreshCw, ThumbsUp, ThumbsDown, HelpCircle, AlertCircle, RotateCw,
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

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  BatteryWarning, BatteryFull, Zap, ZapOff, Heart, HeartHandshake, HeartCrack,
  Ghost, TrendingUp, TrendingDown, Euro, CheckCircle2, Lightbulb,
  Thermometer, Navigation, Sparkles,
};

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

function getSeverityLabel(severity: InsightSeverity, t: (k: string) => string) {
  return t(`dashboard.severity_${severity}`);
}

/* ── Expanded detail card ──────────────────────────────────────────────── */
function InsightDetailCard({ insight, vehicleId, onClose }: {
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
      await apiClient.recordAIFeedback({ vehicleId, insightId: insight.id, title: insight.title, severity: insight.severity, accepted }, accessToken);
      addToast('success', accepted ? t('dashboard.feedbackHelpful') : t('dashboard.feedbackNotHelpful'));
    } catch {
      setFeedbackSent(false);
    }
  }

  return (
    <div className={`rounded-2xl border p-5 ${c.border} ${c.bg} shadow-lg ${c.glow}`}>
      <div className="flex items-start gap-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center bg-[hsl(var(--secondary)/0.6)] shrink-0 ${c.icon}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${c.badge} ${c.badgeText}`}>
              {getSeverityLabel(insight.severity, t)}
            </span>
            {(insight as any).confidence != null && (
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                (insight as any).confidence >= 80 ? 'bg-emerald-500/15 text-emerald-400' :
                (insight as any).confidence >= 60 ? 'bg-amber-500/15 text-amber-400' :
                'bg-[hsl(var(--secondary)/0.6)] text-muted-foreground'
              }`}>
                {(insight as any).confidence}%
              </span>
            )}
          </div>
          <h3 className="text-base font-semibold text-foreground">{insight.title}</h3>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{insight.description}</p>

          {(insight as any).reasons?.length > 0 && (
            <div className="mt-2.5 p-2.5 rounded-lg bg-[hsl(var(--secondary)/0.4)] border border-[hsl(var(--border))]">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium flex items-center gap-1 mb-1.5">
                <HelpCircle className="w-3 h-3" /> {t('dashboard.whyThisInsight')}
              </p>
              <ul className="space-y-1">
                {(insight as any).reasons.map((reason: string, i: number) => (
                  <li key={i} className={`flex items-start gap-1.5 text-[11px] ${c.icon}`}>
                    <AlertCircle className="w-3 h-3 shrink-0 mt-0.5 opacity-70" />
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
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-60 ${c.border} ${c.bg} ${c.hoverBg} ${c.icon}`}
              >
                {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
                {insight.action.label}
              </button>
            )}
            {!feedbackSent ? (
              <div className="flex items-center gap-1 ml-auto">
                <span className="text-[10px] text-muted-foreground mr-1">{t('dashboard.helpful')}</span>
                <button onClick={() => sendFeedback(true)} className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors">
                  <ThumbsUp className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => sendFeedback(false)} className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors">
                  <ThumbsDown className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <span className="text-[10px] text-muted-foreground ml-auto">{t('dashboard.thanksFeedback')}</span>
            )}
          </div>
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--surface-1))] transition-colors shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/* ── Compact insight row ──────────────────────────────────────────────── */
function InsightRow({ insight, index, onExpand }: { insight: Insight; index: number; onExpand: (i: Insight) => void }) {
  const { t } = useTranslation();
  const c = COLORS[insight.severity];
  const Icon = ICONS[insight.icon] ?? CheckCircle2;

  return (
    <motion.button
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.04 }}
      onClick={() => onExpand(insight)}
      className={`w-full flex items-center gap-3 p-3.5 rounded-xl border text-left transition-all ${c.border} ${c.bg} ${c.hoverBg}`}
    >
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-[hsl(var(--secondary)/0.5)] ${c.icon}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${c.badge} ${c.badgeText}`}>
            {getSeverityLabel(insight.severity, t)}
          </span>
          {insight.priority >= 80 && (
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" style={{ color: 'currentColor' }} />
          )}
        </div>
        <p className="text-sm font-medium text-foreground leading-snug truncate">{insight.title}</p>
        <p className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">{insight.description}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </motion.button>
  );
}

/* ── Main feed ────────────────────────────────────────────────────────── */
export function InsightsFeed({ vehicleId }: Props) {
  const { accessToken } = useAuthStore();
  const { preferences } = useUIStore();
  const { t, i18n } = useTranslation();
  const uiLanguage = (i18n.resolvedLanguage ?? i18n.language ?? preferences.language ?? 'en').split('-')[0];
  const { currency } = useCurrency();

  const [expanded, setExpanded] = React.useState<Insight | null>(null);
  const [useAI, setUseAI] = React.useState(true);

  const { status, health, tripsToday, chargingSummary, costSummary, drainStats, isLoading } = useDashboardData(vehicleId);
  const dataQuality = (status as any)?.dataQuality as string | undefined;
  const freshForInsights = dataQuality === 'REALTIME' || dataQuality === 'DELAYED';

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

  const { data: aiInsights, isLoading: aiLoading, error: aiError, refetch } = useQuery({
    queryKey: ['ai-insights-feed', vehicleId, aiContext.soc, aiContext.chargingState, uiLanguage],
    queryFn: () => apiClient.getAIInsights(aiContext, accessToken!),
    enabled: !!(shouldFetchAI && status),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    retry: false,
  });

  React.useEffect(() => {
    if (aiError) setUseAI(false);
  }, [aiError]);

  const insights = React.useMemo(() => {
    let source: Insight[];

    if (freshForInsights && aiInsights && aiInsights.length > 0) {
      const soc = status?.soc ?? null;
      source = (aiInsights as Insight[]).filter(ins => {
        if (soc != null) {
          if ((ins.id === 'battery-critical' || (ins.icon === 'BatteryWarning' && ins.severity === 'danger')) && soc > BATTERY_SOC.AI_SUPPRESS_CRITICAL) return false;
          if ((ins.id === 'battery-low'      || (ins.icon === 'BatteryWarning' && ins.severity === 'warning')) && soc > BATTERY_SOC.AI_SUPPRESS_LOW) return false;
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

    if (uiLanguage === 'en') return source;

    // Re-localize by stable id — never by comparing English text. See InsightsSection.tsx
    // for the same pattern (real AI text falls through untouched via `defaultValue`).
    return source.map((ins: any) => ({
      ...ins,
      title: t(`insights.${ins.id}.title`, { defaultValue: ins.title, ...roundInsightParams(ins.params) }),
      description: t(`insights.${ins.id}.description`, { defaultValue: ins.description, ...roundInsightParams(ins.params) }),
      action: ins.action ? { ...ins.action, label: t(`insights.${ins.id}.actionLabel`, { defaultValue: ins.action.label }) } : ins.action,
    }));
  }, [aiInsights, status, health, tripsToday, drainStats, costSummary, uiLanguage, t, freshForInsights, currency]);

  const showLoading = isLoading || aiLoading;

  // Sort by priority desc, then severity (danger first)
  const SEV_ORDER: Record<InsightSeverity, number> = { danger: 4, warning: 3, info: 2, success: 1 };
  const sorted = [...insights].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return (SEV_ORDER[b.severity as InsightSeverity] ?? 0) - (SEV_ORDER[a.severity as InsightSeverity] ?? 0);
  });

  return (
    <div className="space-y-4 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-2xs uppercase tracking-widest text-muted-foreground font-medium mb-0.5">
            {t('dashboard.insights')}
          </p>
          <p className="text-xs text-muted-foreground">
            {aiInsights ? t('dashboard.aiPowered') : t('dashboard.ruleBased')}
            {' · '}
            {sorted.length} {t('insights.count', { defaultValue: 'insights' })}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={showLoading}
          className="w-8 h-8 flex items-center justify-center rounded-xl border border-[hsl(var(--border)/0.6)] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          title={t('common.refresh')}
        >
          <RotateCw size={13} className={showLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Expanded detail */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key={expanded.id}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
          >
            <InsightDetailCard insight={expanded} vehicleId={vehicleId} onClose={() => setExpanded(null)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* List */}
      {showLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-[hsl(var(--secondary)/0.5)] animate-pulse" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-12 text-center">
          <CheckCircle2 size={28} className="mx-auto text-emerald-400 mb-2" />
          <p className="text-sm text-muted-foreground">{t('insights.allClear', { defaultValue: 'All looking good!' })}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted
            .filter(ins => ins.id !== expanded?.id)
            .map((ins, i) => (
              <InsightRow key={ins.id} insight={ins} index={i} onExpand={setExpanded} />
            ))}
        </div>
      )}
    </div>
  );
}
