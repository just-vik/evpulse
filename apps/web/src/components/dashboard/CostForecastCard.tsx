'use client';

import React from 'react';
import { CalendarRange, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { useCostForecast } from '@/hooks/useCostForecast';
import { useCurrency } from '@/hooks/useCurrency';
import { BaseCard } from '@/shared/ui';

interface Props {
  vehicleId: string | null;
}

export function CostForecastCard({ vehicleId }: Props) {
  const { forecast, isLoading } = useCostForecast(vehicleId);
  const { t } = useTranslation();
  const { formatMoney, formatRate } = useCurrency();

  const effectiveRate = forecast?.effectiveRate;
  // 'default' means no user tariff configured — show CTA to settings
  const isDefaultRate = forecast?.rateSource === 'default';

  return (
    <BaseCard>
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('cards.costForecast.title')}
          </p>
          <h3 className="text-2xl font-bold text-sky-400 tracking-tight tabular-nums">
            {forecast
              ? `${formatMoney(forecast.monthlyCost)}/mo`
              : isLoading ? '…' : '—'}
          </h3>
        </div>
        <div className="w-9 h-9 rounded-xl bg-sky-500/20 flex items-center justify-center text-sky-300 shrink-0">
          <CalendarRange className="w-5 h-5" />
        </div>
      </div>

      <div className="stat-grid grid grid-cols-3 gap-3 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.costForecast.weekly')}</p>
          <p className="text-sm font-semibold text-foreground">
            {forecast ? formatMoney(forecast.weeklyCost) : isLoading ? '…' : '—'}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.costForecast.avgDay')}</p>
          <p className="text-sm font-semibold text-foreground">
            {forecast ? `${forecast.avgEnergyPerDay.toFixed(1)} kWh` : isLoading ? '…' : '—'}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.costForecast.tariff')}</p>
          <p className="text-sm font-semibold text-foreground">
            {effectiveRate != null ? formatRate(effectiveRate) : isLoading ? '…' : '—'}
          </p>
        </div>
      </div>

      {/* Tariff CTA — shown when cost is estimated from fallback rate, not user settings */}
      {!isLoading && isDefaultRate && (
        <Link
          href="/settings"
          className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-400 hover:text-amber-300 transition-colors"
        >
          <Settings size={11} />
          {t('cards.costForecast.addTariffCta')}
        </Link>
      )}
    </BaseCard>
  );
}
