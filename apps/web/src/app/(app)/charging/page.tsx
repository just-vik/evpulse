'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Page } from '@/components/layout';
import { useAuthStore } from '@/stores/authStore';
import { useLayoutStore } from '@/stores/layout.store';
import { apiClient } from '@/lib/api';
import {
  Zap,
  Clock,
  Gauge,
  Loader,
  Car,
  CheckCircle,
  Edit3,
  Check,
  X,
  BarChart2,
  Sparkles,
  TrendingDown,
  BatteryCharging,
  ChevronDown,
} from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/shared/ui/StatusBadge';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { LoadingState } from '@/shared/ui/LoadingState';
import { ClampedBanner } from '@/components/billing/ClampedBanner';
import { useCurrency } from '@/hooks/useCurrency'
import { MetricBanknoteIcon } from '@/components/icons/MetricBanknoteIcon'
import { useChargingPeriodStats } from '@/hooks/usePeriodComparison'
import { PeriodDeltaBadge } from '@/shared/ui'
import { PeriodFilterBar, periodToApiRange, type PeriodValue } from '@/shared/ui/PeriodFilterBar'
import { usePeriodParam } from '@/hooks/usePeriodParam'
import dynamic from 'next/dynamic';

const ChargingCharts = dynamic(() => import('./_ChargingCharts'), {
  ssr: false,
  loading: () => (
    <div className="space-y-4 mb-6">
      <div className="h-[308px] rounded-2xl bg-[hsl(var(--card))] border border-[hsl(var(--border)/0.5)] animate-pulse" />
      <div className="h-[288px] rounded-2xl bg-[hsl(var(--card))] border border-[hsl(var(--border)/0.5)] animate-pulse" />
    </div>
  ),
});

interface ApiSession {
  id: string;
  vehicleId: string;
  startTime: string;
  endTime: string | null;
  startSoc: number | null;
  endSoc: number | null;
  energyAddedKwh: number | null;
  maxPowerKw: number | null;
  chargerType: string | null;
  costTotal: number | null;
  costPerKwh: number | null;
  costSource: string | null;
  manualCost: number | null;
  currency: string | null;
  points?: { powerKw: number | null; soc: number | null; timestamp: string }[];
}

interface ApiVehicle {
  id: string;
  model: string;
  trim?: string;
  year?: number;
}
interface ApiVehicleStatus {
  soc: number | null;
  chargingState: string | null;
  batteryRangeKm: number | null;
  dataFreshnessSec: number | null;
  lastUpdate: string | null;
}

interface MonthlyCostEntry {
  month: string;
  totalCost: number;
  energyKwh: number;
  sessions: number;
}

function formatDuration(startTime: string, endTime: string | null): string | null {
  if (!endTime) return null;
  const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function toStartOfDayIso(dateYmd: string): string {
  return new Date(`${dateYmd}T00:00:00`).toISOString();
}

function toEndOfDayIso(dateYmd: string): string {
  return new Date(`${dateYmd}T23:59:59.999`).toISOString();
}

function formatTime(iso: string, today: string, yesterday: string): string {
  const d = new Date(iso);
  const now = new Date();
  const dDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const nDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((nDate.getTime() - dDate.getTime()) / 86400000);
  const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 0) return `${today} ${timeStr}`;
  if (diffDays === 1) return `${yesterday} ${timeStr}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${timeStr}`;
}

function parseIsoMs(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function integrateEnergyKwhFromPoints(
  points: { powerKw: number | null; timestamp: string }[],
  extendToMs?: number | null,
): number {
  if (!points.length) return 0;
  const ordered = [...points]
    .map((p) => ({ t: parseIsoMs(p.timestamp), p: p.powerKw != null ? Number(p.powerKw) : 0 }))
    .filter((x): x is { t: number; p: number } => x.t != null)
    .sort((a, b) => a.t - b.t);
  if (ordered.length < 2) return 0;

  let kwh = 0;
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1];
    const b = ordered[i];
    const dtH = (b.t - a.t) / 3_600_000;
    if (dtH <= 0) continue;
    const pa = Math.max(0, a.p);
    const pb = Math.max(0, b.p);
    kwh += ((pa + pb) / 2) * dtH;
  }

  if (extendToMs != null) {
    const last = ordered[ordered.length - 1];
    const dtMs = Math.max(0, Math.min(10 * 60_000, extendToMs - last.t));
    if (dtMs > 0) {
      kwh += Math.max(0, last.p) * (dtMs / 3_600_000);
    }
  }

  return kwh;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function chargerTypeLabel(type: string | null, t: (k: string) => string): string {
  switch (type) {
    case 'tesla_sc':
    case 'supercharger':
      return t('charging.supercharger');
    case 'dc_third':
      return t('charging.chargerType_dc_third');
    case 'dc_fast':
      return t('charging.chargerType_dc_fast');
    case 'ac_city':
      return t('charging.chargerType_ac_city');
    case 'home_wall':
      return t('charging.chargerType_home_wall');
    case 'home_slow':
      return t('charging.chargerType_home_slow');
    case 'ac_fast':
      return t('charging.chargerType_ac_fast');
    case 'ac_home':
      return t('charging.chargerType_ac_home');
    case 'ac_slow':
      return t('charging.chargerType_ac_slow');
    default:
      return type ?? t('common.unknown');
  }
}

