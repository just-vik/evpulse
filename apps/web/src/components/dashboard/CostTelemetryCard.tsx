'use client';

import React from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { BaseCard } from '@/shared/ui';
import { apiClient } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';

interface Props {
  vehicleId: string | null;
}

export function CostTelemetryCard({ vehicleId }: Props) {
  const { t } = useTranslation();
  const { accessToken } = useAuthStore();
  const { data, isLoading } = useQuery({
    queryKey: ['cost-telemetry', vehicleId],
    queryFn: () => apiClient.getCostTelemetry(vehicleId!, accessToken!),
    enabled: !!vehicleId && !!accessToken,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  });

  return (
    <BaseCard className="h-full">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('pages.costTelemetry.card.title')}
          </p>
          <h3 className="text-2xl font-bold text-sky-400 tracking-tight tabular-nums">
            {data ? `${data.teslaCoveragePct.toFixed(0)}%` : isLoading ? '…' : '—'}
          </h3>
          <p className="text-[11px] text-muted-foreground mt-1">
            {t('pages.costTelemetry.card.coverageHint')}
          </p>
        </div>
        <div className="w-9 h-9 rounded-xl bg-sky-500/20 flex items-center justify-center text-sky-300 shrink-0">
          <Activity className="w-5 h-5" />
        </div>
      </div>

      <div className="stat-grid grid grid-cols-2 gap-3 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('pages.costTelemetry.card.pendingRetries')}</p>
          <p className="text-sm font-semibold text-foreground">
            {data ? data.pendingRetrySessions : isLoading ? '…' : '—'}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('pages.costTelemetry.card.scopeMissing')}</p>
          <p className="text-sm font-semibold text-foreground">
            {data ? data.scopeMissingSessions : isLoading ? '…' : '—'}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('pages.costTelemetry.card.fallbackSessions')}</p>
          <p className="text-sm font-semibold text-foreground">
            {data ? data.fallbackSessions : isLoading ? '…' : '—'}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5 flex items-center gap-1">
            <RefreshCw className="w-3 h-3" />
            {t('pages.costTelemetry.card.maxRetries')}
          </p>
          <p className="text-sm font-semibold text-foreground">
            {data ? data.maxRetryAttempts : isLoading ? '…' : '—'}
          </p>
        </div>
      </div>
      <div className="pt-3">
        <Link href="/cost-telemetry" className="text-xs text-brand-500 hover:underline">
          {t('pages.costTelemetry.card.openDetail')}
        </Link>
      </div>
    </BaseCard>
  );
}
