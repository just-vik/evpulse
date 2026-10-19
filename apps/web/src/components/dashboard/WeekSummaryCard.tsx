'use client';

import React from 'react';
import { DistanceIcon, BoltMetricIcon, ChargedIcon, LeafMetricIcon } from '@/components/icons/StatusIcons';
import { useTranslation } from 'react-i18next';
import { useTripsThisWeek, useChargingThisWeek } from '@/hooks/useVehicleAggregates';
import { BaseCard } from '@/shared/ui';

interface Props {
  vehicleId: string | null;
}

function getWeekRange(lang: string): { label: string; mondayDate: Date } {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString(lang, { month: 'short', day: 'numeric' });
  return { label: `${fmt(monday)} – ${fmt(sunday)}`, mondayDate: monday };
}

export function WeekSummaryCard({ vehicleId }: Props) {
  const { tripsThisWeek, isLoading: tripsLoading } = useTripsThisWeek(vehicleId);
  const { chargingThisWeek, isLoading: chargeLoading } = useChargingThisWeek(vehicleId);
  const { t, i18n } = useTranslation();
  const isLoading = tripsLoading || chargeLoading;

  const { label } = getWeekRange(i18n.language);

  const km      = tripsThisWeek?.distanceKm ?? 0;
  const trips   = tripsThisWeek?.tripCount ?? 0;
  const charged = chargingThisWeek?.energyKwh ?? 0;

  const kpis = [
    {
      icon: DistanceIcon,
      label: t('dailySummary.distance', { defaultValue: 'Расстояние' }),
      value: tripsThisWeek ? tripsThisWeek.distanceKm.toFixed(1) : '0',
      unit: 'km',
      color: '#26B89C',
    },
    {
      icon: BoltMetricIcon,
      label: t('dailySummary.energyUsed', { defaultValue: 'Потрачено' }),
      value: tripsThisWeek ? tripsThisWeek.energyKwh.toFixed(1) : '0',
      unit: 'kWh',
      color: '#3B82F6',
    },
    {
      icon: ChargedIcon,
      label: t('dailySummary.charged', { defaultValue: 'Заряжено' }),
      value: chargingThisWeek ? chargingThisWeek.energyKwh.toFixed(1) : '0',
      unit: 'kWh',
      color: '#8CBC38',
    },
    {
      icon: LeafMetricIcon,
      label: t('dailySummary.efficiency', { defaultValue: 'Эффект.' }),
      value: tripsThisWeek?.efficiencyWhKm != null ? String(Math.round(tripsThisWeek.efficiencyWhKm)) : '—',
      unit: tripsThisWeek?.efficiencyWhKm != null ? 'Wh/km' : '',
      color: '#3CBA72',
    },
  ];

  return (
    <BaseCard>
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('cards.weekSummary.title', { defaultValue: 'Эта неделя' })}
          </p>
          {isLoading ? (
            <div className="h-7 w-20 rounded-lg bg-[hsl(var(--muted)/0.5)] animate-pulse" />
          ) : (
            <h3 className="text-2xl font-bold text-[#26B89C] tracking-tight tabular-nums">
              {km.toFixed(1)} <span className="text-base font-semibold text-muted-foreground">km</span>
            </h3>
          )}
          <p className="text-[10px] text-muted-foreground/50 mt-0.5">
            {label}
            {trips > 0 && <span className="ml-1.5">· {trips} {t('dailySummary.trips', { defaultValue: 'поездки' })}</span>}
          </p>
        </div>
        <div className="w-11 h-11 rounded-[12px] bg-[#26B89C]/10 flex items-center justify-center text-[#26B89C] shrink-0">
          <DistanceIcon size={22} />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1.5 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="flex flex-col items-center gap-0.5 min-w-0">
            <span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0"
              style={{ background: `${kpi.color}18`, color: kpi.color }}>
              <kpi.icon size={10} />
            </span>
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground/50 leading-none text-center truncate w-full">
              {kpi.label}
            </p>
            {isLoading ? (
              <div className="h-3 w-8 rounded bg-[hsl(var(--muted)/0.4)] animate-pulse" />
            ) : (
              <p className="text-[12px] font-semibold tabular-nums leading-none" style={{ color: kpi.color }}>
                {kpi.value}
                {kpi.unit && <span className="text-[8px] font-normal ml-0.5 opacity-60">{kpi.unit}</span>}
              </p>
            )}
          </div>
        ))}
      </div>
    </BaseCard>
  );
}
