'use client';

import React from 'react';
import { Car, Battery, Compass, Zap, Route, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVehicleSpec } from '@/hooks/useVehicleSpec';
import { BaseCard } from '@/shared/ui';

interface Props {
  vehicleId: string | null;
}

function ChemistryBadge({ chemistry }: { chemistry: string }) {
  const isLfp = chemistry === 'LFP';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide ${
      isLfp
        ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
        : 'bg-blue-500/15 text-blue-400 border border-blue-500/20'
    }`}>
      {chemistry}
    </span>
  );
}

function GenerationBadge({ generation }: { generation: string }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/15 text-violet-400 border border-violet-500/20">
      {generation}
    </span>
  );
}

export function VehicleSpecCard({ vehicleId }: Props) {
  const { spec, isLoading } = useVehicleSpec(vehicleId);
  const { t } = useTranslation();

  const title =
    spec?.displayName ??
    (spec ? `${spec.model}${spec.trim ? ` ${spec.trim}` : ''}` : '—');

  const batteryNominal  = spec?.batteryNominalKwh;
  const batteryUsable   = spec?.batteryUsableKwh;
  const batteryDetected = spec?.batteryDetectedKwh;

  const batteryDisplay = batteryDetected ?? batteryUsable;
  const batteryRef     = batteryNominal ?? batteryUsable ?? 1;
  const batteryPct     = batteryDisplay != null ? Math.min((batteryDisplay / batteryRef) * 100, 100) : null;

  const chargeRec = spec?.chargeRecommendation;

  return (
    <BaseCard className="h-full">
      {/* Header */}
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-blue-500/15 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
          <Car className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">
            {t('cards.vehicleSpec.title')}
          </p>
          <h3 className="text-base font-bold text-foreground leading-tight truncate">
            {isLoading ? '—' : title}
          </h3>
          {spec && (
            <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
              <p className="text-[11px] text-muted-foreground">
                {spec.year ?? '—'} · {spec.region ?? t('cards.vehicleSpec.unknownRegion')}
              </p>
              {spec.cellChemistry && <ChemistryBadge chemistry={spec.cellChemistry} />}
              {spec.generation && <GenerationBadge generation={spec.generation} />}
            </div>
          )}
        </div>
      </div>

      {/* Spec grid */}
      <div className="stat-grid grid grid-cols-2 gap-x-4 gap-y-3 pt-3 border-t border-[hsl(var(--border)/0.5)]">

        {/* Battery */}
        <div className="col-span-2 lg:col-span-1">
          <div className="flex items-center gap-1.5 mb-1">
            <Battery className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
              {t('cards.vehicleSpec.battery')}
            </p>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-sm font-bold text-foreground">
              {batteryNominal != null ? `${batteryNominal.toFixed(0)} kWh` : '—'}
            </span>
            {batteryUsable != null && (
              <span className="text-[11px] text-muted-foreground">
                / {batteryUsable.toFixed(0)} {t('cards.vehicleSpec.usable')}
              </span>
            )}
          </div>
          {batteryPct != null && (
            <div className="mt-1.5 h-1 rounded-full bg-[hsl(var(--secondary)/0.5)] overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-500/70 to-blue-400/90 transition-all"
                style={{ width: `${batteryPct}%` }}
              />
            </div>
          )}
          {batteryDetected != null && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {t('cards.vehicleSpec.detectedCap')}: <span className="text-foreground">{batteryDetected.toFixed(1)} kWh</span>
            </p>
          )}
        </div>

        {/* Drivetrain */}
        <div className="col-span-1">
          <div className="flex items-center gap-1.5 mb-1">
            <Compass className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
              {t('cards.vehicleSpec.drivetrain')}
            </p>
          </div>
          <p className="text-sm font-bold text-foreground">
            {spec?.driveType ?? '—'}
          </p>
        </div>

        {/* Peak DC charging */}
        {spec?.peakChargingKw != null && (
          <div className="col-span-1">
            <div className="flex items-center gap-1.5 mb-1">
              <Zap className="w-3.5 h-3.5 text-muted-foreground" />
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                {t('cards.vehicleSpec.peakCharging', 'Peak DC')}
              </p>
            </div>
            <p className="text-sm font-bold text-foreground">
              {spec.peakChargingKw} kW
            </p>
          </div>
        )}

        {/* WLTP range */}
        {spec?.wltpKm != null && (
          <div className="col-span-1">
            <div className="flex items-center gap-1.5 mb-1">
              <Route className="w-3.5 h-3.5 text-muted-foreground" />
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                WLTP
              </p>
            </div>
            <p className="text-sm font-bold text-foreground">
              {spec.wltpKm} km
            </p>
          </div>
        )}

      </div>

      {/* Charge recommendation */}
      {chargeRec && (
        <div className={`mt-3 flex items-start gap-2 px-2.5 py-2 rounded-lg text-[11px] leading-relaxed ${
          chargeRec === 'charge_to_100'
            ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
            : 'bg-amber-500/10 border border-amber-500/20 text-amber-300'
        }`}>
          <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            {chargeRec === 'charge_to_100'
              ? t('cards.vehicleSpec.chargeLfp', 'LFP battery — charging to 100% daily is fine and helps BMS calibration')
              : t('cards.vehicleSpec.chargeNmc', 'NMC battery — keep daily charge at 80% to reduce degradation')}
          </span>
        </div>
      )}
    </BaseCard>
  );
}
