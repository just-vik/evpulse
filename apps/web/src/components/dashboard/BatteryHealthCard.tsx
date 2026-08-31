'use client';

import React from 'react';
import { Loader, AlertTriangle } from 'lucide-react';
import { BatteryIcon } from '@/components/icons/NavIcons';
import { useTranslation } from 'react-i18next';
import { useBatteryHealth } from '@/hooks/useBatteryHealth';
import { BaseCard } from '@/shared/ui';

interface Props {
  vehicleId: string | null;
}

export function BatteryHealthCard({ vehicleId }: Props) {
  const { health, isLoading } = useBatteryHealth(vehicleId);
  const { t } = useTranslation();

  // ── Calibration / data quality states ─────────────────────────────────────
  const confidence    = health?.baselineConfidence ?? 'NONE';
  const isCalibrating = health != null && !health.baselineLocked;   // no baseline at all
  const isHighConf    = confidence === 'HIGH';
  const isMedConf     = confidence === 'MEDIUM';
  const isLowData     = health?.lowData ?? false;

  // SOH: always capped at 100 when no baseline (backend already does this, guard here too)
  const soh        = Math.min(health?.sohPercent ?? 100, isCalibrating ? 100 : 999);
  const detectedCap = health?.estimatedCapacityKwh;
  const degr        = Math.max(0, health?.degradationPercent ?? 0);
  const nominal     = health?.nominalCapacityKwh;

  // Title label: "Battery health" (locked) vs "Estimated battery health" (no baseline)
  const titleKey = isCalibrating
    ? t('cards.batteryHealth.titleEstimated', 'Estimated battery health')
    : t('cards.batteryHealth.title', 'Battery health');

  // SOH value label — no ~ prefix; the calibration banner below explains the uncertainty
  function sohLabel() {
    if (isLoading || !health) return '—';
    return `${soh.toFixed(1)} %`;
  }

  return (
    <BaseCard>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{titleKey}</p>
            {isHighConf && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">HIGH</span>
            )}
            {isMedConf && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium">MED</span>
            )}
          </div>
          <h3 className="text-2xl font-bold text-emerald-400 tracking-tight tabular-nums">
            {sohLabel()}
          </h3>
        </div>
        <div className="w-9 h-9 rounded-xl bg-emerald-500/20 flex items-center justify-center text-emerald-300 shrink-0">
          <BatteryIcon size={20} />
        </div>
      </div>

      {/* Estimating banner — no baseline at all */}
      {isCalibrating && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-sky-500/10 border border-sky-500/20 mb-3 text-xs text-sky-300">
          <Loader className="w-3 h-3 animate-spin flex-shrink-0" />
          <span>{t('cards.batteryHealth.calibrating', 'Estimating… accuracy improves with more full charges')}</span>
        </div>
      )}

      {/* Low-data warning */}
      {isLowData && !isCalibrating && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/20 mb-3 text-xs text-amber-300">
          <AlertTriangle className="w-3 h-3 flex-shrink-0" />
          <span>{t('cards.batteryHealth.lowData', 'Insufficient data — accuracy improves with more trips')}</span>
        </div>
      )}

      {/* Stats row */}
      <div className="stat-grid grid grid-cols-3 gap-3 pt-3 border-t border-[hsl(var(--border)/0.5)]">
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.batteryHealth.nominalCap')}</p>
          <p className="text-sm font-semibold text-foreground">
            {nominal != null ? `${nominal.toFixed(1)} kWh` : isLoading ? '…' : '—'}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.batteryHealth.detectedUsable')}</p>
          <p className="text-sm font-semibold text-foreground">
            {detectedCap != null ? `${detectedCap.toFixed(1)} kWh` : isLoading ? '…' : '—'}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">{t('cards.batteryHealth.degradation')}</p>
          <p className="text-sm font-semibold text-foreground">
            {health
              ? degr === 0 && (isLowData || isCalibrating)
                ? '—'
                : `${degr.toFixed(1)} %`
              : isLoading ? '…' : '0.0 %'}
          </p>
        </div>
      </div>
    </BaseCard>
  );
}
