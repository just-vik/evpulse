'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Page } from '@/components/layout';
import { Battery, TrendingDown, Zap, Thermometer, AlertTriangle, CheckCircle, Loader, Info, BarChart2, Cpu } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { LoadingState } from '@/shared/ui/LoadingState';
import { useAuthStore } from '@/stores/authStore';
import { useLayoutStore } from '@/stores/layout.store';
import { apiClient } from '@/lib/api';
import type { BatteryHealth } from '@/types/api';
import dynamic from 'next/dynamic';
import type { ProjectionPoint } from '@/widgets/charts/DegradationChart';
import { BatteryRecommendations } from '@/components/battery/BatteryRecommendations';
import { PremiumGate } from '@/components/premium/PremiumGate';
import { Lock } from 'lucide-react';

/* ─── Pack Diagnostics ───────────────────────────────────────── */

const CELL_COUNT = 96;

function PackDiagnosticsSection({
  packVoltageV,
  soc,
}: {
  packVoltageV: number | null;
  soc: number | null;
}) {
  const { t } = useTranslation();
  const hasVoltage = packVoltageV != null && packVoltageV > 300;
  const avgCellV = hasVoltage ? packVoltageV! / CELL_COUNT : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] shadow-xl overflow-hidden mb-6"
    >
      <div className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Cpu size={16} className="text-violet-400" />
          <h3 className="text-base font-semibold text-foreground">{t('battery.diagnostics.title')}</h3>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {/* Pack voltage */}
          <div className="rounded-xl bg-violet-500/8 border border-violet-500/15 p-3">
            <p className="text-[10px] text-muted-foreground mb-1">{t('battery.diagnostics.packVoltage')}</p>
            <p className="text-xl font-bold text-violet-300 leading-tight">
              {hasVoltage ? packVoltageV!.toFixed(1) : '—'}
              {hasVoltage && <span className="text-sm font-normal text-muted-foreground ml-1">V</span>}
            </p>
          </div>

          {/* Avg cell voltage — calculated, not per-cell measured */}
          <div className="rounded-xl bg-sky-500/8 border border-sky-500/15 p-3">
            <p className="text-[10px] text-muted-foreground mb-1">{t('battery.diagnostics.avgCellVoltage')}</p>
            <p className="text-xl font-bold text-sky-300 leading-tight">
              {avgCellV != null ? avgCellV.toFixed(4) : '—'}
              {avgCellV != null && <span className="text-sm font-normal text-muted-foreground ml-1">V</span>}
            </p>
          </div>

          {/* SOC */}
          <div className="rounded-xl bg-emerald-500/8 border border-emerald-500/15 p-3">
            <p className="text-[10px] text-muted-foreground mb-1">{t('battery.diagnostics.stateOfCharge')}</p>
            <p className="text-xl font-bold text-emerald-300 leading-tight">
              {soc != null ? Math.round(soc) : '—'}
              {soc != null && <span className="text-sm font-normal text-muted-foreground ml-1">%</span>}
            </p>
          </div>
        </div>

        <p className="text-[10px] text-muted-foreground/50 mt-4 flex items-center gap-1">
          <Info size={10} className="shrink-0" />
          {t('battery.diagnostics.note')}
        </p>
      </div>
    </motion.div>
  );
}

function PackDiagnosticsTeaser() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative rounded-2xl overflow-hidden border border-[hsl(var(--border)/0.5)] mb-6">
      {/* Blurred preview */}
      <div className="blur-sm opacity-35 pointer-events-none select-none">
        <PackDiagnosticsSection
          packVoltageV={390}
          soc={80}
        />
      </div>
      {/* Overlay */}
      <div className="absolute inset-0 flex flex-col items-center justify-center
                      bg-gradient-to-b from-transparent via-[hsl(var(--background)/0.75)] to-[hsl(var(--background)/0.97)]">
        <div className="text-center px-6">
          <div className="w-10 h-10 rounded-full bg-brand-500/20 flex items-center justify-center mx-auto mb-3">
            <Lock size={18} className="text-brand-400" />
          </div>
          <p className="text-sm font-semibold text-foreground mb-1">
            {t('premium.pack-diagnostics.title')}
          </p>
          <p className="text-xs text-muted-foreground mb-4 max-w-[200px] mx-auto">
            {t('premium.pack-diagnostics.description')}
          </p>
          <button
            onClick={() => setOpen(true)}
            className="px-4 py-3 min-h-[44px] rounded-xl bg-brand-500 text-white text-sm font-medium hover:brightness-110 transition-all"
          >
            {t('premium.upgrade')}
          </button>
        </div>
      </div>
      <UpgradeModal open={open} onOpenChange={setOpen} />
    </div>
  );
}

