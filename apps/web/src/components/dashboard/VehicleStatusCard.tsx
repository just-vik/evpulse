'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Battery, Gauge, Car, Zap, Moon, WifiOff,
  ParkingCircle, Clock, Signal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVehicleStatus } from '@/hooks/useVehicleStatus';
import { formatRelativeTime } from '@/lib/utils';
import { useUIStore } from '@/stores/uiStore';
import { BaseCard, FreshnessIndicator } from '@/shared/ui';

interface Props {
  vehicleId: string | null;
}

type DataQuality = 'REALTIME' | 'DELAYED' | 'STALE' | 'OFFLINE';

const STATE_CONFIG: Record<string, {
  icon: React.ElementType;
  bg: string;
  border: string;
  text: string;
}> = {
  driving:  { icon: Car,          bg: 'bg-emerald-500/15', border: 'border-emerald-500/30', text: 'text-emerald-700 dark:text-emerald-300' },
  charging: { icon: Zap,          bg: 'bg-blue-500/15',    border: 'border-blue-500/30',    text: 'text-blue-700 dark:text-blue-300'    },
  parked:   { icon: ParkingCircle,bg: 'bg-slate-500/15',   border: 'border-slate-500/30',   text: 'text-muted-foreground'   },
  online:   { icon: Car,          bg: 'bg-sky-500/15',     border: 'border-sky-500/30',     text: 'text-sky-700 dark:text-sky-300'      },
  sleeping: { icon: Moon,         bg: 'bg-indigo-500/10',  border: 'border-indigo-500/20',  text: 'text-indigo-700 dark:text-indigo-300'  },
  asleep:   { icon: Moon,         bg: 'bg-indigo-500/10',  border: 'border-indigo-500/20',  text: 'text-indigo-700 dark:text-indigo-300'  },
  waking:   { icon: Car,          bg: 'bg-amber-500/10',   border: 'border-amber-500/25',   text: 'text-amber-700 dark:text-amber-300'    },
  offline:  { icon: WifiOff,      bg: 'bg-red-500/10',     border: 'border-red-500/20',     text: 'text-red-700 dark:text-red-400'      },
};

const DEFAULT_STATE_CFG = { icon: Gauge, bg: 'bg-slate-500/10', border: 'border-slate-600/30', text: 'text-muted-foreground' };