function chargerTypeColor(type: string | null): string {
  switch (type) {
    case 'tesla_sc':
    case 'supercharger':
      return 'text-rose-300 bg-rose-500/12 border-rose-500/25';
    case 'dc_third':
    case 'dc_fast':
      return 'text-orange-300 bg-orange-500/12 border-orange-500/25';
    case 'ac_city':
    case 'ac_fast':
      return 'text-sky-300 bg-sky-500/12 border-sky-500/25';
    case 'home_wall':
    case 'home_slow':
    case 'ac_home':
    case 'ac_slow':
      return 'text-emerald-300 bg-emerald-500/12 border-emerald-500/25';
    default:
      return 'text-muted-foreground bg-[hsl(var(--secondary)/0.55)] border-[hsl(var(--border)/0.7)]';
  }
}

function costSourceBadge(source: string | null, t: (k: string) => string): string {
  if (!source) return '';
  if (source === 'manual')                        return t('charging.costSource_manual');
  if (source === 'tesla_api')                     return 'Tesla';
  if (source === 'tesla_api_estimate')            return t('charging.costSource_est');
  if (source === 'tariff')                        return t('charging.costSource_auto');
  if (source === 'supercharger')                  return t('charging.costSource_auto');
  if (source.startsWith('supercharger_tesla_api')) return t('charging.costSource_live');
  if (source.startsWith('supercharger_'))         return t('charging.costSource_cached');
  if (source === 'scope_missing')                 return t('charging.costSource_est');
  return '';
}

/* ─── Charging Smart Advisor ─────────────────────────────────── */
const HOME_TYPES = new Set(['home_wall', 'home_slow', 'ac_home', 'ac_slow', 'home_charger'])
const SC_TYPES = new Set(['tesla_sc', 'supercharger'])

interface AdvisorInsight {
  icon: React.ElementType
  iconColor: string
  label: string
  value: string
  sub?: string
}

