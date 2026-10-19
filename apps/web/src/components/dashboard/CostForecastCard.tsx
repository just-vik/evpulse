'use client';

import React from 'react';
import { Settings } from 'lucide-react';
import { CalendarMetricIcon } from '@/components/icons/StatusIcons';
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
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('cards.costForecast.title')}
          </p>
          {isLoading ? (
            <div className="h-8 w-24 rounded-lg bg-[hsl(var(--muted)/0.5)] animate-pulse" />
          ) : (
            <h3 className="text-2xl font-bold text-[#34B49C] tracking-tight tabular-nums">
              {forecast ? `${formatMoney(forecast.monthlyCost)}/mo` : '—'}
            </h3>
          )}
        </div>
        <div className="w-11 h-11 rounded-[12px] bg-[#26B89C]/10 flex items-center justify-center text-[#26B89C] shrink-0">
          <CalendarMetricIcon size={22} />
        </div>
      </div>

      <div className="stat-grid grid grid-cols-3 gap-3 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.costForecast.weekly')}</p>
          {isLoading ? (
            <div className="h-4 w-12 rounded bg-[hsl(var(--muted)/0.4)] animate-pulse" />
          ) : (
            <p className="text-sm font-semibold text-foreground">
              {forecast ? formatMoney(forecast.weeklyCost) : '—'}
            </p>
          )}
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.costForecast.avgDay')}</p>
          {isLoading ? (
            <div className="h-4 w-14 rounded bg-[hsl(var(--muted)/0.4)] animate-pulse" />
          ) : (
            <p className="text-sm font-semibold text-foreground">
              {forecast ? `${forecast.avgEnergyPerDay.toFixed(1)} kWh` : '—'}
            </p>
          )}
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.costForecast.tariff')}</p>
          {isLoading ? (
            <div className="h-4 w-12 rounded bg-[hsl(var(--muted)/0.4)] animate-pulse" />
          ) : (
            <p className="text-sm font-semibold text-foreground">
              {effectiveRate != null ? formatRate(effectiveRate) : '—'}
            </p>
          )}
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
