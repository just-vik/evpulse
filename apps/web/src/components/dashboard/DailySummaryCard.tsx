'use client';

import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { TripIcon, BoltIcon, ChargingIcon, LeafIcon } from '@/components/icons/NavIcons';
import { useTripsToday, useChargingSummary } from '@/hooks/useVehicleAggregates';

interface Props {
  vehicleId: string;
}

export function DailySummaryCard({ vehicleId }: Props) {
  const { t } = useTranslation();
  const { tripsToday, isLoading: tripsLoading } = useTripsToday(vehicleId);
  const { chargingSummary, isLoading: chargeLoading } = useChargingSummary(vehicleId);

  const isLoading = tripsLoading || chargeLoading;

  const { headline, accentClass, glowColor } = useMemo(() => {
    const km = tripsToday?.distanceKm ?? 0;
    const trips = tripsToday?.tripCount ?? 0;
    const charged = chargingSummary?.energyKwh ?? 0;

    if (km >= 50 || trips >= 3) {
      return { headline: t('dailySummary.activeDay', { defaultValue: 'Active day' }), accentClass: 'text-emerald-400', glowColor: 'rgba(52,211,153,0.06)' };
    }
    if (km > 0 || charged > 0) {
      return { headline: t('dailySummary.lightDay', { defaultValue: 'Light day' }), accentClass: 'text-sky-400', glowColor: 'rgba(56,189,248,0.06)' };
    }
    return { headline: t('dailySummary.restDay', { defaultValue: 'Rest day' }), accentClass: 'text-muted-foreground', glowColor: 'transparent' };
  }, [tripsToday, chargingSummary, t]);

  const kpis = [
    {
      icon: TripIcon,
      label: t('dailySummary.distance', { defaultValue: 'Distance' }),
      value: tripsToday ? tripsToday.distanceKm.toFixed(1) : '0',
      unit: 'km',
      color: '#34d399',
    },
    {
      icon: BoltIcon,
      label: t('dailySummary.energyUsed', { defaultValue: 'Used' }),
      value: tripsToday ? tripsToday.energyKwh.toFixed(1) : '0',
      unit: 'kWh',
      color: '#60a5fa',
    },
    {
      icon: ChargingIcon,
      label: t('dailySummary.charged30d', { defaultValue: 'Charged (30d)' }),
      value: chargingSummary ? chargingSummary.energyKwh.toFixed(1) : '0',
      unit: 'kWh',
      color: '#a78bfa',
    },
    {
      icon: LeafIcon,
      label: t('dailySummary.efficiency', { defaultValue: 'Efficiency' }),
      value: tripsToday?.efficiencyWhKm != null ? String(Math.round(tripsToday.efficiencyWhKm)) : '—',
      unit: tripsToday?.efficiencyWhKm != null ? 'Wh/km' : '',
      color: '#fbbf24',
    },
  ];

  if (isLoading) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] px-4 py-3 shadow-sm overflow-hidden relative"
      style={{ boxShadow: `0 0 32px ${glowColor}` }}
    >
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold ${accentClass}`}>{headline}</span>
          <span className="text-[10px] text-muted-foreground/50">·</span>
          <span className="text-[10px] text-muted-foreground">
            {new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
        </div>
        {(tripsToday?.tripCount ?? 0) > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {tripsToday!.tripCount} {tripsToday!.tripCount === 1
              ? t('dailySummary.trip', { defaultValue: 'trip' })
              : t('dailySummary.trips', { defaultValue: 'trips' })}
          </span>
        )}
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="flex flex-col items-center gap-1.5 min-w-0">
            <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: `${kpi.color}18`, color: kpi.color }}>
              <kpi.icon size={13} />
            </span>
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground/50 leading-none text-center">{kpi.label}</p>
            <p className="text-[15px] font-semibold tabular-nums leading-none" style={{ color: kpi.color }}>
              {kpi.value}
              {kpi.unit && <span className="text-[9px] font-normal ml-0.5 opacity-60">{kpi.unit}</span>}
            </p>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
