'use client';

import React, { useEffect, useState } from 'react';
import { VampireIcon } from '@/components/icons/NavIcons';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/authStore';
import { apiClient } from '@/lib/api';
import { BaseCard } from '@/shared/ui';

interface DrainLog {
  date: string;
  startSoc: number;
  endSoc: number;
  drainPct: number;
  durationHrs: number;
  drainPerHr: number;
}

interface DrainStats {
  avgPerHr: number;
  avgDrainPct: number;
  avgDurationHrs: number;
  maxDrain: number;
  logs: DrainLog[];
  avgIdlePowerKw?: number | null;
}

interface Props {
  vehicleId: string | null;
}

export function VampireDrainWidget({ vehicleId }: Props) {
  const { accessToken } = useAuthStore();
  const { t } = useTranslation();
  const [stats, setStats] = useState<DrainStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!vehicleId || !accessToken) return;
    setIsLoading(true);
    apiClient
      .getVampireDrainStats(vehicleId, 30, accessToken)
      .then((data) => setStats(data as DrainStats))
      .catch(() => setStats(null))
      .finally(() => setIsLoading(false));
  }, [vehicleId, accessToken]);

  const hasData = (stats?.logs?.length ?? 0) > 0;
  const avgDrain = hasData ? stats?.avgDrainPct : undefined;
  const avgPerHr = hasData ? stats?.avgPerHr : undefined;
  const maxDrain = hasData ? stats?.maxDrain : undefined;
  const avgIdlePowerKw = stats?.avgIdlePowerKw ?? null;
  const logCount = stats?.logs?.length ?? 0;

  const severity =
    avgDrain == null
      ? 'none'
      : avgDrain > 5
      ? 'high'
      : avgDrain > 2
      ? 'medium'
      : 'low';

  const colorMap = {
    none:   { text: 'text-muted-foreground', iconBg: 'bg-[hsl(var(--secondary)/0.5)]', bar: 'bg-muted-foreground/30' },
    low:    { text: 'text-green-400',  iconBg: 'bg-green-500/15',  bar: 'bg-green-400' },
    medium: { text: 'text-amber-400',  iconBg: 'bg-amber-500/15',  bar: 'bg-amber-400' },
    high:   { text: 'text-red-400',    iconBg: 'bg-red-500/15',    bar: 'bg-red-400' },
  };
  const c = colorMap[severity];

  return (
    <BaseCard>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {t('cards.vampireDrain.title')}
          </p>
          <div className="flex items-baseline gap-2">
            <h3 className={`text-2xl font-bold tracking-tight tabular-nums ${c.text}`}>
              {isLoading
                ? '…'
                : avgDrain != null
                ? `${avgDrain.toFixed(1)}%`
                : t('cards.vampireDrain.noData')}
            </h3>
            {avgDrain != null && (
              <span className="text-xs text-muted-foreground">
                {t('cards.vampireDrain.perNight')}
              </span>
            )}
          </div>
        </div>
        <div className={`w-9 h-9 rounded-xl ${c.iconBg} flex items-center justify-center shrink-0`}>
          <VampireIcon size={20} className={c.text} />
        </div>
      </div>

      {/* Progress bar */}
      {avgDrain != null && (
        <div className="mb-4">
          <div className="h-1.5 w-full rounded-full bg-[hsl(var(--border)/0.5)] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${c.bar}`}
              style={{ width: `${Math.min(avgDrain * 10, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Stats grid */}
      <div className="stat-grid grid grid-cols-2 gap-x-3 gap-y-2.5 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            {t('cards.vampireDrain.perHour')}
          </p>
          <p className="text-sm font-semibold tabular-nums text-foreground">
            {avgPerHr != null ? `${avgPerHr.toFixed(2)}%/h` : '—'}
          </p>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            {t('cards.vampireDrain.maxNight')}
          </p>
          <p className="text-sm font-semibold tabular-nums text-foreground">
            {maxDrain != null ? `${maxDrain.toFixed(1)}%` : '—'}
          </p>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            {t('cards.vampireDrain.nights')}
          </p>
          <p className="text-sm font-semibold tabular-nums text-foreground">
            {isLoading ? '…' : logCount}
          </p>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            {t('cards.vampireDrain.idlePower')}
          </p>
          <p className="text-sm font-semibold tabular-nums text-foreground">
            {avgIdlePowerKw != null ? `${(avgIdlePowerKw * 1000).toFixed(0)} W` : '—'}
          </p>
        </div>
      </div>

      {/* High drain warning */}
      {severity === 'high' && (
        <p className="mt-3 text-[11px] text-red-400/80">
          {t('cards.vampireDrain.highDrain')}
        </p>
      )}
    </BaseCard>
  );
}
