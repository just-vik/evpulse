'use client';

import React, { useState } from 'react';
import { LeafIcon } from '@/components/icons/NavIcons';
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
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('cards.efficiency.title')}
          </p>
          <h3 className="text-2xl font-bold text-violet-400 tracking-tight tabular-nums">
            {isLoading || !displayValue ? '—' : displayValue}
          </h3>
        </div>
        <div className="flex items-start gap-2">
          {/* Unit toggle */}
          {whKm != null && (
            <button
              onClick={() => setUnit(u => u === 'whkm' ? 'kwh100' : 'whkm')}
              className="text-[10px] px-2 py-0.5 rounded-md bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 transition-colors font-medium tabular-nums leading-5"
              title={unit === 'whkm' ? 'Switch to kWh/100km' : 'Switch to Wh/km'}
            >
              {unit === 'whkm' ? 'kWh/100' : 'Wh/km'}
            </button>
          )}
          <div className="w-9 h-9 rounded-xl bg-violet-500/20 flex items-center justify-center text-violet-300 shrink-0">
            <LeafIcon size={20} />
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
