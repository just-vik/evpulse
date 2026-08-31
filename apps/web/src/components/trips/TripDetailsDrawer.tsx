'use client';

import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, MapPin, Battery, Gauge, Zap, Mountain, Wind, Car, Star, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import dynamic from 'next/dynamic';
import { useCurrency } from '@/hooks/useCurrency';
import { MetricBanknoteIcon } from '@/components/icons/MetricBanknoteIcon';

const TripMapGL = dynamic(() => import('./TripMapGL'), {
  ssr: false,
  loading: () => <div className="h-52 rounded-xl bg-[hsl(var(--secondary)/0.7)] animate-pulse" />,
});

export interface TripDrawerData {
  id: string;
  startTime: string;
  endTime: string | null;
  startLocation: string | null;
  endLocation: string | null;
  distanceKm: number | null;
  energyUsedKwh: number | null;
  efficiencyWhkm: number | null;
  startSoc: number | null;
  endSoc: number | null;
  polyline: string | null;
  qualityScore: number | null;
  drivingScore: number | null;
  costTotal: number | null;
  anomalyFlags: string | null;
  reliability: string | null;
  repairReason: string | null;
  repairTags?: Array<{ tag: string; source: string; ts: string }> | null;
  stats?: {
    avgSpeed: number | null;
    maxSpeed: number | null;
    trafficStopRatio: number | null;
    elevationGain: number | null;
    drivingStyle: string | null;
    regenEnergyKwh: number | null;
  } | null;
}

interface Props {
  trip: TripDrawerData | null;
  onClose: () => void;
}

