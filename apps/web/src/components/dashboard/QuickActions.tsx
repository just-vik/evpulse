'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ZapOff, Lock, Unlock, Volume2, RefreshCw } from 'lucide-react';
import { PowerOnIcon, ChargingIcon, ClimateIcon, TripIcon, BoltIcon, LeafIcon } from '@/components/icons/NavIcons';
import { useTranslation } from 'react-i18next';
import { useVehicleStatus } from '@/hooks/useVehicleStatus';
import { useVehicleCommands } from '@/hooks/useVehicleCommands';
import { useTripsToday, useChargingSummary } from '@/hooks/useVehicleAggregates';
import { BaseCard, ConfirmDialog } from '@/shared/ui';
import { COMMAND_CONFIRM_POLICY, needsConfirmation } from '@/hooks/vehicleCommandPolicy';

// i18n keys for the confirm-dialog copy, per action id. Actions on the
// 'stale' policy share the generic "status may be outdated" copy instead of
// a command-specific one.
const CONFIRM_COPY: Record<string, { titleKey: string; bodyKey: string; confirmLabelKey: string }> = {
  wake:          { titleKey: 'quickActions.confirm.wakeTitle', bodyKey: 'quickActions.confirm.wakeBody', confirmLabelKey: 'quickActions.wake' },
  unlock:        { titleKey: 'quickActions.confirm.unlockTitle', bodyKey: 'quickActions.confirm.unlockBody', confirmLabelKey: 'quickActions.unlock' },
  honk:          { titleKey: 'quickActions.confirm.honkTitle', bodyKey: 'quickActions.confirm.honkBody', confirmLabelKey: 'quickActions.honk' },
  'stop-charge': { titleKey: 'quickActions.confirm.stopChargeTitle', bodyKey: 'quickActions.confirm.stopChargeBody', confirmLabelKey: 'quickActions.stopCharge' },
};
const STALE_CONFIRM_COPY = {
  titleKey: 'quickActions.confirm.staleTitle',
  bodyKey: 'quickActions.confirm.staleBody',
  confirmLabelKey: 'quickActions.confirm.send',
};

// Pending-state label per action id, shown in place of the static label
// while the command is in flight — not just a spinning icon, so the state
// change is announced to assistive tech too, not only conveyed visually.
const PENDING_LABEL_KEY: Record<string, string> = {
  wake: 'quickActions.waking',
  'start-charge': 'quickActions.startingCharge',
  'stop-charge': 'quickActions.stoppingCharge',
  climate: 'quickActions.startingClimate',
  lock: 'quickActions.locking',
  unlock: 'quickActions.unlocking',
  honk: 'quickActions.honking',
};

interface Props {
  vehicleId: string;
}

type ActionVariant = 'primary' | 'secondary' | 'ghost';

interface ActionDef {
  id: string;
  labelKey: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  visible: (state: ActionState) => boolean;
  variant: ActionVariant;
  command: string;
  params?: Record<string, unknown>;
}

const VARIANT_CLASSES: Record<ActionVariant, string> = {
  primary:   'text-white bg-blue-500 hover:bg-blue-400 border-blue-400/50 shadow-sm shadow-blue-500/25 font-semibold',
  secondary: 'text-foreground bg-transparent hover:bg-[hsl(var(--secondary)/0.6)] border-[hsl(var(--border)/0.9)]',
  ghost:     'text-muted-foreground bg-transparent hover:bg-[hsl(var(--secondary)/0.4)] border-transparent',
};

interface ActionState {
  vehicleState: string | null;
  chargingState: string | null;
  locked: boolean | null;
}