const UpgradeModal = dynamic(
  () => import('@/components/billing/UpgradeModal').then(m => m.UpgradeModal),
  { ssr: false },
);

const BatteryHistoryChart = dynamic(
  () => import('@/widgets/charts/BatteryHistoryChart').then(m => m.BatteryHistoryChart),
  { ssr: false, loading: () => <div className="h-48 rounded-xl bg-[hsl(var(--secondary)/0.7)] animate-pulse" /> },
);

const DegradationChart = dynamic(
  () => import('@/widgets/charts/DegradationChart').then(m => m.DegradationChart),
  { ssr: false, loading: () => <div className="h-48 rounded-xl bg-[hsl(var(--secondary)/0.7)] animate-pulse" /> },
);

interface BatteryHealthData {
  vehicleId: string;
  sohPercent: number;
  sohRaw?: number;
  isEstimate?: boolean;
  estimatedCapacityKwh: number;
  nominalCapacityKwh: number;
  degradationPercent: number;
  method: string;
  confidenceScore: number;
  lowData?: boolean;
  baselineLocked: boolean;
  baselineConfidence?: 'HIGH' | 'MEDIUM' | 'NONE';
  baselineHighKwh?: number | null;
  baselineMediumKwh?: number | null;
  baselineKwh?: number | null;
  dataQuality?: 'learning' | 'ok' | 'high';
  chargesNeededForHighBaseline?: number;
  qualifyingChargeSessions?: number;
  tripSoh?: number;
  chargingSoh?: number;
  avgBatteryTempC?: number;
  updatedAt?: string;
  vehicle?: {
    model: string;
    year?: number;
    spec?: { batteryNominalKwh: number; batteryUsableKwh: number; rangeWltp?: number };
  };
}

interface DegradationTrendData {
  samples: number;
  hasTrend: boolean;
  degradationPerMonth: number | null;
  projectedSoh1Year: number | null;
  projectedSoh5Year: number | null;
  data: { timestamp: string; sohPercent: number; degradation: number; method: string }[];
}

function getSohStatus(soh: number): 'good' | 'warning' | 'critical' {
  if (soh >= 90) return 'good';
  if (soh >= 75) return 'warning';
  return 'critical';
}

