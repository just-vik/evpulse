'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useCostSummary } from '@/hooks/useVehicleAggregates';
import { useCurrency } from '@/hooks/useCurrency';
import { CurrencyGlyph } from '@/components/currency/CurrencyGlyph';
import { BaseCard } from '@/shared/ui';

interface Props {
  vehicleId: string | null;
}

export function CostAnalyticsCard({ vehicleId }: Props) {
  // No rate override — let the API resolve from settings → default 0.25
  const { costSummary, isLoading } = useCostSummary(vehicleId);
  const { t } = useTranslation();
  const { formatMoney, formatPerKm } = useCurrency();

  return (
    <BaseCard className="h-full">
      <div className="flex items-start justify-between mb-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('cards.cost30d.title')}
          </p>
          {isLoading ? (
            <div className="h-8 w-24 rounded-lg bg-[hsl(var(--muted)/0.5)] animate-pulse" />
          ) : (
            <h3 className="text-2xl font-bold text-[#C2F54A] tracking-tight tabular-nums">
              {costSummary ? formatMoney(costSummary.totalCost) : '—'}
            </h3>
          )}
        </div>
        <div className="w-9 h-9 rounded-xl bg-[#C2F54A]/15 flex items-center justify-center text-[#C2F54A] shrink-0">
          <CurrencyGlyph size="badge" className="font-semibold" />
        </div>
      </div>

      <div className="stat-grid grid grid-cols-2 gap-3 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.cost30d.energy')}</p>
          {isLoading ? (
            <div className="h-4 w-16 rounded bg-[hsl(var(--muted)/0.4)] animate-pulse" />
          ) : (
            <p className="text-sm font-semibold text-foreground">
              {costSummary ? `${costSummary.energyKwh.toFixed(1)} kWh` : '—'}
            </p>
          )}
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.cost30d.costPerKm')}</p>
          {isLoading ? (
            <div className="h-4 w-14 rounded bg-[hsl(var(--muted)/0.4)] animate-pulse" />
          ) : (
            <p className="text-sm font-semibold text-foreground">
              {costSummary?.costPerKm != null ? formatPerKm(costSummary.costPerKm) : '—'}
            </p>
          )}
        </div>
      </div>
    </BaseCard>
  );
}