const ACTIONS: ActionDef[] = [
  {
    id: 'wake',
    labelKey: 'quickActions.wake',
    icon: PowerOnIcon,
    visible: (s) => ['asleep', 'sleeping', 'offline', 'waking'].includes((s.vehicleState ?? '').toLowerCase()),
    variant: 'secondary',
    command: 'wake',
  },
  {
    id: 'start-charge',
    labelKey: 'quickActions.startCharge',
    icon: ChargingIcon,
    visible: (s) =>
      s.chargingState != null &&
      !['Charging', 'Complete'].includes(s.chargingState),
    variant: 'secondary',
    command: 'start-charging',
  },
  {
    id: 'stop-charge',
    labelKey: 'quickActions.stopCharge',
    icon: ZapOff,
    visible: (s) => s.chargingState === 'Charging',
    variant: 'secondary',
    command: 'stop-charging',
  },
  {
    id: 'climate',
    labelKey: 'quickActions.climateOn',
    icon: ClimateIcon,
    visible: (s) => !['asleep', 'sleeping', 'offline'].includes((s.vehicleState ?? '').toLowerCase()),
    variant: 'secondary',
    command: 'climate',
    params: { action: 'start' },
  },
  {
    id: 'lock',
    labelKey: 'quickActions.lock',
    icon: Lock,
    visible: (s) => s.locked === false,
    variant: 'ghost',
    command: 'lock',
  },
  {
    id: 'unlock',
    labelKey: 'quickActions.unlock',
    icon: Unlock,
    visible: (s) => s.locked === true,
    variant: 'ghost',
    command: 'unlock',
  },
  {
    id: 'honk',
    labelKey: 'quickActions.honk',
    icon: Volume2,
    visible: (s) => !['asleep', 'sleeping', 'offline'].includes((s.vehicleState ?? '').toLowerCase()),
    variant: 'ghost',
    command: 'honk',
  },
];