export function TripDetailsDrawer({ trip, onClose }: Props) {
  const { t } = useTranslation();
  const { formatMoney, formatPerKm } = useCurrency();

  // Close on Escape
  useEffect(() => {
    if (!trip) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [trip, onClose]);

  // Prevent body scroll when open
  useEffect(() => {
    document.body.style.overflow = trip ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [trip]);

  const anomalies: string[] = (() => {
    if (!trip?.anomalyFlags) return [];
    if (Array.isArray(trip.anomalyFlags)) return trip.anomalyFlags as string[];
    try { return JSON.parse(trip.anomalyFlags); } catch { return []; }
  })();

  const energy   = trip?.energyUsedKwh != null ? Number(trip.energyUsedKwh) : null;
  const distance = trip?.distanceKm    != null ? Number(trip.distanceKm)    : null;
  const regen    = trip?.stats?.regenEnergyKwh ?? null;
  const costPerKm = trip?.costTotal && distance && distance > 0 ? trip.costTotal / distance : null;

  const statItems = trip ? [
    energy != null && { icon: Zap,      label: t('trips.energy'),       value: `${energy.toFixed(2)} kWh` },
    regen != null && regen > 0 && { icon: Wind, label: t('trips.regen'), value: `${regen.toFixed(2)} kWh`, cls: 'text-teal-400' },
    trip.costTotal != null && trip.costTotal > 0 && {
      icon: MetricBanknoteIcon,
      label: t('trips.cost'),
      value: `${formatMoney(trip.costTotal)}${costPerKm ? ` · ${formatPerKm(costPerKm)}` : ''}`,
    },
    trip.stats?.avgSpeed != null && { icon: Gauge, label: t('trips.avgSpeedLabel'), value: `${Math.round(trip.stats.avgSpeed)} ${t('trips.kmh')}` },
    trip.stats?.maxSpeed != null && { icon: Gauge, label: t('trips.maxSpeedLabel', { defaultValue: 'Max speed' }), value: `${Math.round(trip.stats.maxSpeed)} ${t('trips.kmh')}` },
    trip.stats?.elevationGain != null && trip.stats.elevationGain > 0 && {
      icon: Mountain, label: t('trips.elevationGain'), value: `↑ ${Math.round(trip.stats.elevationGain)} ${t('trips.meters')}`,
    },
    trip.stats?.trafficStopRatio != null && trip.stats.trafficStopRatio > 0 && {
      icon: Car, label: t('trips.traffic'), value: `${Math.round(trip.stats.trafficStopRatio * 100)}%`,
    },
    trip.stats?.drivingStyle && {
      icon: Star, label: t('trips.styleLabel'),
      value: trip.stats.drivingStyle === 'eco' ? t('trips.drivingStyle_eco') : trip.stats.drivingStyle === 'normal' ? t('trips.drivingStyle_normal') : t('trips.drivingStyle_aggressive'),
      cls: trip.stats.drivingStyle === 'eco' ? 'text-green-400' : trip.stats.drivingStyle === 'normal' ? 'text-blue-400' : 'text-red-400',
    },
    trip.startSoc != null && trip.endSoc != null && {
      icon: Battery, label: t('trips.chargeLabel'),
      value: `${Math.round(trip.startSoc)}% → ${Math.round(trip.endSoc)}%`,
    },
  ].filter(Boolean) as { icon: React.ComponentType<{ size?: number; className?: string }>; label: string; value: string; cls?: string }[] : [];

  return (
    <AnimatePresence>
      {trip && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          {/* Bottom sheet */}
          <motion.div
            key="sheet"
            className="fixed bottom-0 left-0 right-0 z-50 max-h-[90vh] rounded-t-2xl bg-[hsl(var(--card))] border-t border-x border-[hsl(var(--border)/0.6)] shadow-2xl overflow-hidden flex flex-col"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          >
            {/* Handle + header */}
            <div className="flex-none px-4 pt-3 pb-3 border-b border-[hsl(var(--border)/0.4)]">
              <div className="w-10 h-1 rounded-full bg-[hsl(var(--border)/0.6)] mx-auto mb-3" />
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    {new Date(trip.startTime).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <MapPin size={11} className="text-muted-foreground shrink-0" />
                    <p className="text-sm font-semibold text-foreground truncate">
                      {trip.startLocation?.split(',')[0] ?? '—'}
                      {trip.endLocation ? ` → ${trip.endLocation.split(',')[0]}` : ''}
                    </p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="w-8 h-8 rounded-full bg-[hsl(var(--secondary)/0.5)] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-3"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 space-y-4">
              {/* Map */}
              {trip.polyline && (
                <TripMapGL
                  polyline={trip.polyline}
                  repairReason={trip.repairReason ?? undefined}
                  height={220}
                />
              )}

              {/* Stats grid */}
              {statItems.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {statItems.map(item => {
                    const Icon = item.icon;
                    return (
                      <div key={item.label} className="flex items-start gap-2 p-2.5 rounded-xl bg-[hsl(var(--secondary)/0.45)] border border-[hsl(var(--border)/0.6)]">
                        <Icon size={13} className="text-muted-foreground mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-[10px] text-muted-foreground leading-none mb-0.5">{item.label}</p>
                          <p className={`text-xs font-semibold truncate ${item.cls ?? 'text-foreground'}`}>{item.value}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Quality & anomaly badges */}
              <div className="flex items-center gap-2 flex-wrap">
                {trip.qualityScore != null && (
                  <span className={`text-[10px] border px-1.5 py-0.5 rounded-lg font-medium ${
                    trip.qualityScore >= 80 ? 'bg-green-500/10 border-green-500/30 text-green-400'
                    : trip.qualityScore >= 50 ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400'
                    : 'bg-red-500/10 border-red-500/30 text-red-400'
                  }`}>Q:{trip.qualityScore >= 80 ? t('trips.qHigh') : trip.qualityScore >= 50 ? t('trips.qMed') : t('trips.qLow')}</span>
                )}
                {trip.reliability && (
                  <span className={`text-[10px] border px-1.5 py-0.5 rounded-lg font-medium ${
                    trip.reliability === 'HIGH'   ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : trip.reliability === 'MEDIUM' ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400'
                    : 'bg-red-500/10 border-red-500/30 text-red-400'
                  }`}>
                    {trip.reliability === 'HIGH' ? '🟢' : trip.reliability === 'MEDIUM' ? '🟡' : '🔴'} {trip.reliability}
                  </span>
                )}
                {anomalies.length > 0 && anomalies.map((a, i) => (
                  <span key={i} className="flex items-center gap-0.5 text-[10px] border px-1.5 py-0.5 rounded-lg bg-amber-500/10 border-amber-500/30 text-amber-400">
                    <AlertTriangle size={9} />{a.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