export default function BatteryPage() {
  const { accessToken } = useAuthStore();
  const { t, i18n } = useTranslation();
  const vehicleId = useLayoutStore(s => s.selectedVehicleId);
  const setSelectedVehicleId = useLayoutStore(s => s.setSelectedVehicleId);
  const [health, setHealth] = useState<BatteryHealthData | null>(null);
  const [trend, setTrend] = useState<DegradationTrendData | null>(null);
  const [batteryHistory, setBatteryHistory] = useState<BatteryHealth[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveVoltage, setLiveVoltage] = useState<number | null>(null);
  const [liveBatteryTemp, setLiveBatteryTemp] = useState<number | null>(null);
  const [liveSoc, setLiveSoc] = useState<number | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    apiClient.getVehicles(accessToken)
      .then(async (vehicles: any[]) => {
        if (!vehicles.length) { setLoading(false); return; }
        const vid = vehicleId ?? vehicles[0].id;
        if (!vehicleId) setSelectedVehicleId(vid);
        try {
          const [h, t, hist, status] = await Promise.all([
            apiClient.getBatteryHealth(vid, accessToken).catch(() => null),
            fetch(`/api/v1/battery/${vid}/degradation?days=180`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            }).then(r => (r.ok ? r.json() : null)).catch(() => null),
            apiClient.getBatteryHistory(vid, 30, accessToken).catch(() => [] as BatteryHealth[]),
            fetch(`/api/v1/vehicles/${vid}/status`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            }).then(r => (r.ok ? r.json() : null)).catch(() => null),
          ]);
          if (h) setHealth(h as BatteryHealthData);
          if (t) setTrend(t as DegradationTrendData);
          setBatteryHistory(Array.isArray(hist) ? hist : []);
          if (status) {
            setLiveVoltage((status as any).voltage ?? null);
            setLiveBatteryTemp((status as any).batteryTemp ?? null);
            setLiveSoc((status as any).soc ?? null);
          }
        } catch { /* no battery data yet */ }
        setLoading(false);
      })
      .catch((err: Error) => { setError(err.message); setLoading(false); });
  }, [accessToken, vehicleId, setSelectedVehicleId]);

  const confidence      = health?.baselineConfidence ?? 'NONE';
  const dataQuality     = health?.dataQuality ?? (health?.baselineLocked ? 'ok' : 'learning');
  const isCalibrating   = dataQuality === 'learning';
  const isLowData       = health?.lowData ?? false;
  // SOH display: cap at 100 when no baseline, show confidence tier
  const displaySoh      = isCalibrating ? Math.min(100, health?.sohPercent ?? 100) : (health?.sohPercent ?? 100);
  const sohDisplayLabel = isCalibrating
    ? `~${displaySoh.toFixed(0)}%`
    : `${displaySoh.toFixed(1)}%`;
  // Capacity is a current-state reading — a tilde-prefixed number is still a
  // useful reference point while calibrating. Degradation is a comparison
  // against baseline: with no baseline yet there is nothing to compare
  // against, so "~0.0%" would misleadingly read as "almost no wear" rather
  // than "not computed yet" — show it as pending instead, not as a number.
  const degradationDisplayLabel = `${Math.max(0, health?.degradationPercent ?? 0).toFixed(1)}%`;
  const isDegradationPending = isCalibrating;
  const capacityDisplayLabel = isCalibrating
    ? `~${(health?.estimatedCapacityKwh ?? 0).toFixed(1)}`
    : `${(health?.estimatedCapacityKwh ?? 0).toFixed(1)}`;
  const sohStatus       = health ? getSohStatus(displaySoh) : 'good';
  const sohTone = sohStatus === 'good' ? 'success' : sohStatus === 'warning' ? 'warning' : 'danger';
  const isUnreliable = !!(trend?.hasTrend && (trend.degradationPerMonth ?? 0) > 0.5 && (trend.samples ?? 0) < 500);
  const pageTitle       = isCalibrating
    ? t('battery.titleEstimated')
    : t('battery.title');

  const degradationChartData = useMemo(
    () =>
      trend?.data?.map((p) => ({
        label: new Date(p.timestamp).toLocaleDateString(i18n.language || 'en', {
          month: 'short',
          day: 'numeric',
        }),
        soh: p.sohPercent,
        timestamp: p.timestamp,
      })) ?? [],
    [trend, i18n.language],
  );

  const projectionData = useMemo((): ProjectionPoint[] | undefined => {
    if (!trend?.hasTrend || !trend.degradationPerMonth || !trend.data?.length) return undefined;
    const lastPoint = trend.data[trend.data.length - 1];
    if (!lastPoint) return undefined;
    const lastSoh = lastPoint.sohPercent;
    const rate = trend.degradationPerMonth;
    const base = new Date(lastPoint.timestamp);
    const points: ProjectionPoint[] = [];
    for (let m = 3; m <= 12; m += 3) {
      const date = new Date(base);
      date.setMonth(date.getMonth() + m);
      const label = date.toLocaleDateString(i18n.language || 'en', { month: 'short', year: '2-digit' });
      const soh = Math.max(0, lastSoh - rate * m);
      const uncertainty = Math.min(2.5, rate * m * 0.35);
      points.push({
        label,
        soh: Math.round(soh * 10) / 10,
        upper: Math.min(100, Math.round((soh + uncertainty) * 10) / 10),
        lower: Math.max(0, Math.round((soh - uncertainty) * 10) / 10),
      });
    }
    return points;
  }, [trend, i18n.language]);

  const batteryHistoryPoints = useMemo(() => {
    if (!batteryHistory?.length) return [];
    return [...batteryHistory]
      .filter((h) => h.updatedAt)
      .sort(
        (a, b) =>
          new Date(a.updatedAt!).getTime() - new Date(b.updatedAt!).getTime(),
      )
      .map((h) => ({
        time: new Date(h.updatedAt!).toLocaleString(i18n.language || 'en', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        value: Math.min(100, Math.max(0, h.sohPercent)),
      }));
  }, [batteryHistory, i18n.language]);

  // Metric card color configs
  const sohCardColors = isLowData || isCalibrating
    ? { bg: 'bg-sky-500/8 border-sky-500/15 shadow-sky-500/10', icon: 'text-sky-400', value: 'text-sky-300' }
    : sohStatus === 'good'
      ? { bg: 'bg-emerald-500/8 border-emerald-500/15 shadow-emerald-500/10', icon: 'text-emerald-400', value: 'text-emerald-300' }
      : sohStatus === 'warning'
        ? { bg: 'bg-amber-500/8 border-amber-500/15 shadow-amber-500/10', icon: 'text-amber-400', value: 'text-amber-300' }
        : { bg: 'bg-rose-500/8 border-rose-500/15 shadow-rose-500/10', icon: 'text-rose-400', value: 'text-rose-300' };

  const degradationCardColors = isLowData
    ? { bg: 'bg-violet-500/8 border-violet-500/15 shadow-violet-500/10', icon: 'text-violet-400', value: 'text-violet-300' }
    : health && health.degradationPercent < 10
      ? { bg: 'bg-emerald-500/8 border-emerald-500/15 shadow-emerald-500/10', icon: 'text-emerald-400', value: 'text-emerald-300' }
      : health && health.degradationPercent < 20
        ? { bg: 'bg-amber-500/8 border-amber-500/15 shadow-amber-500/10', icon: 'text-amber-400', value: 'text-amber-300' }
        : { bg: 'bg-rose-500/8 border-rose-500/15 shadow-rose-500/10', icon: 'text-rose-400', value: 'text-rose-300' };

  return (
    <Page title={t('pages.battery.title')} subtitle={t('pages.battery.subtitle')}>
      {loading ? (
        <LoadingState className="py-24" />
      ) : error ? (
        <ErrorState message={error} />
      ) : !health ? (
        <EmptyState
          icon={<Battery size={28} className="text-blue-400" />}
          title={t('battery.noData')}
          description={t('battery.noDataHint')}
          className="py-24"
        />
      ) : (
        <>
          {/* Banners — priority: learning > low-data > ok-tier nudge > normal */}
          {isCalibrating ? (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 rounded-2xl flex items-start gap-3 mb-6 bg-sky-500/10 border border-sky-500/20"
            >
              <Loader size={20} className="text-sky-400 flex-shrink-0 mt-0.5 animate-spin" />
              <div>
                <p className="font-semibold text-sky-100">{t('battery.calibrating')}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {health.chargesNeededForHighBaseline != null && health.chargesNeededForHighBaseline > 0
                    ? t('battery.calibratingNeedCharges', { count: health.chargesNeededForHighBaseline })
                    : t('battery.calibratingHint')}
                  {health.estimatedCapacityKwh != null &&
                    ` · ${t('battery.estimatedCapacityDetected')}: ${health.estimatedCapacityKwh.toFixed(1)} kWh`}
                </p>
              </div>
            </motion.div>
          ) : isLowData ? (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 rounded-2xl flex items-start gap-3 mb-6 bg-amber-500/10 border border-amber-500/20"
            >
              <Info size={20} className="text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-amber-100">{t('battery.lowData')}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('battery.lowDataHint')}</p>
              </div>
            </motion.div>
          ) : (
            <>
              {/* 'ok' tier nudge — subtle, shown above the normal health banner */}
              {dataQuality === 'ok' && (health.chargesNeededForHighBaseline ?? 0) > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -12 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-3 rounded-xl flex items-center gap-2.5 mb-3 bg-violet-500/8 border border-violet-500/15"
                >
                  <Info size={15} className="text-violet-400 flex-shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    {t('battery.needMoreChargesForHigh', { count: health.chargesNeededForHighBaseline })}
                  </p>
                </motion.div>
              )}
              {/* Normal health status banner */}
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                className={`p-4 rounded-2xl flex items-start gap-3 mb-6 ${
                  sohStatus === 'good'
                    ? 'bg-emerald-500/10 border border-emerald-500/20'
                    : sohStatus === 'warning'
                      ? 'bg-amber-500/10 border border-amber-500/20'
                      : 'bg-rose-500/10 border border-rose-500/20'
                }`}
              >
                {sohStatus === 'good'
                  ? <CheckCircle size={20} className="text-emerald-400 flex-shrink-0 mt-0.5" />
                  : <AlertTriangle size={20} className={`flex-shrink-0 mt-0.5 ${sohStatus === 'warning' ? 'text-amber-400' : 'text-rose-400'}`} />}
                <div>
                  <p className={`font-semibold ${sohStatus === 'good' ? 'text-emerald-100' : sohStatus === 'warning' ? 'text-amber-100' : 'text-rose-100'}`}>
                    {sohStatus === 'good' ? t('battery.healthOptimal') : sohStatus === 'warning' ? t('battery.healthModerate') : t('battery.healthHigh')}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t('battery.currentSoh')}: {sohDisplayLabel} · {t('battery.estimatedCapacity')}: {health.estimatedCapacityKwh.toFixed(1)} kWh
                    {health.confidenceScore > 0 && ` · ${t('battery.confidence')}: ${(health.confidenceScore * 100).toFixed(0)}%`}
                    {dataQuality === 'high' && ` · ✓ ${t('battery.highAccuracy')}`}
                    {dataQuality === 'ok' && confidence !== 'NONE' && ` · ${t('battery.baseline')}: ${confidence}`}
                  </p>
                </div>
              </motion.div>
            </>
          )}

          {/* KPI Metric Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            {/* SOH */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className={`rounded-2xl border p-4 shadow-lg ${sohCardColors.bg}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Battery size={15} className={sohCardColors.icon} />
                <span className="text-xs text-muted-foreground">
                  {isCalibrating ? t('battery.estimatedSoh') : t('battery.stateOfHealth')}
                </span>
              </div>
              <div className="flex items-baseline gap-1 mt-2">
                <span className={`text-2xl font-bold ${sohCardColors.value}`}>
                  {isLowData ? '—' : sohDisplayLabel.replace('%', '')}
                </span>
                {!isLowData && <span className="text-sm text-muted-foreground">%</span>}
              </div>
            </motion.div>

            {/* Capacity */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="rounded-2xl border p-4 shadow-lg bg-sky-500/8 border-sky-500/15 shadow-sky-500/10"
            >
              <div className="flex items-center gap-2 mb-1">
                <Zap size={15} className="text-sky-400" />
                <span className="text-xs text-muted-foreground">{t('battery.estimatedCapacity')}</span>
              </div>
              <div className="flex items-baseline gap-1 mt-2">
                <span className="text-2xl font-bold text-sky-300">
                  {isLowData ? '—' : capacityDisplayLabel}
                </span>
                {!isLowData && <span className="text-sm text-muted-foreground">kWh</span>}
              </div>
            </motion.div>

            {/* Degradation */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className={`rounded-2xl border p-4 shadow-lg ${degradationCardColors.bg}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <TrendingDown size={15} className={degradationCardColors.icon} />
                <span className="text-xs text-muted-foreground">{t('battery.degradation')}</span>
              </div>
              <div className="flex items-baseline gap-1 mt-2">
                <span
                  className={`font-bold ${degradationCardColors.value} ${
                    isLowData || isDegradationPending ? 'text-sm leading-tight' : 'text-2xl'
                  }`}
                >
                  {isLowData
                    ? t('battery.insufficient')
                    : isDegradationPending
                      ? t('battery.pendingBaseline')
                      : degradationDisplayLabel.replace('%', '')}
                </span>
                {!isLowData && !isDegradationPending && <span className="text-sm text-muted-foreground">%</span>}
              </div>
            </motion.div>

            {/* Temperature */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="rounded-2xl border p-4 shadow-lg bg-orange-500/8 border-orange-500/15 shadow-orange-500/10"
            >
              <div className="flex items-center gap-2 mb-1">
                <Thermometer size={15} className="text-orange-400" />
                <span className="text-xs text-muted-foreground">{t('battery.avgBatteryTemp')}</span>
              </div>
              <div className="flex items-baseline gap-1 mt-2">
                <span className="text-2xl font-bold text-orange-300">
                  {health.avgBatteryTempC != null ? health.avgBatteryTempC.toFixed(1) : '—'}
                </span>
                {health.avgBatteryTempC != null && <span className="text-sm text-muted-foreground">°C</span>}
              </div>
            </motion.div>
          </div>

          {/* SOH / history — ECharts */}
          {(degradationChartData.length > 0 || batteryHistoryPoints.length > 0) && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-6"
            >
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {batteryHistoryPoints.length > 0 && (
                  <BatteryHistoryChart
                    data={batteryHistoryPoints}
                    title={t('battery.batteryHistoryChartTitle')}
                    height={240}
                  />
                )}
                {degradationChartData.length > 0 && (
                  <DegradationChart
                    data={degradationChartData}
                    projection={projectionData}
                    title={t('battery.sohHistoryTitle')}
                    subtitle={
                      trend?.hasTrend && trend.degradationPerMonth != null
                        ? `${t('battery.monthlyDegradation')}: ${trend.degradationPerMonth.toFixed(3)}%/mo · ${trend.samples} ${t('battery.measurements')}`
                        : trend?.samples
                          ? `${trend.samples} ${t('battery.measurements')}`
                          : undefined
                    }
                    height={240}
                  />
                )}
              </div>
            </motion.div>
          )}

          {/* Method breakdown + Projections */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] shadow-xl overflow-hidden"
            >
              <div className="p-5">
                <div className="flex items-center gap-2 mb-4">
                  <BarChart2 size={16} className="text-violet-400" />
                  <h3 className="text-base font-semibold text-foreground">{t('battery.sohByMethod')}</h3>
                </div>
                {(() => {
                  const methods = [
                    {
                      label:    t('battery.tripBased'),
                      subtitle: t('battery.tripBasedHint', { defaultValue: 'По динамике напряжения в поездках' }),
                      value:    health.tripSoh,
                      color:    'bg-sky-500',
                    },
                    {
                      label:    t('battery.chargingBased'),
                      subtitle: t('battery.chargingBasedHint', { defaultValue: 'Точнее при зарядке до 90%+' }),
                      value:    health.chargingSoh,
                      color:    'bg-emerald-500',
                    },
                    {
                      label:    t('battery.weightedResult'),
                      subtitle: t('battery.weightedResultHint', { defaultValue: 'Взвешенное среднее обоих методов' }),
                      value:    health.sohPercent > 100 ? 100 : health.sohPercent,
                      color:    'bg-violet-500',
                    },
                  ]
                  const allSame = methods.every(m => m.value != null && Math.abs((m.value ?? 0) - (methods[2].value ?? 0)) < 0.1)
                  if (allSame && methods[2].value != null) {
                    return (
                      <div className="flex flex-col items-center justify-center py-4 gap-2">
                        <div className="w-full h-2 rounded-full bg-[hsl(var(--border)/0.5)]">
                          <div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.min(100, methods[2].value)}%` }} />
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {t('battery.methodsConverge', { value: `${methods[2].value.toFixed(1)}%` })}
                        </p>
                      </div>
                    )
                  }
                  return (
                    <div className="space-y-4 divide-y divide-[hsl(var(--border)/0.35)]">
                      {methods.map((item, idx) => (
                        <div key={item.label} className={idx > 0 ? 'pt-3' : ''}>
                          <div className="flex justify-between mb-0.5">
                            <span className="text-[11px] font-medium text-foreground/80">{item.label}</span>
                            <span className="text-foreground font-semibold text-sm tabular-nums">
                              {item.value != null ? `${item.value.toFixed(1)}%` : t('common.notAvailable')}
                            </span>
                          </div>
                          <p className="text-[10px] text-muted-foreground mb-1.5">{item.subtitle}</p>
                          <div className="h-1.5 rounded-full bg-[hsl(var(--border)/0.5)]">
                            <div className={`h-full rounded-full ${item.color}`} style={{ width: `${Math.min(100, item.value ?? 0)}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] shadow-xl overflow-hidden"
            >
              <div className="p-5">
                <div className="flex items-center gap-2 mb-4">
                  <TrendingDown size={16} className="text-amber-400" />
                  <h3 className="text-base font-semibold text-foreground">{t('battery.degradationForecast')}</h3>
                </div>
                {!trend?.hasTrend ? (
                  <div className="flex flex-col gap-2 py-2">
                    <div className="flex items-center justify-between py-2.5">
                      <span className="text-[11px] text-muted-foreground">{t('battery.currentSoh')}</span>
                      <span className="font-semibold text-sm text-emerald-400">{Math.min(100, health.sohPercent).toFixed(1)}%</span>
                    </div>
                    <p className="text-xs text-muted-foreground italic py-2">{t('battery.noDegradationFound')}</p>
                  </div>
                ) : (
                  <div className="divide-y divide-[hsl(var(--border)/0.35)]">
                    {[
                      { label: t('battery.currentSoh'),
                        value: `${Math.min(100, health.sohPercent).toFixed(1)}%`,
                        color: 'text-emerald-400' },
                      { label: t('battery.in1Year'),
                        value: isUnreliable || trend.projectedSoh1Year == null ? '—' : `${trend.projectedSoh1Year.toFixed(1)}%`,
                        color: isUnreliable ? 'text-muted-foreground/40' : 'text-sky-400' },
                      { label: t('battery.in5Years'),
                        value: isUnreliable || trend.projectedSoh5Year == null ? '—' : `${trend.projectedSoh5Year.toFixed(1)}%`,
                        color: isUnreliable ? 'text-muted-foreground/40' : 'text-amber-400' },
                      { label: t('battery.monthlyDegradation'),
                        value: trend.degradationPerMonth != null
                          ? `${trend.degradationPerMonth.toFixed(3)}%/mo` : '—',
                        color: 'text-muted-foreground' },
                    ].map((item) => {
                      const isAnomalousRate =
                        item.label === t('battery.monthlyDegradation') &&
                        trend.degradationPerMonth != null &&
                        trend.degradationPerMonth > 0.5 &&
                        (trend.samples ?? 0) < 500;
                      return (
                        <div key={item.label} className="flex items-center justify-between py-2.5">
                          <span className="text-[11px] text-muted-foreground">{item.label}</span>
                          <div className="flex items-center gap-1.5">
                            {isAnomalousRate && (
                              <AlertTriangle size={12} className="text-amber-400 shrink-0" />
                            )}
                            <span className={`font-semibold text-sm tabular-nums ${isAnomalousRate ? 'text-amber-400' : item.color}`}>
                              {item.value}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                    {isUnreliable && (
                      <div className="flex items-center gap-1.5 pt-2 pb-0.5">
                        <AlertTriangle size={11} className="text-amber-400/70 shrink-0" />
                        <span className="text-[10px] text-amber-400/70">Недостаточно данных — прогноз неточный</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          </div>

          {/* Pack diagnostics — gated to PRO/FLEET.
              Only render when at least one live signal is available;
              showing three dashes with a premium lock looks like a bug to users. */}
          {(liveVoltage != null || liveSoc != null) && (
            <PremiumGate feature="pack-diagnostics" fallback={<PackDiagnosticsTeaser />}>
              <PackDiagnosticsSection
                packVoltageV={liveVoltage}
                soc={liveSoc}
              />
            </PremiumGate>
          )}

          {/* Smart recommendations based on live health data */}
          <BatteryRecommendations health={health} />
        </>
      )}
    </Page>
  );
}