export function QuickActions({ vehicleId }: Props) {
  const { status, isLoading } = useVehicleStatus(vehicleId);
  const { send, isBusy, busyCommand } = useVehicleCommands(vehicleId);
  const { t } = useTranslation();
  const [confirmAction, setConfirmAction] = useState<ActionDef | null>(null);

  const { tripsToday } = useTripsToday(vehicleId);
  const { chargingSummary } = useChargingSummary(vehicleId);

  const dataQuality = (status as any)?.dataQuality as string | undefined;
  const isStaleOrOffline = !!dataQuality && dataQuality !== 'REALTIME' && dataQuality !== 'DELAYED';
  const controlsDisabled = isStaleOrOffline;

  function requestAction(action: ActionDef) {
    if (needsConfirmation(action.id, isStaleOrOffline)) {
      setConfirmAction(action);
    } else {
      send(action.command, action.params);
    }
  }

  function confirmDialogCopy(action: ActionDef) {
    return COMMAND_CONFIRM_POLICY[action.id] === 'stale' ? STALE_CONFIRM_COPY : (CONFIRM_COPY[action.id] ?? STALE_CONFIRM_COPY);
  }

  const actionState: ActionState = {
    vehicleState:  status?.vehicleState ?? null,
    chargingState: status?.chargingState ?? null,
    locked:        status?.locked ?? null,
  };

  const visible = ACTIONS.filter((a) => {
    if (controlsDisabled) return a.id === 'wake' && a.visible(actionState);
    return a.visible(actionState);
  });

  // Wake is the only action when offline — show it full width
  const wakeOnly = visible.length === 1 && visible[0].id === 'wake';

  const km      = tripsToday?.distanceKm ?? 0;
  const trips   = tripsToday?.tripCount ?? 0;
  const charged = chargingSummary?.energyKwh ?? 0;
  const headline =
    km >= 50 || trips >= 3 ? t('dailySummary.activeDay', { defaultValue: 'Active day' })
    : km > 0 || charged > 0 ? t('dailySummary.lightDay', { defaultValue: 'Light day' })
    : t('dailySummary.restDay', { defaultValue: 'Rest day' });

  const todayKpis = [
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
      label: t('dailySummary.charged', { defaultValue: 'Charged' }),
      value: chargingSummary ? chargingSummary.energyKwh.toFixed(1) : '0',
      unit: 'kWh',
      color: '#a78bfa',
    },
    {
      icon: LeafIcon,
      label: t('dailySummary.efficiency', { defaultValue: 'Eff.' }),
      value: tripsToday?.efficiencyWhKm != null ? String(Math.round(tripsToday.efficiencyWhKm)) : '—',
      unit: tripsToday?.efficiencyWhKm != null ? 'Wh/km' : '',
      color: '#fbbf24',
    },
  ];

  return (
    <BaseCard>
      {/* Section label */}
      <p className="text-2xs uppercase tracking-widest text-muted-foreground mb-3 font-medium">
        {t('quickActions.title')}
      </p>

      {controlsDisabled && (
        <p className="text-2xs text-amber-600 dark:text-amber-400 mb-2 flex items-center gap-1">
          <span>⚠</span> {t('quickActions.controlsDisabled')}
        </p>
      )}

      {/* Action buttons */}
      {isLoading ? (
        <div className="flex gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-9 flex-1 rounded-xl bg-[hsl(var(--secondary)/0.6)] animate-pulse" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('quickActions.noActions')}</p>
      ) : wakeOnly ? (
        /* Wake-only: full-width primary button */
        <motion.button
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          onClick={() => requestAction(ACTIONS.find((a) => a.id === 'wake')!)}
          disabled={isBusy}
          aria-busy={isBusy && busyCommand === 'wake'}
          className={`
            w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border
            text-sm transition-all disabled:opacity-60 disabled:cursor-default
            ${VARIANT_CLASSES.secondary}
            ${isBusy && busyCommand === 'wake' ? 'scale-95' : ''}
          `}
        >
          {isBusy && busyCommand === 'wake'
            ? <RefreshCw className="w-4 h-4 animate-spin" />
            : <PowerOnIcon size={15} />}
          {isBusy && busyCommand === 'wake' ? t(PENDING_LABEL_KEY.wake) : t('quickActions.wake')}
        </motion.button>
      ) : (
        /* Normal: flex row, wraps naturally */
        <div className="flex flex-wrap gap-2">
          {visible.map((action, i) => {
            const Icon = action.icon;
            const isThisBusy = isBusy && busyCommand === action.command;
            const pendingKey = PENDING_LABEL_KEY[action.id];
            return (
              <motion.button
                key={action.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: i * 0.04 }}
                onClick={() => requestAction(action)}
                disabled={isBusy}
                aria-busy={isThisBusy}
                className={`
                  inline-flex items-center gap-2 px-3 py-2 rounded-xl border
                  text-xs transition-all disabled:opacity-60 disabled:cursor-default
                  ${VARIANT_CLASSES[action.variant]}
                  ${isThisBusy ? 'scale-95' : ''}
                `}
              >
                {isThisBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Icon size={14} />}
                {isThisBusy && pendingKey ? t(pendingKey) : t(action.labelKey)}
              </motion.button>
            );
          })}
        </div>
      )}

      {confirmAction && (
        <ConfirmDialog
          open={!!confirmAction}
          onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
          title={t(confirmDialogCopy(confirmAction).titleKey)}
          description={t(confirmDialogCopy(confirmAction).bodyKey)}
          confirmLabel={t(confirmDialogCopy(confirmAction).confirmLabelKey)}
          cancelLabel={t('quickActions.confirm.cancel')}
          onConfirm={() => {
            send(confirmAction.command, confirmAction.params);
            setConfirmAction(null);
          }}
        />
      )}

      {/* Today's summary — divider + 4 stat chips */}
      <div className="mt-3.5 pt-3.5 border-t border-[hsl(var(--border)/0.4)]">
        <div className="flex items-center gap-1.5 mb-2.5">
          <span className="text-[10px] font-medium text-muted-foreground">{headline}</span>
          <span className="text-[10px] text-muted-foreground/30">·</span>
          <span className="text-[10px] text-muted-foreground/50">
            {new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
          {trips > 0 && (
            <>
              <span className="text-[10px] text-muted-foreground/30">·</span>
              <span className="text-[10px] text-muted-foreground/50">
                {trips} {trips === 1 ? t('dailySummary.trip', { defaultValue: 'trip' }) : t('dailySummary.trips', { defaultValue: 'trips' })}
              </span>
            </>
          )}
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {todayKpis.map((kpi) => (
            <div key={kpi.label} className="flex flex-col items-center gap-1 min-w-0">
              <span className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: `${kpi.color}18`, color: kpi.color }}>
                <kpi.icon size={11} />
              </span>
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground/50 leading-none text-center">{kpi.label}</p>
              <p className="text-[13px] font-semibold tabular-nums leading-none" style={{ color: kpi.color }}>
                {kpi.value}
                {kpi.unit && <span className="text-[8px] font-normal ml-0.5 opacity-60">{kpi.unit}</span>}
              </p>
            </div>
          ))}
        </div>
      </div>
    </BaseCard>
  );
}
