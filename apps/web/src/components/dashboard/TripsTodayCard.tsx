'use client';

import React from 'react';
import { TripIcon } from '@/components/icons/NavIcons';
import { useTranslation } from 'react-i18next';
import { useTripsToday } from '@/hooks/useVehicleAggregates';
import { BaseCard } from '@/shared/ui';

interface Props {
  vehicleId: string | null;
}

export function TripsTodayCard({ vehicleId }: Props) {
  const { tripsToday, isLoading } = useTripsToday(vehicleId);
  const { t } = useTranslation();

  return (
    <BaseCard>
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('cards.tripsToday.title')}
          </p>
          <h3 className="text-2xl font-bold text-emerald-400 tracking-tight tabular-nums">
            {isLoading || !tripsToday ? '— km' : `${tripsToday.distanceKm.toFixed(1)} km`}
          </h3>
          <p className="text-[10px] text-muted-foreground/50 mt-0.5">{t('cards.tripsToday.period', { defaultValue: 'сегодня' })}</p>
        </div>
        <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center text-emerald-400 shrink-0">
          <TripIcon size={20} />
        </div>
      </div>

      <div className="stat-grid grid grid-cols-3 gap-3 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.tripsToday.trips')}</p>
          <p className="text-sm font-semibold text-foreground">
            {tripsToday?.tripCount ?? (isLoading ? '…' : 0)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.tripsToday.energy')}</p>
          <p className="text-sm font-semibold text-foreground">
            {tripsToday ? `${tripsToday.energyKwh.toFixed(1)} kWh` : isLoading ? '…' : '0 kWh'}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.tripsToday.efficiency')}</p>
          <p className="text-sm font-semibold text-foreground">
            {tripsToday?.efficiencyWhKm != null ? `${Math.round(tripsToday.efficiencyWhKm)} Wh/km` : '—'}
          </p>
        </div>
      </div>
    </BaseCard>
  );
}
