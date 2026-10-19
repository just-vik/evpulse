'use client';

import React from 'react';
import { PlugIcon } from '@/components/icons/StatusIcons';
import { useTranslation } from 'react-i18next';
import { useChargingSummary } from '@/hooks/useVehicleAggregates';
import { BaseCard } from '@/shared/ui';

interface Props {
  vehicleId: string | null;
}

export function ChargingSummaryCard({ vehicleId }: Props) {
  const { chargingSummary, isLoading } = useChargingSummary(vehicleId);
  const { t } = useTranslation();

  return (
    <BaseCard>
      <div className="flex items-start justify-between mb-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('cards.charging30d.title')}
          </p>
          {isLoading ? (
            <div className="h-8 w-28 rounded-lg bg-[hsl(var(--muted)/0.5)] animate-pulse" />
          ) : (
            <h3 className="text-2xl font-bold text-[#34B49C] tracking-tight tabular-nums">
              {chargingSummary ? `${chargingSummary.energyKwh.toFixed(1)} kWh` : '0.0 kWh'}
            </h3>
          )}
          <p className="text-[10px] text-muted-foreground/50 mt-0.5">{t('cards.charging30d.period', { defaultValue: 'за 30 дней' })}</p>
        </div>
        <div className="w-11 h-11 rounded-[12px] bg-[#8CBC38]/10 flex items-center justify-center text-[#8CBC38] shrink-0">
          <PlugIcon size={22} />
        </div>
      </div>

      <div className="stat-grid grid grid-cols-2 gap-3 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.charging30d.sessions')}</p>
          {isLoading ? (
            <div className="h-4 w-8 rounded bg-[hsl(var(--muted)/0.4)] animate-pulse" />
          ) : (
            <p className="text-sm font-semibold text-foreground">{chargingSummary?.sessions ?? 0}</p>
          )}
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.charging30d.avgSession')}</p>
          {isLoading ? (
            <div className="h-4 w-14 rounded bg-[hsl(var(--muted)/0.4)] animate-pulse" />
          ) : (
            <p className="text-sm font-semibold text-foreground">
              {chargingSummary?.avgSessionKwh != null ? `${chargingSummary.avgSessionKwh.toFixed(1)} kWh` : '—'}
            </p>
          )}
        </div>
      </div>
    </BaseCard>
  );
}