export function VehicleStatusCard({ vehicleId }: Props) {
  const { status, isLoading, refresh } = useVehicleStatus(vehicleId);
  const { units, tempUnits } = useUIStore();
  const { t, i18n } = useTranslation();
  const [refreshing, setRefreshing] = React.useState(false);

  const lastUpdate  = (status as any)?.lastUpdate as string | undefined;
  const rangeKm     = (status as any)?.batteryRangeKm as number | undefined | null;
  const rawState    = ((status as any)?.vehicleState as string | undefined) ?? '';
  const stateKey    = rawState.toLowerCase();
  const cfg         = STATE_CONFIG[stateKey] ?? DEFAULT_STATE_CFG;
  const StateIcon   = cfg.icon;
  const dataQuality = ((status as any)?.dataQuality as DataQuality | undefined) ?? 'OFFLINE';

  const showLastKnown = dataQuality === 'STALE';
  const isOffline     = dataQuality === 'OFFLINE';

  function handleRefresh() {
    if (!vehicleId || refreshing) return;
    setRefreshing(true);
    refresh();
    setTimeout(() => setRefreshing(false), 1200);
  }

  return (
    <BaseCard>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <p className="text-2xs uppercase tracking-widest text-muted-foreground font-medium">
              {t('vehicleStatus.title')}
            </p>
            <FreshnessIndicator vehicleId={vehicleId} showLabel={dataQuality !== 'REALTIME'} />
          </div>

          {isLoading || !status ? (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-[hsl(var(--border))] animate-pulse" />
              <span className="text-base text-muted-foreground">{t('vehicleStatus.loading')}</span>
            </div>
          ) : (
            <div className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border ${cfg.bg} ${cfg.border}`}>
              <StateIcon size={14} className={cfg.text} />
              <span className={`text-sm font-semibold ${cfg.text}`}>
                {t(`status.${stateKey}`, { defaultValue: rawState })}
              </span>
            </div>
          )}

          {/* Compact status subtitle — single line, context-aware */}
          {!isLoading && status && (
            <div className="mt-1.5">
              {isOffline ? (
                <p className="text-2xs text-muted-foreground flex flex-wrap items-center gap-1.5">
                  <WifiOff size={9} className="text-red-400/70 shrink-0" />
                  {lastUpdate
                    ? t('vehicleStatus.lastSeen', { time: formatRelativeTime(lastUpdate, i18n.language) })
                    : t('vehicleStatus.vehicleOffline')}
                  {status.soc != null && <span>· SOC {Math.round(status.soc)}%</span>}
                  <span className="px-1.5 py-0.5 rounded-full text-[9px] bg-red-500/10 text-red-400 border border-red-500/20 leading-none">
                    {t('vehicleStatus.noRealtime', { defaultValue: 'No realtime' })}
                  </span>
                </p>
              ) : showLastKnown ? (
                <p className="text-2xs text-muted-foreground flex flex-wrap items-center gap-1.5">
                  <Clock size={9} className="text-amber-400/70 shrink-0" />
                  {lastUpdate && t('vehicleStatus.updated', { time: formatRelativeTime(lastUpdate, i18n.language) })}
                  {status.soc != null && <span>· SOC {Math.round(status.soc)}%</span>}
                  <span className="px-1.5 py-0.5 rounded-full text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 leading-none">
                    {t('vehicleStatus.qualityStale', { defaultValue: 'Stale' })}
                  </span>
                </p>
              ) : lastUpdate ? (
                <p className="text-2xs text-muted-foreground flex items-center gap-1.5">
                  <Clock size={9} />
                  {t('vehicleStatus.updated', { time: formatRelativeTime(lastUpdate, i18n.language) })}
                  {dataQuality === 'DELAYED' && (
                    <span className="text-amber-400/70">· {t('vehicleStatus.qualityDelayed', { defaultValue: 'slight delay' })}</span>
                  )}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-3">
          {/* Refresh — icon only */}
          <button
            onClick={handleRefresh}
            disabled={!vehicleId || isLoading || refreshing}
            className="w-8 h-8 rounded-xl flex items-center justify-center bg-[hsl(var(--secondary)/0.7)] hover:bg-[hsl(var(--secondary)/0.85)] border border-[hsl(var(--border))] disabled:opacity-60 text-muted-foreground hover:text-foreground transition-colors"
            title={t('common.refresh')}
          >
            <Signal size={13} className={refreshing ? 'animate-pulse' : ''} />
          </button>
          {/* Animated state icon */}
          <motion.div
            className={`w-9 h-9 rounded-xl flex items-center justify-center ${cfg.bg} border ${cfg.border}`}
            animate={
              stateKey === 'driving'  ? { y: [0, -2, 0] } :
              stateKey === 'charging' ? { scale: [1, 1.12, 1] } :
              {}
            }
            transition={{ repeat: Infinity, duration: stateKey === 'driving' ? 1.1 : 1.6, ease: 'easeInOut' }}
          >
            <StateIcon className={`w-4.5 h-4.5 ${cfg.text}`} size={18} />
          </motion.div>
        </div>
      </div>

      {/* Live driving panel */}
      <AnimatePresence>
        {!isOffline && !showLastKnown && stateKey === 'driving' && status && (
          <motion.div
            key="driving-panel"
            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
            animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="stat-grid grid grid-cols-3 gap-2 p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
              <div className="text-center">
                <p className="text-[9px] uppercase tracking-wider text-emerald-400/70 mb-0.5">{t('vehicleStatus.speed')}</p>
                <p className="text-2xl font-bold text-emerald-300 tabular-nums leading-none">
                  {status.speed != null ? Math.round(status.speed) : '—'}
                </p>
                <p className="text-[9px] text-emerald-400/60 mt-0.5">km/h</p>
              </div>
              <div className="text-center border-x border-emerald-500/15">
                <p className="text-[9px] uppercase tracking-wider text-emerald-400/70 mb-0.5">{t('vehicleStatus.power')}</p>
                <p className={`text-xl font-bold tabular-nums leading-none ${(status.power ?? 0) < 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {status.power != null ? `${status.power > 0 ? '+' : ''}${status.power.toFixed(1)}` : '—'}
                </p>
                <p className="text-[9px] text-emerald-400/60 mt-0.5">
                  {status.power != null && status.power < 0 ? t('vehicleStatus.regen', { defaultValue: 'regen' }) : 'kW'}
                </p>
              </div>
              <div className="text-center">
                <p className="text-[9px] uppercase tracking-wider text-emerald-400/70 mb-0.5">{t('vehicleStatus.outsideTemp')}</p>
                <p className="text-xl font-bold text-sky-300 tabular-nums leading-none">
                  {(status as any).outsideTemp != null ? (status as any).outsideTemp.toFixed(1) : '—'}
                </p>
                <p className="text-[9px] text-emerald-400/60 mt-0.5">°C</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Live charging panel */}
      <AnimatePresence>
        {!isOffline && !showLastKnown && stateKey === 'charging' && status && (
          <motion.div
            key="charging-panel"
            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
            animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="stat-grid grid grid-cols-3 gap-2 p-3 rounded-xl bg-blue-500/8 border border-blue-500/20">
              <div className="text-center">
                <p className="text-[9px] uppercase tracking-wider text-blue-400/70 mb-0.5">SOC</p>
                <p className="text-2xl font-bold text-blue-300 tabular-nums leading-none">
                  {status.soc != null ? Math.round(status.soc) : '—'}
                </p>
                <p className="text-[9px] text-blue-400/60 mt-0.5">
                  {(status as any).chargeLimit != null ? `→ ${Math.round((status as any).chargeLimit)}%` : '%'}
                </p>
              </div>
              <div className="text-center border-x border-blue-500/15">
                <p className="text-[9px] uppercase tracking-wider text-blue-400/70 mb-0.5">{t('vehicleStatus.power')}</p>
                <p className="text-xl font-bold text-emerald-400 tabular-nums leading-none">
                  {status.power != null ? `+${Math.abs(status.power).toFixed(1)}` : '—'}
                </p>
                <p className="text-[9px] text-blue-400/60 mt-0.5">kW</p>
              </div>
              <div className="text-center">
                <p className="text-[9px] uppercase tracking-wider text-blue-400/70 mb-0.5">{t('vehicleStatus.range')}</p>
                <p className="text-xl font-bold text-sky-300 tabular-nums leading-none">
                  {rangeKm != null ? Math.round(rangeKm) : '—'}
                </p>
                <p className="text-[9px] text-blue-400/60 mt-0.5">km</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Metrics — offline & stale both show dimmed SOC (no separate "Vehicle offline" text block) */}
      {isOffline || showLastKnown ? (
        <StaleMetrics soc={status?.soc} rangeKm={rangeKm} units={units} t={t} />
      ) : (
        <RealtimeMetrics status={status} rangeKm={rangeKm} units={units} tempUnits={tempUnits} t={t} />
      )}
    </BaseCard>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function SocHero({ soc, rangeKm, chargeLimit, units, label, dimmed, t }: {
  soc: number | null | undefined;
  rangeKm?: number | null;
  chargeLimit?: number | null;
  units: string;
  label?: string;
  dimmed?: boolean;
  t: (k: string) => string;
}) {
  const pct = soc != null ? Math.round(soc) : null;
  const barColor = pct == null ? 'from-slate-500 to-slate-400'
    : pct > 30 ? 'from-blue-500 to-emerald-400'
    : pct > 10 ? 'from-amber-500 to-orange-400'
    : 'from-red-500 to-red-400';
  const iconColor = pct == null ? 'text-slate-400'
    : pct > 30 ? 'text-emerald-400'
    : pct > 10 ? 'text-amber-400'
    : 'text-red-400';
  const range = rangeKm != null
    ? (units === 'imperial' ? `${Math.round(rangeKm / 1.60934)} mi` : `${Math.round(rangeKm)} km`)
    : null;

  return (
    <div className={dimmed ? 'opacity-50' : ''}>
      <div className="flex items-center gap-3 mb-2.5">
        <Battery size={26} className={iconColor} />
        <div className="flex items-baseline gap-1">
          <span className="text-5xl font-bold tabular-nums tracking-tight text-foreground leading-none">
            {pct ?? '—'}
          </span>
          {pct != null && <span className="text-xl font-semibold text-muted-foreground">%</span>}
        </div>
        {label && <span className="text-xs text-muted-foreground ml-1">{label}</span>}
      </div>
      <div className="h-2.5 rounded-full bg-[hsl(var(--border)/0.4)] overflow-hidden mb-2">
        <motion.div
          className={`h-full rounded-full bg-gradient-to-r ${barColor}`}
          initial={{ width: 0 }}
          animate={{ width: `${pct ?? 0}%` }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
        />
      </div>
      <div className="flex items-center gap-3">
        {range && <span className="text-sm font-semibold text-foreground/75 tabular-nums">{range}</span>}
        {chargeLimit != null && (
          <span className="text-[11px] text-muted-foreground opacity-70">→ {Math.round(chargeLimit)}%</span>
        )}
      </div>
    </div>
  );
}

function RealtimeMetrics({ status, rangeKm, units, tempUnits, t }: any) {
  const chargeLimit = (status as any)?.chargeLimit as number | null | undefined;
  const showSecondary = (status?.speed != null && status.speed > 0)
    || (status?.power != null && Math.abs(status.power) > 0.5)
    || status?.batteryTemp != null;

  return (
    <div>
      <SocHero soc={status?.soc} rangeKm={rangeKm} chargeLimit={chargeLimit} units={units} t={t} />
      {showSecondary && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3 pt-3 border-t border-[hsl(var(--border)/0.4)]">
          {status?.speed != null && status.speed > 0 && (
            <SecondaryMetric label={t('vehicleStatus.speed')}
              value={units === 'imperial' ? `${Math.round(status.speed / 1.60934)} mph` : `${Math.round(status.speed)} km/h`} />
          )}
          {status?.power != null && Math.abs(status.power) > 0.5 && (
            <SecondaryMetric label={t('vehicleStatus.power')} value={`${status.power.toFixed(1)} kW`} />
          )}
          {status?.batteryTemp != null && (
            <SecondaryMetric label={t('vehicleStatus.batteryTemp')}
              value={tempUnits === 'fahrenheit'
                ? `${Math.round(status.batteryTemp * 9 / 5 + 32)} °F`
                : `${status.batteryTemp.toFixed(1)} °C`} />
          )}
        </div>
      )}
    </div>
  );
}

function StaleMetrics({ soc, rangeKm, units, t }: { soc?: number | null; rangeKm?: number | null; units: string; t: (k: string) => string }) {
  return (
    <SocHero soc={soc} rangeKm={rangeKm} units={units} label={t('vehicleStatus.lastKnownSOC')} dimmed t={t} />
  );
}

function SecondaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold text-foreground tabular-nums">{value}</p>
    </div>
  );
}
