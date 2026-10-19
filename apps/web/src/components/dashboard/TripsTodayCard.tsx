'use client';

import React from 'react';
import { DistanceIcon } from '@/components/icons/StatusIcons';
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
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('cards.tripsToday.title')}
          </p>
          {isLoading ? (
            <div className="h-8 w-24 rounded-lg bg-[hsl(var(--muted)/0.5)] animate-pulse" />
          ) : (
            <h3 className="text-2xl font-bold text-[#43D1AD] tracking-tight tabular-nums">
              {tripsToday ? `${tripsToday.distanceKm.toFixed(1)} km` : '— km'}
            </h3>
          )}
          <p className="text-[10px] text-muted-foreground/50 mt-0.5">{t('cards.tripsToday.period', { defaultValue: 'сегодня' })}</p>
        </div>
        <div className="w-11 h-11 rounded-[12px] bg-[#2DD4BF]/10 flex items-center justify-center text-[#2DD4BF] shrink-0">
          <DistanceIcon size={22} />
        </div>
      </div>

      <div className="stat-grid grid grid-cols-3 gap-3 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.tripsToday.trips')}</p>
          {isLoading ? (
            <div className="h-4 w-8 rounded bg-[hsl(var(--muted)/0.4)] animate-pulse" />
          ) : (
            <p className="text-sm font-semibold text-foreground">{tripsToday?.tripCount ?? 0}</p>
          )}
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.tripsToday.energy')}</p>
          {isLoading ? (
            <div className="h-4 w-14 rounded bg-[hsl(var(--muted)/0.4)] animate-pulse" />
          ) : (
            <p className="text-sm font-semibold text-foreground">
              {tripsToday ? `${tripsToday.energyKwh.toFixed(1)} kWh` : '0 kWh'}
            </p>
          )}
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.tripsToday.efficiency')}</p>
          <p className="text-sm font-semibold text-foreground">
            {isLoading ? '…' : tripsToday?.efficiencyWhKm != null ? `${Math.round(tripsToday.efficiencyWhKm)} Wh/km` : '—'}
          </p>
        </div>
      </div>
    </BaseCard>
  );
}
