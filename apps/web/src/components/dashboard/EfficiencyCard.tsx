'use client';

import React, { useState } from 'react';
import { LeafMetricIcon } from '@/components/icons/StatusIcons';
import { useTranslation } from 'react-i18next';
import { useEfficiencyPrediction } from '@/hooks/useEfficiencyPrediction';
import { BaseCard } from '@/shared/ui';

interface Props {
  vehicleId: string | null;
}

export function EfficiencyCard({ vehicleId }: Props) {
  const { prediction, isLoading } = useEfficiencyPrediction(vehicleId);
  const { t } = useTranslation();
  const [unit, setUnit] = useState<'whkm' | 'kwh100'>('whkm');

  const whKm = prediction?.predictedWhKm;
  const range = prediction?.predictedRangeKm;

  const displayValue = whKm == null
    ? null
    : unit === 'whkm'
      ? `${Math.round(whKm)} Wh/km`
      : `${(whKm / 10).toFixed(1)} kWh/100km`;

  return (
    <BaseCard>
      <div className="flex items-start justify-between mb-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('cards.efficiency.title')}
          </p>
          {isLoading ? (
            <div className="h-8 w-28 rounded-lg bg-[hsl(var(--muted)/0.5)] animate-pulse" />
          ) : (
            <h3 className="text-2xl font-bold text-[#34B49C] tracking-tight tabular-nums">
              {displayValue ?? '—'}
            </h3>
          )}
        </div>
        <div className="flex items-start gap-2">
          {/* Unit toggle */}
          {whKm != null && (
            <button
              onClick={() => setUnit(u => u === 'whkm' ? 'kwh100' : 'whkm')}
              className="text-[10px] px-2 py-0.5 rounded-md bg-[#34B49C]/15 text-[#34B49C] hover:bg-[#34B49C]/25 transition-colors font-medium tabular-nums leading-5"
              title={unit === 'whkm' ? 'Switch to kWh/100km' : 'Switch to Wh/km'}
            >
              {unit === 'whkm' ? 'kWh/100' : 'Wh/km'}
            </button>
          )}
          <div className="w-11 h-11 rounded-[12px] bg-[#3CBA72]/10 flex items-center justify-center text-[#3CBA72] shrink-0">
            <LeafMetricIcon size={22} />
          </div>
        </div>
      </div>

      <div className="stat-grid grid grid-cols-2 gap-3 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.efficiency.estRange')}</p>
          <p className="text-sm font-semibold text-foreground">
            {range ? `${Math.round(range)} km` : isLoading ? '…' : '—'}
          </p>
        </div>
        {prediction?.assumptions && (
          <div>
            <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.efficiency.assumptions')}</p>
            <p className="text-sm font-semibold text-foreground">
              {Math.round(prediction.assumptions.avgSpeed)} km/h · {Math.round(prediction.assumptions.outsideTemp)}°C
            </p>
          </div>
        )}
      </div>
    </BaseCard>
  );
}
