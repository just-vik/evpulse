'use client';

import React from 'react';
import { ChargingIcon } from '@/components/icons/NavIcons';
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
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('cards.charging30d.title')}
          </p>
          <h3 className="text-2xl font-bold text-amber-400 tracking-tight tabular-nums">
            {chargingSummary
              ? `${chargingSummary.energyKwh.toFixed(1)} kWh`
              : isLoading ? '…' : '0.0 kWh'}
          </h3>
          <p className="text-[10px] text-muted-foreground/50 mt-0.5">{t('cards.charging30d.period', { defaultValue: 'за 30 дней' })}</p>
        </div>
        <div className="w-9 h-9 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-300 shrink-0">
          <ChargingIcon size={20} />
        </div>
      </div>

      <div className="stat-grid grid grid-cols-2 gap-3 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.charging30d.sessions')}</p>
          <p className="text-sm font-semibold text-foreground">
            {chargingSummary?.sessions ?? (isLoading ? '…' : 0)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.charging30d.avgSession')}</p>
          <p className="text-sm font-semibold text-foreground">
            {chargingSummary?.avgSessionKwh != null
              ? `${chargingSummary.avgSessionKwh.toFixed(1)} kWh`
              : '—'}
          </p>
        </div>
      </div>
    </BaseCard>
  );
}