function ChargingAdvisor({
  sessions,
  formatMoney,
}: {
  sessions: ApiSession[]
  formatMoney: (v: number) => string
}) {
  const { t } = useTranslation()
  const insights: AdvisorInsight[] = useMemo(() => {
    const done = sessions.filter((s) => s.endTime != null)
    if (done.length < 3) return []
    const result: AdvisorInsight[] = []

    // 1. Home vs Supercharger savings
    const homeDone = done.filter((s) => s.chargerType && HOME_TYPES.has(s.chargerType))
    if (homeDone.length >= 2) {
      const homeEnergy = homeDone.reduce((s, x) => s + (x.energyAddedKwh != null ? Number(x.energyAddedKwh) : 0), 0)
      const homeCost = homeDone.reduce((s, x) => s + (x.manualCost != null ? Number(x.manualCost) : x.costTotal != null ? Number(x.costTotal) : 0), 0)
      // Use actual SC sessions rate if available, otherwise European avg
      const scDone = done.filter((s) => s.chargerType && SC_TYPES.has(s.chargerType) && s.energyAddedKwh != null && (s.manualCost ?? s.costTotal) != null)
      const scRate = scDone.length >= 2
        ? scDone.reduce((s, x) => s + ((x.manualCost ?? x.costTotal ?? 0) / Math.max(0.1, Number(x.energyAddedKwh))), 0) / scDone.length
        : 0.40
      const scEquivCost = homeEnergy * scRate
      const savings = scEquivCost - homeCost
      if (savings > 0.5 && homeEnergy > 1) {
        result.push({
          icon: TrendingDown,
          iconColor: '#34d399',
          label: t('charging.smartAdvisorSavedVsSupercharger'),
          value: formatMoney(savings),
          sub: `${homeEnergy.toFixed(1)} kWh · ${homeDone.length} ${t('charging.sessionsCount').toLowerCase()}`,
        })
      }
    }

    // 2. Avg charge pattern
    const withSoc = done.filter((s) => s.startSoc != null && s.endSoc != null)
    if (withSoc.length >= 3) {
      const avgStart = withSoc.reduce((s, x) => s + Number(x.startSoc), 0) / withSoc.length
      const avgEnd = withSoc.reduce((s, x) => s + Number(x.endSoc), 0) / withSoc.length
      const avgEnergy = done
        .filter((s) => s.energyAddedKwh != null)
        .reduce((s, x) => s + Number(x.energyAddedKwh), 0) / done.filter((s) => s.energyAddedKwh != null).length
      result.push({
        icon: BatteryCharging,
        iconColor: '#60a5fa',
        label: t('charging.smartAdvisorAvgPattern'),
        value: `${Math.round(avgStart)}% → ${Math.round(avgEnd)}%`,
        sub: `~${Number.isFinite(avgEnergy) ? avgEnergy.toFixed(1) : '—'} kWh · ${withSoc.length} ${t('charging.sessionsCount').toLowerCase()}`,
      })
    }

    // 3. Most expensive session
    const withCost = done.filter((s) => (s.manualCost ?? s.costTotal) != null)
    if (withCost.length >= 2) {
      const expensive = withCost.reduce((best, s) => {
        const c = Number(s.manualCost ?? s.costTotal ?? 0)
        const bc = Number(best.manualCost ?? best.costTotal ?? 0)
        return c > bc ? s : best
      })
      const cost = Number(expensive.manualCost ?? expensive.costTotal ?? 0)
      if (cost > 0) {
        const date = new Date(expensive.startTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        result.push({
          icon: Zap,
          iconColor: '#fbbf24',
          label: t('charging.smartAdvisorPriciest'),
          value: formatMoney(cost),
          sub: `${date} · ${expensive.chargerType ?? t('common.unknown')} · ${expensive.energyAddedKwh != null ? `${Number(expensive.energyAddedKwh).toFixed(1)} kWh` : '—'}`,
        })
      }
    }

    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, t])

  if (!insights.length) return null

  const [open, setOpen] = useState(false)

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] shadow-lg mb-6 overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center justify-between w-full px-4 pt-4 pb-3 hover:bg-[hsl(var(--accent)/0.04)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-violet-400" />
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{t('charging.smartAdvisorTitle')}</span>
          {!open && (
            <span className="ml-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-400">
              {insights.length}
            </span>
          )}
        </div>
        <ChevronDown size={14} className={`text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="advisor-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="border-t border-[hsl(var(--border)/0.4)] divide-y divide-[hsl(var(--border)/0.3)]">
              {insights.map((ins, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: `${ins.iconColor}18` }}>
                    <ins.icon size={15} style={{ color: ins.iconColor }} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-muted-foreground">{ins.label}</p>
                    <p className="text-sm font-semibold text-foreground">{ins.value}</p>
                    {ins.sub && <p className="text-[10px] text-muted-foreground/70 mt-0.5 truncate">{ins.sub}</p>}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function ManualCostEditor({
  session,
  onSaved,
  token,
}: {
  session: ApiSession;
  onSaved: (id: string, cost: number) => void;
  token: string;
}) {
  const { t } = useTranslation();
  const { symbol: currSymbol, formatMoney: fmtMoney } = useCurrency();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    session.manualCost != null
      ? String(session.manualCost)
      : session.costTotal != null
      ? String(Number(session.costTotal).toFixed(2))
      : '',
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const cost = parseFloat(value);
    if (isNaN(cost)) return;
    setSaving(true);
    try {
      await apiClient.setSessionManualCost(session.id, cost, token);
      onSaved(session.id, cost);
      setEditing(false);
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  };

  const displayCost =
    session.manualCost != null
      ? session.manualCost
      : session.costTotal;

  if (!editing) {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <span
            className={`text-sm font-bold tabular-nums leading-tight ${
              session.endTime == null && displayCost == null
                ? 'text-muted-foreground font-medium'
                : 'text-emerald-300'
            }`}
          >
            {displayCost != null ? fmtMoney(Number(displayCost)) : '—'}
          </span>
          {session.endTime && (
            <button
              onClick={() => setEditing(true)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <Edit3 className="w-3 h-3" />
            </button>
          )}
        </div>
        {session.endTime != null && session.costSource && (
          <span className="text-[10px] text-muted-foreground leading-none">
            {costSourceBadge(session.costSource, t)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <span className="text-muted-foreground text-xs">{currSymbol}</span>
      <input
        type="number"
        step="0.01"
        min="0"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-16 px-1 py-0.5 rounded bg-[hsl(var(--surface-1))] border border-[hsl(var(--border))] text-foreground text-xs focus:outline-none focus:border-[hsl(var(--brand-h)_var(--brand-s)_var(--brand-l-500))]"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <button
        onClick={save}
        disabled={saving}
        className="text-green-400 hover:text-green-300 transition-colors"
      >
        {saving ? <Loader className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
      </button>
      <button onClick={() => setEditing(false)} className="text-muted-foreground hover:text-rose-300 transition-colors">
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

export default function ChargingPage() {
  const { accessToken } = useAuthStore();
  const { t } = useTranslation();
  const { symbol: currSymbol, formatMoney: fmtMoney } = useCurrency();
  const selectedVehicleId = useLayoutStore(s => s.selectedVehicleId);
  const setSelectedVehicleId = useLayoutStore(s => s.setSelectedVehicleId);
  const [vehicles, setVehicles] = useState<ApiVehicle[]>([]);
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [sessionsMeta, setSessionsMeta] = useState<{ clamped: boolean; limitDays: number } | null>(null);
  const [monthlyCosts, setMonthlyCosts] = useState<MonthlyCostEntry[]>([]);
  const [vehicleStatus, setVehicleStatus] = useState<ApiVehicleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = usePeriodParam(30);
  const lastWakePollAtRef = useRef<number>(0);

  const appliedRange = useMemo(() => periodToApiRange(period), [period]);

  // Load vehicles
  useEffect(() => {
    if (!accessToken) return;
    apiClient.getVehicles(accessToken)
      .then((data) => {
        const vs = data as unknown as ApiVehicle[];
        setVehicles(vs);
        if (vs.length > 0 && !selectedVehicleId) setSelectedVehicleId(vs[0].id);
        else setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [accessToken, selectedVehicleId, setSelectedVehicleId]);

  const loadChargingData = useCallback(async (showSpinner = false) => {
    if (!accessToken || !selectedVehicleId) return;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      if (showSpinner) {
        await apiClient.reconcileChargingSessions(selectedVehicleId, accessToken, 90).catch(() => undefined);
      }
      const limit = appliedRange?.from || appliedRange?.to ? 120 : 30;
      const [res, costs, status] = await Promise.all([
        apiClient.getChargingSessions(selectedVehicleId, limit, accessToken, appliedRange),
        apiClient.getChargingCostSummary(selectedVehicleId, 6, accessToken).catch(() => null),
        apiClient.getVehicleStatus(selectedVehicleId, accessToken).catch(() => null),
      ]);
      const s = (res as any).data ?? res;
      setSessions(s as unknown as ApiSession[]);
      if ((res as any).meta) setSessionsMeta({ clamped: (res as any).meta.clamped, limitDays: (res as any).meta.limitDays });
      if (costs) {
        setMonthlyCosts((costs as any).summary ?? []);
      }
      if (status) {
        const st = {
          soc: (status as any).soc ?? null,
          chargingState: (status as any).chargingState ?? null,
          batteryRangeKm: (status as any).batteryRangeKm ?? null,
          dataFreshnessSec: (status as any).dataFreshnessSec ?? null,
          lastUpdate: (status as any).lastUpdate ?? null,
        };
        setVehicleStatus(st);
        // Dynamic wake refresh: when car is stale/offline, periodically poke backend wake-poll.
        // This makes the page become "live" shortly after the vehicle wakes up.
        if (
          st.dataFreshnessSec != null &&
          st.dataFreshnessSec > 5 * 60 &&
          Date.now() - lastWakePollAtRef.current > 3 * 60_000
        ) {
          lastWakePollAtRef.current = Date.now();
          apiClient.wakePoll(selectedVehicleId, accessToken).catch(() => undefined);
        }
      } else {
        setVehicleStatus(null);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [accessToken, selectedVehicleId, appliedRange]);


  // Initial load (sessions + monthly costs + status)
  useEffect(() => {
    if (!accessToken || !selectedVehicleId) return;
    void loadChargingData(true);
  }, [accessToken, selectedVehicleId, loadChargingData]);

  // Dynamic auto-refresh while page is open.
  useEffect(() => {
    if (!accessToken || !selectedVehicleId) return;
    const intervalMs =
      vehicleStatus?.chargingState === 'Charging'
        ? 30_000
        : 60_000;
    const timer = setInterval(() => {
      void loadChargingData(false);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [accessToken, selectedVehicleId, vehicleStatus?.chargingState, loadChargingData]);

  const handleCostSaved = useCallback((sessionId: string, cost: number) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, manualCost: cost, costTotal: cost, costSource: 'manual' }
          : s,
      ),
    );
  }, []);

  const today    = t('common.today');
  const yesterday = t('common.yesterday');

  // Charger type metadata for charts
  const CHARGER_STACKS = [
    { key: 'home',   label: 'Home',         color: '#10b981', gradId: 'gHome' },
    { key: 'sc',     label: 'Supercharger', color: '#f43f5e', gradId: 'gSC'   },
    { key: 'dc',     label: 'DC Fast',      color: '#f59e0b', gradId: 'gDC'   },
    { key: 'public', label: 'AC Public',    color: '#0ea5e9', gradId: 'gPub'  },
  ] as const;
  type StackKey = typeof CHARGER_STACKS[number]['key'];

  function toStackKey(type: string | null): StackKey {
    if (!type) return 'home';
    if (type === 'tesla_sc' || type === 'supercharger') return 'sc';
    if (type === 'dc_third' || type === 'dc_fast')      return 'dc';
    if (type === 'ac_city'  || type === 'ac_slow')      return 'public';
    return 'home'; // home_wall, home_slow, ac_home, ac_fast → home
  }

  // Session timeline: group completed sessions by date, stack by charger category
  const timelineData = (() => {
    const byDate: Record<string, { home: number; sc: number; dc: number; public: number; count: number; cost: number }> = {};
    for (const s of sessions) {
      if (!s.endTime) continue;
      const dateKey = s.startTime.slice(0, 10);
      if (!byDate[dateKey]) byDate[dateKey] = { home: 0, sc: 0, dc: 0, public: 0, count: 0, cost: 0 };
      const sk = toStackKey(s.chargerType);
      byDate[dateKey][sk] = Math.round((byDate[dateKey][sk] + (s.energyAddedKwh != null ? Number(s.energyAddedKwh) : 0)) * 100) / 100;
      byDate[dateKey].count += 1;
      byDate[dateKey].cost += (s.manualCost ?? s.costTotal) != null ? Number(s.manualCost ?? s.costTotal) : 0;
    }
    return Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, vals]) => ({
        date: new Date(date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        ...vals,
        total: Math.round((vals.home + vals.sc + vals.dc + vals.public) * 10) / 10,
      }));
  })();

  // Per-category totals for legend
  const stackTotals = CHARGER_STACKS.map((s) => ({
    ...s,
    total: sessions.reduce((acc, sess) => {
      if (!sess.endTime || toStackKey(sess.chargerType) !== s.key) return acc;
      return acc + (sess.energyAddedKwh != null ? Number(sess.energyAddedKwh) : 0);
    }, 0),
  })).filter((s) => s.total > 0);

  const totalEnergy = sessions.reduce((s, c) => s + (c.energyAddedKwh != null ? Number(c.energyAddedKwh) : 0), 0);
  const totalCost = sessions.reduce((s, c) => {
    const cost = c.manualCost ?? c.costTotal;
    return s + (cost != null ? Number(cost) : 0);
  }, 0);
  const completedSessions = sessions.filter((s) => s.endTime != null);
  const periodDeltas = useChargingPeriodStats(sessions);
  const activeSession = sessions.find((s) => s.endTime == null) ?? null;
  const chargingStateFresh =
    vehicleStatus?.chargingState === 'Charging' &&
    vehicleStatus?.dataFreshnessSec != null &&
    vehicleStatus.dataFreshnessSec < 20 * 60;
  const fallbackChargingSession = chargingStateFresh
    ? sessions.find((s) => {
        if (s.endTime == null) return true;
        const endMs = parseIsoMs(s.endTime);
        if (endMs == null) return false;
        return Date.now() - endMs <= 20 * 60_000;
      }) ?? null
    : null;
  const syntheticAnchorSession = !activeSession && chargingStateFresh
    ? sessions.find((s) => {
        if (!s.endTime) return false;
        const endMs = parseIsoMs(s.endTime);
        const startMs = parseIsoMs(s.startTime);
        const nowMs = Date.now();
        if (endMs == null || startMs == null) return false;
        // If Tesla reports active charging but detector already closed the session,
        // keep continuity for long home charging by anchoring to the recent closed row.
        const withinWindow = nowMs - endMs <= 12 * 60 * 60_000;
        const socCompatible =
          vehicleStatus?.soc == null ||
          s.startSoc == null ||
          Number(vehicleStatus.soc) >= Number(s.startSoc) - 1;
        return withinWindow && socCompatible;
      }) ?? null
    : null;
  const syntheticActiveSession: ApiSession | null =
    !activeSession &&
    chargingStateFresh &&
    vehicleStatus?.lastUpdate
      ? {
          id: 'synthetic-active',
          vehicleId: selectedVehicleId ?? 'unknown',
          startTime: syntheticAnchorSession?.startTime ?? vehicleStatus.lastUpdate,
          endTime: null,
          startSoc: syntheticAnchorSession?.startSoc ?? vehicleStatus.soc,
          endSoc: vehicleStatus.soc,
          energyAddedKwh: null,
          maxPowerKw: null,
          chargerType: syntheticAnchorSession?.chargerType ?? null,
          costTotal: null,
          costPerKwh: null,
          costSource: null,
          manualCost: null,
          currency: null,
          points: [],
        }
      : null;
  const showActiveCard = !!activeSession || chargingStateFresh;
  const activeBaseSession = activeSession ?? fallbackChargingSession ?? syntheticActiveSession;

  // Build one logical "charging chain" from neighboring fragments
  // (same charger + tiny gap) and use the earliest fragment as baseline.
  const chainBaseSession = (() => {
    if (!activeBaseSession) return null;
    let base = activeBaseSession;
    let guard = 0;
    while (guard < 8) {
      guard++;
      const baseStartMs = parseIsoMs(base.startTime);
      if (baseStartMs == null) break;
      const prev = sessions.find((s) => {
        if (!s.endTime) return false;
        if ((s.chargerType ?? null) !== (base.chargerType ?? null)) return false;
        const endMs = parseIsoMs(s.endTime);
        if (endMs == null) return false;
        const gap = baseStartMs - endMs;
        return gap >= 0 && gap <= 2 * 60_000;
      });
      if (prev) {
        base = prev;
        continue;
      }
      // Fallback for detector-fragmented long home charging:
      // if car is currently charging, allow stitching with a larger gap
      // to preserve one continuous charging block in UI.
      if (chargingStateFresh) {
        const logicalPrev = sessions.find((s) => {
          if (!s.endTime) return false;
          if ((s.chargerType ?? null) !== (base.chargerType ?? null)) return false;
          const endMs = parseIsoMs(s.endTime);
          const startMs = parseIsoMs(s.startTime);
          if (endMs == null || startMs == null) return false;
          const gap = baseStartMs - endMs;
          if (!(gap >= 0 && gap <= 12 * 60 * 60_000)) return false;
          // Same local day is a strong signal this is one long home session.
          const sameDay =
            new Date(startMs).toDateString() === new Date(baseStartMs).toDateString();
          return sameDay;
        });
        if (logicalPrev) {
          base = logicalPrev;
          continue;
        }
      }
      break;
    }
    return base;
  })();

  const progressBaseSession = chainBaseSession ?? activeBaseSession;
  const activeDuration = progressBaseSession ? formatDuration(progressBaseSession.startTime, new Date().toISOString()) : null;
  const latestPointSoc = (() => {
    const pts = activeBaseSession?.points ?? [];
    if (!pts.length) return null;
    const latest = [...pts].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
    return latest?.soc ?? null;
  })();
  /** Same charger, from chain start, stopping at a >12h gap (avoids hiding a second same-day plug-in). */
  const chainSessions = (() => {
    if (!progressBaseSession) return null;
    const sameType = sessions.filter(
      (s) => (s.chargerType ?? null) === (progressBaseSession.chargerType ?? null),
    );
    const sorted = [...sameType].sort(
      (a, b) => (parseIsoMs(a.startTime) ?? 0) - (parseIsoMs(b.startTime) ?? 0),
    );
    const idx = sorted.findIndex((s) => s.id === progressBaseSession.id);
    if (idx < 0) return null;
    const maxGapMs = 12 * 60 * 60_000;
    const out: ApiSession[] = [sorted[idx]];
    let prevEndMs = sorted[idx].endTime ? parseIsoMs(sorted[idx].endTime) : Date.now();
    for (let j = idx + 1; j < sorted.length; j++) {
      const s = sorted[j];
      const sm = parseIsoMs(s.startTime);
      if (sm == null) continue;
      if (prevEndMs != null && sm - prevEndMs > maxGapMs) break;
      out.push(s);
      prevEndMs = s.endTime ? parseIsoMs(s.endTime) : Date.now();
    }
    return out;
  })();
  const chainCurrentSoc = (() => {
    if (!chainSessions) return null;
    const endSocs = chainSessions
      .map((s) => (s.endSoc != null ? Number(s.endSoc) : null))
      .filter((v): v is number => v != null);
    if (!endSocs.length) return null;
    return Math.max(...endSocs);
  })();
  const addedEnergyKwhLive = (() => {
    if (!chainSessions?.length) return null;
    const closedKwh = chainSessions.reduce((sum, s) => {
      if (s.endTime == null) return sum;
      return sum + (s.energyAddedKwh != null ? Number(s.energyAddedKwh) : 0);
    }, 0);
    const open = chainSessions.find((s) => s.endTime == null) ?? null;
    const openKwh = open
      ? integrateEnergyKwhFromPoints(
          open.points ?? [],
          chargingStateFresh ? Date.now() : null,
        )
      : 0;
    const total = closedKwh + openKwh;
    return Number.isFinite(total) ? Math.max(0, total) : null;
  })();
  const statusSocFresh =
    vehicleStatus?.soc != null &&
    vehicleStatus?.dataFreshnessSec != null &&
    vehicleStatus.dataFreshnessSec < (chargingStateFresh ? 25 * 60 : 10 * 60);
  const progressStartSoc =
    progressBaseSession?.startSoc != null ? Number(progressBaseSession.startSoc) : null;
  const rawCurrentSoc = statusSocFresh
    ? vehicleStatus!.soc
    : (chainCurrentSoc ?? latestPointSoc ?? activeBaseSession?.endSoc ?? vehicleStatus?.soc ?? null);
  const isActivelyCharging = chargingStateFresh || !!activeSession;
  const chargingDataTooStale =
    isActivelyCharging &&
    vehicleStatus?.dataFreshnessSec != null &&
    vehicleStatus.dataFreshnessSec > 25 * 60;
  const currentSoc = chargingDataTooStale
    ? null
    :
    isActivelyCharging && progressStartSoc != null
      ? Math.max(
          progressStartSoc,
          ...(rawCurrentSoc != null ? [Number(rawCurrentSoc)] : []),
          ...(chainCurrentSoc != null ? [Number(chainCurrentSoc)] : []),
          ...(latestPointSoc != null ? [Number(latestPointSoc)] : []),
          ...(activeBaseSession?.endSoc != null ? [Number(activeBaseSession.endSoc)] : []),
        )
      : rawCurrentSoc;
  const activeSocDelta =
    progressStartSoc != null && currentSoc != null
      ? currentSoc - progressStartSoc
      : null;
  const socToKwhFactor = (() => {
    const factors = sessions
      .map((s) => {
        const e = s.energyAddedKwh != null ? Number(s.energyAddedKwh) : null;
        const start = s.startSoc != null ? Number(s.startSoc) : null;
        const end = s.endSoc != null ? Number(s.endSoc) : null;
        if (e == null || start == null || end == null) return null;
        const ds = end - start;
        if (ds <= 0 || e <= 0) return null;
        return e / ds;
      })
      .filter((v): v is number => v != null && Number.isFinite(v) && v > 0.05 && v < 2.5);
    return median(factors) ?? 0.68;
  })();
  const derivedEnergyBySoc =
    activeSocDelta != null && activeSocDelta > 0
      ? Math.max(0, activeSocDelta * socToKwhFactor)
      : null;
  const activeEnergyKwh =
    addedEnergyKwhLive == null
      ? derivedEnergyBySoc
      : (
        derivedEnergyBySoc != null && addedEnergyKwhLive < derivedEnergyBySoc * 0.35
          ? derivedEnergyBySoc
          : addedEnergyKwhLive
      );
  const normalizedSocDelta = activeSocDelta != null ? Math.abs(activeSocDelta) : null;
  const socDirectionUp = activeSocDelta != null ? activeSocDelta >= 0 : true;
  const currentRangeKm = vehicleStatus?.batteryRangeKm ?? null;
  const addedRangeKm =
    progressStartSoc != null &&
    currentSoc != null &&
    currentRangeKm != null &&
    currentSoc > 0
      ? Math.max(0, (currentRangeKm / currentSoc) * (currentSoc - progressStartSoc))
      : null;
  const sessionsForList = (() => {
    if (!sessions.length) return sessions;
    if (!showActiveCard || !progressBaseSession) return sessions;
    const chainIds = new Set((chainSessions ?? []).map((s) => s.id));
    const mergedActive: ApiSession = {
      ...progressBaseSession,
      endTime: null,
      endSoc: currentSoc ?? progressBaseSession.endSoc,
      energyAddedKwh: activeEnergyKwh ?? progressBaseSession.energyAddedKwh,
    };
    const rest = sessions.filter((s) => !chainIds.has(s.id));
    return [mergedActive, ...rest].sort(
      (a, b) => (parseIsoMs(b.startTime) ?? 0) - (parseIsoMs(a.startTime) ?? 0),
    );
  })();

  return (
    <Page title={t('pages.charging.title')} subtitle={t('pages.charging.subtitle', { count: sessions.length })}>
      {/* Entitlement clamped banner */}
      {sessionsMeta?.clamped && sessionsMeta.limitDays < 365 && (
        <div className="mb-4">
          <ClampedBanner days={sessionsMeta.limitDays} />
        </div>
      )}

      <div className="mb-6">
        <PeriodFilterBar value={period} onChange={setPeriod} defaultPeriod={30} />
      </div>

      {/* Vehicle selector */}
      {vehicles.length > 1 && (
        <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
          {vehicles.map((v) => (
            <button
              key={v.id}
              onClick={() => setSelectedVehicleId(v.id)}
              className={`px-3 py-1.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${
                selectedVehicleId === v.id
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                  : 'bg-[hsl(var(--surface-1))] text-muted-foreground border border-[hsl(var(--border)/0.7)] hover:border-[hsl(var(--border))]'
              }`}
            >
              <Car size={14} className="inline mr-1.5" />
              {v.model}{v.trim ? ` ${v.trim}` : ''} {v.year ? `(${v.year})` : ''}
            </button>
          ))}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {([
          { icon: <Zap size={18} />,   label: t('charging.totalEnergy30d'), value: `${totalEnergy.toFixed(1)}`, unit: 'kWh', color: 'text-emerald-400', bg: 'bg-emerald-500/8 border-emerald-500/15', glow: 'shadow-emerald-500/10', delta: periodDeltas?.totalEnergy,    invertColor: false },
          { icon: <Clock size={18} />, label: t('charging.sessionsCount'),   value: String(completedSessions.length), unit: '', color: 'text-sky-400', bg: 'bg-sky-500/8 border-sky-500/15', glow: 'shadow-sky-500/10', delta: periodDeltas?.count, invertColor: false },
          { icon: <Gauge size={18} />, label: t('charging.avgPerSession'),   value: completedSessions.length > 0 ? (totalEnergy / completedSessions.length).toFixed(1) : '—', unit: completedSessions.length > 0 ? 'kWh' : '', color: 'text-amber-400', bg: 'bg-amber-500/8 border-amber-500/15', glow: 'shadow-amber-500/10', delta: periodDeltas?.avgPerSession, invertColor: false },
          { icon: <MetricBanknoteIcon size={18} className="shrink-0" />, label: t('charging.totalCost30d'), value: totalCost > 0 ? fmtMoney(totalCost) : '—', unit: '', unitPrefix: false, color: 'text-violet-400', bg: 'bg-violet-500/8 border-violet-500/15', glow: 'shadow-violet-500/10', delta: periodDeltas?.totalCost, invertColor: true },
        ] as const).map((s) => (
          <div key={s.label} className={`rounded-2xl border p-4 shadow-lg ${s.bg} ${s.glow}`}>
            <div className={`flex items-center gap-1.5 mb-2 ${s.color}`}>
              {s.icon}
              <span className="text-[11px] font-semibold uppercase tracking-wider opacity-80">{s.label}</span>
            </div>
            <div className="flex items-end justify-between gap-1 flex-wrap">
              <p className={`text-2xl font-bold tabular-nums ${s.color}`}>
                {(s as any).unitPrefix && s.unit}{s.value}
                {!(s as any).unitPrefix && s.unit && <span className="text-sm font-normal ml-1 opacity-70">{s.unit}</span>}
              </p>
              {(s as any).delta != null && <PeriodDeltaBadge delta={(s as any).delta} unit="%" invertColor={(s as any).invertColor} precision={0} />}
            </div>
          </div>
        ))}
      </div>

      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} />
      ) : vehicles.length === 0 ? (
        <EmptyState
          icon={<Zap size={28} className="text-green-400" />}
          title={t('pages.vehicles.noVehicles')}
          description={t('charging.noVehiclesHint')}
          action={(
            <Link href="/settings">
              <motion.div
                whileHover={{ scale: 1.03 }}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition-colors cursor-pointer"
              >
                {t('header.connectTesla')}
              </motion.div>
            </Link>
          )}
        />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={<Zap size={28} className="text-muted-foreground" />}
          title={t('charging.noSessions')}
          description={t('charging.noSessionsHint')}
        />
      ) : (
        <>
          {showActiveCard && activeBaseSession && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl border border-emerald-500/25 bg-emerald-500/8 shadow-xl px-5 py-4 mb-6"
            >
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <Zap size={16} className="text-emerald-300 animate-pulse" />
                  <span className="text-sm font-semibold text-emerald-200">{t('charging.active')}</span>
                </div>
                <div className="text-xs text-emerald-100/80">
                  {formatTime(activeBaseSession.startTime, today, yesterday)}
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                <div>
                  <p className="text-[11px] text-emerald-100/70">{t('charging.duration')}</p>
                  <p className="text-sm font-semibold text-emerald-100">{activeDuration ?? '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-emerald-100/70">SOC</p>
                  <p className="text-sm font-semibold text-emerald-100">
                    {progressStartSoc != null ? `${Math.round(progressStartSoc)}%` : '—'}
                    {currentSoc != null ? ` → ${Math.round(currentSoc)}%` : ''}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-emerald-100/70">{t('charging.energy')}</p>
                  <p className="text-sm font-semibold text-emerald-100">
                    {activeEnergyKwh != null ? `+${activeEnergyKwh.toFixed(2)} kWh` : '—'}
                    {normalizedSocDelta != null && (
                      <span className="ml-2 text-emerald-200/85">
                        (~{socDirectionUp ? '+' : '-'}{normalizedSocDelta.toFixed(1)}% SOC)
                      </span>
                    )}
                    {addedRangeKm != null && <span className="ml-2 text-emerald-200/85">(+{addedRangeKm.toFixed(1)} km)</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-emerald-100/70">State</p>
                  <p className="text-sm font-semibold text-emerald-100">{vehicleStatus?.chargingState ?? 'Charging'}</p>
                </div>
              </div>
            </motion.div>
          )}

          <ChargingAdvisor sessions={sessions} formatMoney={fmtMoney} />

          <ChargingCharts
            timelineData={timelineData}
            stackTotals={stackTotals}
            monthlyCosts={monthlyCosts}
          />

                    {/* Sessions list */}
          <div className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] shadow-xl overflow-hidden">
            {/* List header */}
            <div className="px-5 pt-5 pb-4 border-b border-[hsl(var(--border)/0.45)] flex items-center gap-2">
              <Zap size={16} className="text-amber-400" />
              <div>
                <span className="text-base font-semibold text-foreground">{t('charging.recentSessions')}</span>
                <span className="ml-2 text-sm text-muted-foreground">{t('pages.charging.subtitle', { count: sessionsForList.length })}</span>
              </div>
            </div>

            {/* Session rows */}
            <div className="divide-y divide-[hsl(var(--border)/0.35)]">
              {sessionsForList.map((session) => (
                <motion.div
                  key={session.id}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="hover:bg-[hsl(var(--secondary)/0.15)] transition-colors px-5 py-4"
                >
                  {/* ── Header: icon + time + type badge + peak ── */}
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      {session.endTime ? (
                        <CheckCircle size={14} className="text-emerald-400 shrink-0" />
                      ) : (
                        <Zap size={14} className="text-amber-400 animate-pulse shrink-0" />
                      )}
                      <p className="font-semibold text-foreground text-sm truncate">
                        {formatTime(session.startTime, today, yesterday)}
                      </p>
                      {session.endTime == null && (
                        <StatusBadge type="warning" label={t('charging.active')} />
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[10px] px-2 py-0.5 rounded-lg border ${chargerTypeColor(session.chargerType)}`}>
                        {chargerTypeLabel(session.chargerType, t)}
                      </span>
                      {session.maxPowerKw != null && (
                        <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                          {t('charging.peak')}: {Number(session.maxPowerKw).toFixed(1)} kW
                        </span>
                      )}
                    </div>
                  </div>

                  {/* ── Stats: 2-col on mobile, 4-col on sm+ ── */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2.5">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                        {t('charging.duration')}
                      </p>
                      <p className="text-sm font-semibold text-foreground tabular-nums">
                        {formatDuration(session.startTime, session.endTime) ?? t('trips.inProgress')}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                        {t('charging.energy')}
                      </p>
                      <p className={`text-sm font-semibold tabular-nums ${
                        session.endTime == null && session.energyAddedKwh == null
                          ? 'text-muted-foreground'
                          : 'text-blue-400'
                      }`}>
                        {session.energyAddedKwh != null
                          ? `${Number(session.energyAddedKwh).toFixed(1)} kWh`
                          : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">SOC</p>
                      <p className="text-sm font-semibold text-foreground tabular-nums">
                        {session.startSoc != null ? `${Math.round(Number(session.startSoc))}%` : '—'}
                        {session.startSoc != null && session.endSoc != null && (
                          <span className="text-muted-foreground mx-0.5">→</span>
                        )}
                        {session.endSoc != null ? `${Math.round(Number(session.endSoc))}%` : ''}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                        {t('charging.cost')}
                      </p>
                      <ManualCostEditor
                        session={session}
                        onSaved={handleCostSaved}
                        token={accessToken ?? ''}
                      />
                      {session.endTime == null && (
                        <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">
                          {t('charging.costPendingSession')}
                        </p>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
