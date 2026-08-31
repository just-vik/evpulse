'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Page } from '@/components/layout';
import { useAuthStore } from '@/stores/authStore';
import { useLayoutStore } from '@/stores/layout.store';
import { apiClient } from '@/lib/api';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Car, RefreshCw, ArrowUpDown, ChevronLeft, ChevronRight, Zap, BarChart3, AlertCircle, Clock, CheckCircle2, TrendingUp } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useCurrency } from '@/hooks/useCurrency';

type SessionRow = {
  id: string;
  startTime: string;
  endTime?: string | null;
  chargerType?: string | null;
  costSource?: string | null;
  costTotal?: number | null;
  energyAddedKwh?: number | null;
  billingSyncAttempts?: number | null;
  billingNextSyncAt?: string | null;
};

type QuickFilter = 'all' | 'tesla_api' | 'scope_missing' | 'pending';

type SortKey =
  | 'startTime'
  | 'costSource'
  | 'costTotal'
  | 'energyAddedKwh'
  | 'billingSyncAttempts'
  | 'retryEtaMin';

export default function CostTelemetryPage() {
  const { t, i18n } = useTranslation();
  const { formatMoney: fmtMoney } = useCurrency();
  const selectedVehicleId = useLayoutStore((s) => s.selectedVehicleId);
  const { accessToken } = useAuthStore();
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('startTime');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const telemetryQuery = useQuery({
    queryKey: ['cost-telemetry-page', selectedVehicleId],
    queryFn: () => apiClient.getCostTelemetry(selectedVehicleId!, accessToken!),
    enabled: !!selectedVehicleId && !!accessToken,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const sessionsQuery = useQuery({
    queryKey: ['cost-telemetry-sessions', selectedVehicleId],
    queryFn: async () => {
      const res = await apiClient.getChargingSessions(selectedVehicleId!, 200, accessToken!);
      // Unwrap { data, meta } envelope
      return ((res as any).data ?? res) as SessionRow[];
    },
    enabled: !!selectedVehicleId && !!accessToken,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const filtered = useMemo(() => {
    const all = sessionsQuery.data ?? [];
    const now = Date.now();
    switch (quickFilter) {
      case 'tesla_api':
        return all.filter((r) => r.costSource === 'tesla_api');
      case 'scope_missing':
        return all.filter((r) => r.costSource === 'scope_missing');
      case 'pending':
        return all.filter((r) => isPendingRetry(r, now));
      default:
        return all;
    }
  }, [sessionsQuery.data, quickFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (va === vb) return 0;
      const cmp = va < vb ? -1 : 1;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const currentPage = Math.min(page, totalPages);

  const pageSlice = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, currentPage, pageSize]);

  const toggleSort = (key: SortKey) => {
    setPage(1);
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'startTime' ? 'desc' : 'asc');
    }
  };

  if (!selectedVehicleId) {
    return (
      <Page key={i18n.language} title={t('pages.costTelemetry.title')}>
        <EmptyState
          icon={<Car size={26} />}
          title={t('pages.costTelemetry.selectVehicle')}
          className="py-16"
        />
      </Page>
    );
  }

  const td = telemetryQuery.data;
  const isLoading = telemetryQuery.isLoading || sessionsQuery.isLoading;

  const metrics = [
    {
      label: t('pages.costTelemetry.metricTeslaCoverage'),
      value: td ? `${td.teslaCoveragePct.toFixed(1)}%` : '—',
      icon: <CheckCircle2 size={18} />,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/8 border-emerald-500/15',
      glow: 'shadow-emerald-500/10',
    },
    {
      label: t('pages.costTelemetry.metricPendingRetries'),
      value: td?.pendingRetrySessions ?? '—',
      icon: <Clock size={18} />,
      color: 'text-amber-400',
      bg: 'bg-amber-500/8 border-amber-500/15',
      glow: 'shadow-amber-500/10',
    },
    {
      label: t('pages.costTelemetry.metricScopeMissing'),
      value: td?.scopeMissingSessions ?? '—',
      icon: <AlertCircle size={18} />,
      color: 'text-rose-400',
      bg: 'bg-rose-500/8 border-rose-500/15',
      glow: 'shadow-rose-500/10',
    },
    {
      label: t('pages.costTelemetry.metricMaxRetries'),
      value: td?.maxRetryAttempts ?? '—',
      icon: <TrendingUp size={18} />,
      color: 'text-sky-400',
      bg: 'bg-sky-500/8 border-sky-500/15',
      glow: 'shadow-sky-500/10',
    },
  ];

  const filterOptions: { key: QuickFilter; label: string }[] = [
    { key: 'all',           label: t('pages.costTelemetry.filterAll') },
    { key: 'tesla_api',     label: t('pages.costTelemetry.filterTeslaApi') },
    { key: 'scope_missing', label: t('pages.costTelemetry.filterScopeMissing') },
    { key: 'pending',       label: t('pages.costTelemetry.filterPending') },
  ];

  return (
    <Page key={i18n.language} title={t('pages.costTelemetry.title')}>
      <div className="space-y-5 pb-12">

        {/* ── Coverage metrics ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {metrics.map((m) => (
            <div
              key={m.label}
              className={clsx(
                'relative rounded-2xl border p-4 shadow-lg transition-all',
                m.bg, m.glow,
              )}
            >
              <div className={clsx('mb-2 flex items-center gap-1.5', m.color)}>
                {m.icon}
                <span className="text-[11px] font-semibold uppercase tracking-wider opacity-80">
                  {m.label}
                </span>
              </div>
              <p className={clsx('text-2xl font-bold tabular-nums', m.color)}>
                {isLoading ? (
                  <span className="inline-block w-12 h-6 rounded skeleton" />
                ) : (
                  m.value
                )}
              </p>
            </div>
          ))}
        </div>

        {/* ── Sessions table ── */}
        <div className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] shadow-xl overflow-hidden">

          {/* Table header / controls */}
          <div className="flex flex-col gap-3 px-5 pt-5 pb-4 border-b border-[hsl(var(--border)/0.45)] sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 size={16} className="text-brand-500" />
                <p className="text-base font-semibold text-foreground">
                  {t('pages.costTelemetry.sectionSessions')}
                </p>
                {sessionsQuery.isFetching && (
                  <RefreshCw size={13} className="text-muted-foreground animate-spin ml-1" />
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {sorted.length} {t('pages.costTelemetry.filterAll').toLowerCase()}
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {filterOptions.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => { setQuickFilter(f.key); setPage(1); }}
                  className={clsx(
                    'rounded-full border px-3 py-1 text-xs font-medium transition-all',
                    quickFilter === f.key
                      ? 'border-brand-500 bg-brand-500/15 text-brand-400 shadow-sm shadow-brand-500/20'
                      : 'border-[hsl(var(--border)/0.6)] bg-[hsl(var(--secondary)/0.3)] text-muted-foreground hover:text-foreground hover:border-[hsl(var(--border)/0.9)]',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[hsl(var(--secondary)/0.3)] text-left">
                  <SortableTh label={t('pages.costTelemetry.colStart')} sortKey="startTime" current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <th className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('pages.costTelemetry.colSource')}</th>
                  <SortableTh label={t('pages.costTelemetry.colCost')} sortKey="costTotal" current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label={t('pages.costTelemetry.colEnergy')} sortKey="energyAddedKwh" current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label={t('pages.costTelemetry.colAttempts')} sortKey="billingSyncAttempts" current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label={t('pages.costTelemetry.colRetryEta')} sortKey="retryEtaMin" current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <th className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('pages.costTelemetry.colNextRetry')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[hsl(var(--border)/0.35)]">
                {sessionsQuery.isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 7 }).map((_, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="skeleton h-4 rounded w-16" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : pageSlice.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      <div className="flex flex-col items-center gap-2">
                        <Zap size={22} className="opacity-30" />
                        <span className="text-sm">{t('pages.costTelemetry.emptySessions')}</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  pageSlice.map((row) => (
                    <tr
                      key={row.id}
                      className="hover:bg-[hsl(var(--secondary)/0.2)] transition-colors group"
                    >
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-foreground tabular-nums">
                        {fmtDate(row.startTime, i18n.language)}
                      </td>
                      <td className="px-4 py-3">
                        <CostSourceBadge source={row.costSource} />
                      </td>
                      <td className="px-4 py-3 font-semibold tabular-nums text-emerald-400">
                        {row.costTotal != null ? fmtMoney(Number(row.costTotal)) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-sky-400">
                        {row.energyAddedKwh != null ? (
                          <span className="flex items-center gap-1">
                            <Zap size={11} className="opacity-70" />
                            {Number(row.energyAddedKwh).toFixed(2)} kWh
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={clsx(
                          'inline-flex items-center justify-center min-w-[1.75rem] h-6 rounded-md text-xs font-bold tabular-nums',
                          (row.billingSyncAttempts ?? 0) > 3
                            ? 'bg-rose-500/15 text-rose-300 border border-rose-500/25'
                            : (row.billingSyncAttempts ?? 0) > 0
                              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/25'
                              : 'text-muted-foreground',
                        )}>
                          {row.billingSyncAttempts ?? 0}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground text-xs">
                        {formatRetryEtaMin(row.billingNextSyncAt)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                        {row.billingNextSyncAt ? fmtDate(row.billingNextSyncAt, i18n.language) : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination footer */}
          {sorted.length > 0 && (
            <div className="flex flex-col gap-3 px-5 py-4 border-t border-[hsl(var(--border)/0.4)] sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{t('pages.costTelemetry.perPage')}</span>
                {[10, 25, 50].map((n) => (
                  <button
                    key={n}
                    onClick={() => { setPageSize(n); setPage(1); }}
                    className={clsx(
                      'w-8 h-7 rounded-lg text-xs font-medium transition-all border',
                      pageSize === n
                        ? 'bg-brand-500/15 border-brand-500/25 text-brand-400'
                        : 'border-[hsl(var(--border)/0.5)] text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {n}
                  </button>
                ))}
                <span className="ml-2">
                  {t('pages.costTelemetry.showing', {
                    from: (currentPage - 1) * pageSize + 1,
                    to: Math.min(currentPage * pageSize, sorted.length),
                    total: sorted.length,
                  })}
                </span>
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[hsl(var(--border)/0.6)] text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                >
                  <ChevronLeft size={13} />
                  {t('pages.costTelemetry.prev')}
                </button>

                {/* Page number pills */}
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  const pg = totalPages <= 5 ? i + 1
                    : currentPage <= 3 ? i + 1
                    : currentPage >= totalPages - 2 ? totalPages - 4 + i
                    : currentPage - 2 + i;
                  return (
                    <button
                      key={pg}
                      onClick={() => setPage(pg)}
                      className={clsx(
                        'w-8 h-7 rounded-lg text-xs font-medium transition-all border',
                        pg === currentPage
                          ? 'bg-brand-500/20 border-brand-500/30 text-brand-400'
                          : 'border-[hsl(var(--border)/0.5)] text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {pg}
                    </button>
                  );
                })}

                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[hsl(var(--border)/0.6)] text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                >
                  {t('pages.costTelemetry.next')}
                  <ChevronRight size={13} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer link */}
        <div className="flex justify-end">
          <Link
            href="/charging"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-brand-400 transition group"
          >
            {t('pages.costTelemetry.chargingLink')}
            <ChevronRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>

      </div>
    </Page>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isPendingRetry(r: SessionRow, now: number): boolean {
  const src = r.costSource ?? '';
  if (src === 'tesla_api' || src === 'scope_missing' || src === 'manual') return false;
  const attempts = r.billingSyncAttempts ?? 0;
  const next = r.billingNextSyncAt ? new Date(r.billingNextSyncAt).getTime() : 0;
  return attempts > 0 || next > now;
}

function retryEtaMinutesMs(nextIso: string | null | undefined, now: number): number | null {
  if (!nextIso) return null;
  const delta = new Date(nextIso).getTime() - now;
  if (delta <= 0) return null;
  return delta / 60_000;
}

function formatRetryEtaMin(nextIso: string | null | undefined): string {
  const min = retryEtaMinutesMs(nextIso, Date.now());
  if (min == null) return '—';
  return `${Math.ceil(min)} min`;
}

function sortValue(row: SessionRow, key: SortKey): string | number {
  const now = Date.now();
  switch (key) {
    case 'startTime':          return new Date(row.startTime).getTime();
    case 'costSource':         return row.costSource ?? '';
    case 'costTotal':          return row.costTotal ?? -Infinity;
    case 'energyAddedKwh':     return row.energyAddedKwh ?? -Infinity;
    case 'billingSyncAttempts':return row.billingSyncAttempts ?? 0;
    case 'retryEtaMin': {
      const m = retryEtaMinutesMs(row.billingNextSyncAt, now);
      return m == null ? -1 : m;
    }
    default: return 0;
  }
}

function CostSourceBadge({ source }: { source: string | null | undefined }) {
  const s = source ?? '—';
  return (
    <span className={clsx(
      'inline-flex items-center rounded-lg border px-2 py-0.5 text-[11px] font-semibold tracking-wide',
      costSourceBadgeClass(source),
    )}>
      {s}
    </span>
  );
}

function costSourceBadgeClass(source: string | null | undefined): string {
  switch (source) {
    case 'tesla_api':    return 'border-emerald-500/35 bg-emerald-500/12 text-emerald-300';
    case 'scope_missing':return 'border-amber-500/35 bg-amber-500/12 text-amber-200';
    case 'manual':       return 'border-violet-500/35 bg-violet-500/12 text-violet-200';
    case 'tariff':
    case 'supercharger':
    case 'tesla_sc':     return 'border-sky-500/35 bg-sky-500/12 text-sky-200';
    default:
      if (!source) return 'border-[hsl(var(--border)/0.5)] bg-[hsl(var(--secondary)/0.35)] text-muted-foreground';
      return 'border-[hsl(var(--border)/0.5)] bg-[hsl(var(--secondary)/0.35)] text-foreground';
  }
}

function SortableTh({
  label,
  sortKey,
  current,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
}) {
  const active = current === sortKey;
  return (
    <th className="px-4 py-3">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={clsx(
          'inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {label}
        <ArrowUpDown size={11} className={clsx('transition-opacity', active ? 'opacity-100' : 'opacity-30')} />
        {active && <span className="text-[10px] text-brand-400">{dir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </th>
  );
}

function fmtDate(v: string, locale?: string) {
  return new Date(v).toLocaleString(locale?.replace('_', '-') || undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
