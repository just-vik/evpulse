'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useTheme } from 'next-themes';
import { Page } from '@/components/layout';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { apiClient } from '@/lib/api';
import type { AccentColor } from '@/stores/uiStore';
import type { TempUnits, AppPreferences } from '@/stores/uiStore';

import { useRouter } from 'next/navigation';
import { ScheduledCommandsSection } from '@/components/settings/ScheduledCommandsSection';
import RuleEditorDrawer from '@/components/notifications/RuleEditorDrawer';
import { useCurrency } from '@/hooks/useCurrency';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import {
  User,
  Bell,
  Shield,
  Zap,
  Palette,
  Car,
  CheckCircle,
  XCircle,
  Loader,
  AlertCircle,
  AlertTriangle,
  ExternalLink,
  Plus,
  Trash2,
  Send,
  ToggleLeft,
  ToggleRight,
  Moon,
  Sun,
  Monitor,
  Ruler,
  Thermometer,
  Eye,
  EyeOff,
  Key,
  Smartphone,
  Globe,
  Clock,
  Calendar,
  Euro,
  Lock,
  Copy,
  Info,
  Languages,
  Sparkles,
  Home,
  Plug,
  Battery,
  Download,
  Wand2,
  Droplets,
  TrendingDown,
  History,
  ChevronDown,
} from 'lucide-react';

import clsx from 'clsx';
import { useSubscription } from '@/hooks/useSubscription';
import { UpgradeModal } from '@/components/billing/UpgradeModal';
import { SegmentedControl } from '@/shared/ui/SegmentedControl';

type SettingsTab =
  | 'profile'
  | 'vehicles'
  | 'notifications'
  | 'security'
  | 'preferences'
  | 'appearance';

const TAB_DEFS = [
  { id: 'profile',       icon: <User size={20} /> },
  { id: 'vehicles',      icon: <Car size={20} /> },
  { id: 'notifications', icon: <Bell size={20} /> },
  { id: 'security',      icon: <Shield size={20} /> },
  { id: 'preferences',   icon: <Zap size={20} /> },
  { id: 'appearance',    icon: <Palette size={20} /> },
];

const TYPO = {
  caption: 'text-[11px] leading-4 text-muted-foreground',
  body: 'text-sm leading-5 text-foreground',
  label: 'text-sm font-medium leading-5 text-foreground',
} as const;

function Skel({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />
}

function TabButton({ tab, active, onClick }: any) {
  return (
    <motion.button
      onClick={onClick}
      whileTap={{ scale: 0.95 }}
      className={clsx(
        'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all whitespace-nowrap leading-none',
        active
          ? 'bg-[var(--a-tint)] text-[var(--a-400)] border border-[var(--a-ring)]'
          : 'text-[var(--s-text-muted)] hover:text-[var(--s-text)] hover:bg-[var(--s-2)] border border-transparent'
      )}
    >
      <span className="inline-flex items-center translate-y-[0.5px]">{tab.icon}</span>
      <span className="inline-flex items-center">{tab.label}</span>
    </motion.button>
  )
}

function SettingItem({ label, description, children }: any) {
  return (
    <div className="settings-row flex items-center justify-between gap-4">
      <div>
        <p className="font-semibold text-foreground leading-5">{label}</p>
        {description && <p className={TYPO.caption}>{description}</p>}
      </div>
      {children}
    </div>
  )
}

function VehiclesTab() {
  const { accessToken } = useAuthStore()
  const { t } = useTranslation()
  const { symbol: currSymbol, formatRate: fmtRate } = useCurrency()

  const [teslaStatus, setTeslaStatus] = useState<any>(null)
  const [vehicles, setVehicles] = useState<any[]>([])
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [linking, setLinking] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [configuringTelemetry, setConfiguringTelemetry] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [fleetStatus, setFleetStatus] = useState<{
    vehicles: Array<{ vehicleId: string; vin: string | null; keyPaired: boolean | null; synced: boolean | null; configured: boolean }>
  } | null>(null)
  const [checkingFleetStatus, setCheckingFleetStatus] = useState(false)

  async function handleCheckFleetStatus() {
    if (!accessToken) return
    setCheckingFleetStatus(true)
    try {
      const status = await apiClient.getFleetTelemetryStatus(accessToken)
      setFleetStatus(status)
    } catch (e: any) {
      setError(e.message)
    }
    setCheckingFleetStatus(false)
  }

  useEffect(() => {
    if (!accessToken) return
    setLoading(true)
    Promise.all([
      apiClient.getTeslaStatus(accessToken),
      apiClient.getVehicles(accessToken),
    ])
      .then(async ([s, vs]) => {
        setTeslaStatus(s)
        const arr = vs as any[]
        setVehicles(arr)
        const settingsMap: Record<string, any> = {}
        await Promise.allSettled(
          arr.map(v =>
            apiClient
              .getVehicleSettings(v.id, accessToken)
              .then(cfg => {
                settingsMap[v.id] = cfg
              })
              .catch(() => {}),
          ),
        )
        setSettings(settingsMap)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [accessToken])

  function updateField(vehicleId: string, field: string, value: number) {
    setSettings(prev => ({
      ...prev,
      [vehicleId]: { ...prev[vehicleId], [field]: value },
    }))
  }

  async function handleSave(vehicleId: string) {
    if (!accessToken) return
    setSaving(vehicleId)
    try {
      const cfg = settings[vehicleId]
      await apiClient.updateVehicleSettings(
        vehicleId,
        {
          homeChargingRate: cfg.homeChargingRate,
          superchargerRate: cfg.superchargerRate,
          thirdPartyRate: cfg.thirdPartyRate,
          defaultChargeLimit: cfg.defaultChargeLimit,
          lowBatteryThreshold: cfg.lowBatteryThreshold,
        },
        accessToken,
      )
      setSaved(vehicleId)
      setTimeout(() => setSaved(null), 2000)
    } catch (e: any) {
      setError(e.message)
    }
    setSaving(null)
  }

  async function handleConnect() {
    if (!accessToken) return
    setLinking(true)
    try {
      const { url } = await apiClient.initiateTeslaLink(accessToken)
      window.location.href = url
    } catch (e: any) {
      setError(e.message)
      setLinking(false)
    }
  }

  async function handleDisconnect() {
    if (!accessToken || !confirm(t('settings.vehicles.disconnectConfirm'))) return
    setDisconnecting(true)
    try {
      await apiClient.disconnectTesla(accessToken)
      setTeslaStatus({ connected: false })
      setVehicles([])
    } catch (e: any) {
      setError(e.message)
    }
    setDisconnecting(false)
  }

  async function handleConfigureTelemetry() {
    if (!accessToken) return
    setConfiguringTelemetry(true)
    try {
      await apiClient.configureTeslaTelemetry(accessToken)
      setSaved('telemetry')
      setTimeout(() => setSaved(null), 2000)
    } catch (e: any) {
      const msg = e?.status === 400 || e?.message?.includes('400')
        ? t('settings.vehicles.streamingConfigureError')
        : e.message
      setError(msg)
    }
    setConfiguringTelemetry(false)
  }

  async function handleRemoveVehicle(vehicleId: string) {
    if (!accessToken) return
    setRemoving(vehicleId)
    try {
      await apiClient.deleteVehicle(vehicleId, accessToken)
      setVehicles(prev => prev.filter(v => v.id !== vehicleId))
      setConfirmRemove(null)
    } catch (e: any) {
      setError(e.message)
    }
    setRemoving(null)
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skel className="h-32 rounded-2xl" />
        <Skel className="h-48 rounded-2xl" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Tesla connection */}
      <div className="spatial-card rounded-2xl p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-sm font-semibold text-foreground">{t('settings.vehicles.teslaAccount')}</p>
            <p className="text-xs text-muted-foreground mt-0.5">OAuth · Fleet API</p>
          </div>
          <div
            className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-xl
            ${
              teslaStatus?.authExpired
                ? 'bg-red-500/10 text-red-400 border border-red-500/30'
                : teslaStatus?.connected
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : 'bg-[hsl(var(--secondary)/0.55)] text-muted-foreground border border-[hsl(var(--border)/0.8)]'
            }`}
          >
            <div
              className={`w-1.5 h-1.5 rounded-full ${
                teslaStatus?.authExpired
                  ? 'bg-red-400 animate-pulse'
                  : teslaStatus?.connected
                  ? 'bg-emerald-400 animate-pulse'
                  : 'bg-[hsl(var(--muted-foreground)/0.5)]'
              }`}
            />
            {teslaStatus?.authExpired
              ? t('settings.vehicles.reauthRequired')
              : teslaStatus?.connected
                ? t('settings.vehicles.connected')
                : t('settings.vehicles.disconnected')}
          </div>
        </div>

        {teslaStatus?.authExpired && (
          <div className="flex items-center gap-2 text-xs text-red-300 mb-3 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">
            <AlertCircle size={13} />
            <span className="flex-1">{t('settings.vehicles.authExpiredHint')} <strong>{t('settings.vehicles.reauthAction')}</strong>.</span>
          </div>
        )}
        {teslaStatus?.dataBlockedReason === 'telemetry_stale' && (
          <div className="flex items-center gap-2 text-xs text-amber-200 mb-3 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2">
            <AlertCircle size={13} />
            <span className="flex-1">{t('settings.vehicles.telemetryStaleBanner')}</span>
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 text-xs text-red-300 mb-3 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">
            <AlertCircle size={13} /> {error}
          </div>
        )}

        {teslaStatus?.connected ? (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="btn btn-danger text-xs"
            >
              {disconnecting ? (
                <Loader size={12} className="animate-spin" />
              ) : (
                <XCircle size={12} />
              )}
              {t('settings.vehicles.disconnect')}
            </button>
            <button
              onClick={handleConnect}
              className="btn btn-ghost text-xs border border-[hsl(var(--border)/0.8)]"
            >
              <ExternalLink size={12} /> {t('settings.vehicles.reauthAction')}
            </button>
            <button
              onClick={handleConfigureTelemetry}
              disabled={configuringTelemetry}
              className="btn btn-secondary text-xs"
            >
              {configuringTelemetry ? (
                <Loader size={12} className="animate-spin" />
              ) : (
                <Zap size={12} />
              )}
              {t('settings.vehicles.enableStreaming')}
            </button>
            {saved === 'telemetry' && (
              <span className="text-xs text-emerald-400 flex items-center gap-1">
                <CheckCircle size={12} /> {t('settings.vehicles.streamingConfigured')}
              </span>
            )}
          </div>
        ) : (
          <button
            onClick={handleConnect}
            disabled={linking}
            className="btn btn-primary text-sm"
          >
            {linking ? (
              <Loader size={14} className="animate-spin" />
            ) : (
              <ExternalLink size={14} />
            )}
            {t('settings.vehicles.connectTesla')}
          </button>
        )}
      </div>

      {/* Virtual Key setup — shown when Tesla is connected */}
      {teslaStatus?.connected && (
        <div className="spatial-card rounded-2xl p-5 border border-amber-500/20 bg-amber-500/5">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <Key size={16} className="text-amber-400 shrink-0" />
              <p className="text-sm font-semibold text-foreground">{t('settings.vehicles.virtualKeySetup')}</p>
            </div>
            {fleetStatus && (
              <div className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-lg ${
                fleetStatus.vehicles.every(v => v.keyPaired)
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
              }`}>
                {fleetStatus.vehicles.every(v => v.keyPaired)
                  ? <><CheckCircle size={11} /> {t('settings.vehicles.virtualKeyPairedBadge')}</>
                  : <><AlertCircle size={11} /> {t('settings.vehicles.virtualKeyNotPairedBadge')}</>}
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground mb-4">
            {t('settings.vehicles.virtualKeyDesc')}
          </p>

          <div className="space-y-2 mb-4">
            {[
              t('settings.vehicles.virtualKeyStep1'),
              t('settings.vehicles.virtualKeyStep2'),
              t('settings.vehicles.virtualKeyStep3'),
            ].map((step, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <div className="w-5 h-5 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-[10px] font-bold text-amber-400">{i + 1}</span>
                </div>
                <p className="text-xs text-foreground/80">{step}</p>
              </div>
            ))}
          </div>

          <div className="flex gap-2 flex-wrap">
            <a
              href="https://tesla.com/_ak/evpulse.app"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary text-xs flex items-center gap-1.5"
            >
              <ExternalLink size={12} />
              {t('settings.vehicles.virtualKeyOpen')}
            </a>
            <button
              onClick={handleCheckFleetStatus}
              disabled={checkingFleetStatus}
              className="btn btn-ghost text-xs border border-[hsl(var(--border)/0.8)] flex items-center gap-1.5"
            >
              {checkingFleetStatus ? <Loader size={12} className="animate-spin" /> : <Zap size={12} />}
              {t('settings.vehicles.virtualKeyCheck')}
            </button>
          </div>

          {fleetStatus && fleetStatus.vehicles.length > 0 && (
            <div className="mt-3 pt-3 border-t border-[hsl(var(--border)/0.4)] space-y-1.5">
              {fleetStatus.vehicles.map(fv => (
                <div key={fv.vehicleId} className="flex items-center gap-2 text-xs">
                  {fv.keyPaired === true
                    ? <CheckCircle size={12} className="text-emerald-400 shrink-0" />
                    : fv.keyPaired === false
                      ? <AlertCircle size={12} className="text-amber-400 shrink-0" />
                      : <Loader size={12} className="text-muted-foreground shrink-0" />}
                  <span className="text-muted-foreground font-mono">{fv.vin ?? fv.vehicleId.slice(0, 8)}</span>
                  <span className={fv.keyPaired ? 'text-emerald-400' : 'text-amber-400'}>
                    {fv.keyPaired === true ? t('settings.vehicles.virtualKeyPairedStatus')
                      : fv.keyPaired === false ? t('settings.vehicles.virtualKeyNotPairedStatus')
                      : t('settings.vehicles.virtualKeyStatusUnknown')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Per-vehicle settings */}
      {vehicles.map(v => {
        const cfg = settings[v.id] ?? {}
        const isSaving = saving === v.id
        const isSaved = saved === v.id

        return (
          <div key={v.id} className="spatial-card rounded-2xl p-5 space-y-5">
            {/* Vehicle header */}
            <div className="flex items-center gap-3 pb-3 border-b border-[hsl(var(--border)/0.65)]">
              <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/10 flex items-center justify-center">
                <Car size={15} className="text-blue-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {v.displayName ?? `${v.model} ${v.trim ?? ''}`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {v.year ? `${v.year} · ` : ''}
                  {v.vin}
                </p>
              </div>
            </div>

            {/* Charging rates */}
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-3">
                {t('settings.preferences.chargingRates')} ({currSymbol}/kWh)
              </p>
              <div className="space-y-3">
                {[
                  { key: 'homeChargingRate',  label: t('settings.preferences.rateHome'),         Icon: Home,          colorCls: 'text-emerald-400', color: '#10b981' },
                  { key: 'superchargerRate',  label: t('charging.supercharger'),                  Icon: Zap,           colorCls: 'text-amber-400',   color: '#f59e0b' },
                  { key: 'thirdPartyRate',    label: t('settings.preferences.rateThirdParty'),    Icon: Plug,          colorCls: 'text-violet-400',  color: '#8b5cf6' },
                ].map(({ key, label, Icon, colorCls, color }) => (
                  <div key={key} className="flex items-center gap-3">
                    <Icon size={14} className={`${colorCls} shrink-0`} />
                    <span className="text-sm text-muted-foreground w-28 shrink-0">{label}</span>
                    <div className="flex-1 flex items-center gap-2">
                      <input
                        type="range"
                        min={0.01}
                        max={1.5}
                        step={0.01}
                        value={cfg[key] ?? 0.35}
                        onChange={e => updateField(v.id, key, +e.target.value)}
                        className="flex-1 accent-blue-500 cursor-pointer"
                      />
                      <span className="text-sm font-semibold tabular-nums min-w-[4.5rem] text-right" style={{ color }}>
                        {fmtRate(Number(cfg[key] ?? 0.35))}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Thresholds */}
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-3">
                {t('settings.vehicles.thresholds')}
              </p>
              <div className="space-y-3">
                {[
                  { key: 'defaultChargeLimit',   label: t('settings.vehicles.chargeLimit'),      Icon: Battery,       colorCls: 'text-blue-400',    color: '#3b82f6', unit: '%', min: 50, max: 100 },
                  { key: 'lowBatteryThreshold',  label: t('settings.vehicles.lowBatteryAlert'),  Icon: AlertTriangle, colorCls: 'text-red-400',     color: '#ef4444', unit: '%', min: 5,  max: 50  },
                ].map(({ key, label, Icon, colorCls, color, unit, min, max }) => (
                  <div key={key} className="flex items-center gap-3">
                    <Icon size={14} className={`${colorCls} shrink-0`} />
                    <span className="text-sm text-muted-foreground w-28 shrink-0">{label}</span>
                    <div className="flex-1 flex items-center gap-2">
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={1}
                        value={cfg[key] ?? (key === 'defaultChargeLimit' ? 80 : 20)}
                        onChange={e => updateField(v.id, key, +e.target.value)}
                        className="flex-1 accent-blue-500 cursor-pointer"
                      />
                      <span className="text-sm font-semibold tabular-nums min-w-[4.5rem] text-right" style={{ color }}>
                        {cfg[key] ?? (key === 'defaultChargeLimit' ? 80 : 20)}{unit}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Save button */}
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={() => handleSave(v.id)}
              disabled={isSaving}
              className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 ${
                isSaved
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                  : 'btn btn-primary'
              }`}
            >
              {isSaving ? (
                <>
                  <Loader size={14} className="animate-spin" /> {t('settings.common.saving')}
                </>
              ) : isSaved ? (
                <>
                  <CheckCircle size={14} /> {t('settings.common.saved')}
                </>
              ) : (
                t('settings.common.saveChanges')
              )}
            </motion.button>

            {/* Remove vehicle */}
            {confirmRemove === v.id ? (
              <div className="mt-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3">
                <p className="text-xs text-red-300 flex-1">
                  {t('settings.vehicles.removeVehicleConfirm', { vehicle: v.displayName ?? v.model })}
                </p>
                <button
                  onClick={() => handleRemoveVehicle(v.id)}
                  disabled={removing === v.id}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-[hsl(var(--foreground))] disabled:opacity-60 shrink-0"
                >
                  {removing === v.id ? <Loader size={11} className="animate-spin" /> : <Trash2 size={11} />}
                  {t('common.confirm')}
                </button>
                <button
                  onClick={() => setConfirmRemove(null)}
                  className="text-xs text-muted-foreground hover:text-foreground shrink-0"
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmRemove(v.id)}
                className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-red-400 transition-colors"
              >
                <Trash2 size={12} /> {t('settings.vehicles.removeVehicle')}
              </button>
            )}
          </div>
        )
      })}

      {/* Scheduled Commands — shown if at least one vehicle is connected */}
      {vehicles.length > 0 && (
        <ScheduledCommandsSection vehicles={vehicles.map((v: any) => ({ id: v.id, displayName: v.displayName ?? v.name, vin: v.vin }))} />
      )}
    </div>
  )
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

function getTriggerOptions(t: (k: string) => string) {
  return [
    { value: 'SOC_BELOW',             label: t('settings.notifications.trigger.socBelow'),             hasThreshold: true,  unit: '%'    },
    { value: 'SOC_ABOVE',             label: t('settings.notifications.trigger.socAbove'),             hasThreshold: true,  unit: '%'    },
    { value: 'CHARGING_STARTED',      label: t('settings.notifications.trigger.chargingStarted'),      hasThreshold: false, unit: ''     },
    { value: 'CHARGING_COMPLETE',     label: t('settings.notifications.trigger.chargingComplete'),     hasThreshold: false, unit: ''     },
    { value: 'VEHICLE_UNLOCKED',      label: t('settings.notifications.trigger.vehicleUnlocked'),      hasThreshold: false, unit: ''     },
    { value: 'SPEED_ABOVE',           label: t('settings.notifications.trigger.speedAbove'),           hasThreshold: true,  unit: 'km/h' },
    { value: 'NOT_CHARGING_AT_HOME',  label: t('settings.notifications.trigger.notChargingAtHome'),   hasThreshold: true,  unit: '%'    },
    { value: 'DEGRADATION_ABOVE',     label: t('settings.notifications.trigger.degradationAbove'),     hasThreshold: true,  unit: '%'    },
    { value: 'VAMPIRE_DRAIN_ABOVE',   label: t('settings.notifications.trigger.vampireDrainAbove'),   hasThreshold: true,  unit: '%/hr' },
  ]
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className="text-muted-foreground hover:text-foreground transition">
      {enabled
        ? <ToggleRight size={26} className="text-blue-400" />
        : <ToggleLeft size={26} />}
    </button>
  )
}

function NotificationsTab() {
  const { accessToken } = useAuthStore()
  const { t } = useTranslation()
  const TRIGGER_OPTIONS = getTriggerOptions(t)
  const channelLabel = (channel: string) =>
    channel === 'in_app' ? t('settings.notifications.inApp') : channel === 'telegram' ? t('settings.notifications.telegram') : t('settings.notifications.email')

  const [rules, setRules] = useState<any[]>([])
  const [settings, setSettings] = useState<any>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [showAddRule, setShowAddRule] = useState(false)
  const [newRule, setNewRule] = useState({
    name: '',
    triggerType: 'SOC_BELOW',
    threshold: 20,
    channels: ['in_app'] as string[],
    enabled: true,
  })
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null)
  const [ruleHistories, setRuleHistories] = useState<Record<string, any[]>>({})
  const [ruleHistoryLoading, setRuleHistoryLoading] = useState<string | null>(null)
  const [editorRule, setEditorRule] = useState<any | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [vehiclesForEditor, setVehiclesForEditor] = useState<any[]>([])

  useEffect(() => {
    if (!accessToken) return
    apiClient.getVehicles(accessToken).then(setVehiclesForEditor).catch(() => {})
  }, [accessToken])

  async function loadRuleHistory(ruleId: string) {
    if (ruleHistories[ruleId]) {
      setExpandedRuleId(prev => prev === ruleId ? null : ruleId)
      return
    }
    setRuleHistoryLoading(ruleId)
    setExpandedRuleId(ruleId)
    try {
      const items = await apiClient.getNotificationRuleHistory(ruleId, 5, accessToken ?? '')
      setRuleHistories(prev => ({ ...prev, [ruleId]: items }))
    } catch {
      setRuleHistories(prev => ({ ...prev, [ruleId]: [] }))
    } finally {
      setRuleHistoryLoading(null)
    }
  }

  // Web Push state
  const [pushState, setPushState] = useState<'unsupported' | 'denied' | 'subscribed' | 'unsubscribed'>('unsubscribed')
  const [pushLoading, setPushLoading] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      setPushState('unsupported')
      return
    }
    if (Notification.permission === 'denied') {
      setPushState('denied')
      return
    }
    navigator.serviceWorker.getRegistration('/sw.js').then(async (reg) => {
      if (!reg) return
      const sub = await reg.pushManager.getSubscription()
      if (sub) setPushState('subscribed')
    }).catch(() => {})
  }, [])

  async function handleEnablePush() {
    if (!accessToken) return
    setPushLoading(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setPushState('denied')
        return
      }
      const reg = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready

      const { publicKey } = await apiClient.getVapidPublicKey(accessToken)
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      })
      const json = sub.toJSON() as any
      await apiClient.subscribePush({
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      }, accessToken)
      await apiClient.updateNotificationSettings({ ...settings, webPushEnabled: true }, accessToken)
      setPushState('subscribed')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setPushLoading(false)
    }
  }

  async function handleDisablePush() {
    if (!accessToken) return
    setPushLoading(true)
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js')
      if (reg) {
        const sub = await reg.pushManager.getSubscription()
        if (sub) {
          await apiClient.unsubscribePush(sub.endpoint, accessToken)
          await sub.unsubscribe()
        }
      }
      await apiClient.updateNotificationSettings({ ...settings, webPushEnabled: false }, accessToken)
      setPushState('unsubscribed')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setPushLoading(false)
    }
  }

  useEffect(() => {
    if (!accessToken) return
    setLoading(true)
    Promise.all([
      apiClient.getNotificationRules(accessToken),
      apiClient.getNotificationSettings(accessToken).catch(() => ({})),
    ])
      .then(([r, s]) => {
        setRules(r as any[])
        setSettings(s as any)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [accessToken])

  async function handleSaveSettings() {
    if (!accessToken) return
    setSaving(true)
    try {
      await apiClient.updateNotificationSettings(settings, accessToken)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      setError(e.message)
    }
    setSaving(false)
  }

  async function handleToggleRule(rule: any) {
    if (!accessToken) return
    try {
      const updated = await apiClient.updateNotificationRule(rule.id, { ...rule, enabled: !rule.enabled }, accessToken)
      setRules(prev => prev.map(r => r.id === rule.id ? updated : r))
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleDeleteRule(id: string) {
    if (!accessToken || !confirm(t('settings.notifications.deleteRuleConfirm'))) return
    try {
      await apiClient.deleteNotificationRule(id, accessToken)
      setRules(prev => prev.filter(r => r.id !== id))
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleCreateRule() {
    if (!accessToken || !newRule.name.trim()) return
    setSaving(true)
    try {
      const opt = TRIGGER_OPTIONS.find(o => o.value === newRule.triggerType)
      const created = await apiClient.createNotificationRule({
        name: newRule.name,
        triggerType: newRule.triggerType,
        triggerValue: opt?.hasThreshold ? { value: newRule.threshold } : undefined,
        channels: newRule.channels,
        enabled: newRule.enabled,
        cooldownSec: 3600,
      }, accessToken)
      setRules(prev => [...prev, created])
      setShowAddRule(false)
      setNewRule({ name: '', triggerType: 'SOC_BELOW', threshold: 20, channels: ['in_app'], enabled: true })
    } catch (e: any) {
      setError(e.message)
    }
    setSaving(false)
  }

  function toggleChannel(ch: string) {
    setNewRule(prev => ({
      ...prev,
      channels: prev.channels.includes(ch)
        ? prev.channels.filter(c => c !== ch)
        : [...prev.channels, ch],
    }))
  }

  const triggerLabel = (rule: any) => {
    const opt = TRIGGER_OPTIONS.find(o => o.value === (rule.triggerType || rule.ruleType))
    if (!opt) return rule.triggerType || rule.ruleType || '?'
    const tv = rule.triggerValue as any
    const threshold = tv?.value ?? rule.threshold
    return threshold != null ? `${opt.label.replace('%', '').replace('km/h', '').trim()} ${threshold}${opt.unit}` : opt.label
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-32 rounded-2xl" />
        <div className="skeleton h-48 rounded-2xl" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">
          <AlertCircle size={13} /> {error}
        </div>
      )}

      {/* Delivery Channels */}
      <div className="spatial-card rounded-2xl p-5">
        <p className="text-base font-semibold text-foreground mb-4">{t('settings.notifications.deliveryChannels')}</p>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className={TYPO.label}>{t('settings.notifications.inApp')}</p>
              <p className={TYPO.caption}>{t('settings.notifications.inAppHint')}</p>
            </div>
            <Toggle
              enabled={settings?.inAppEnabled !== false}
              onToggle={() => setSettings((s: any) => ({ ...s, inAppEnabled: s?.inAppEnabled === false ? true : false }))}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className={TYPO.label}>{t('settings.notifications.telegram') || 'Telegram'}</p>
              <p className={TYPO.caption}>
                {settings?.telegramChatId
                  ? `Chat ID: ${settings.telegramChatId}`
                  : t('settings.notifications.telegramHint')}
              </p>
            </div>
            <Toggle
              enabled={!!settings?.telegramEnabled}
              onToggle={() => setSettings((s: any) => ({ ...s, telegramEnabled: !s.telegramEnabled }))}
            />
          </div>
          {settings?.telegramEnabled && (
            <div className="flex gap-2 items-center">
              <input
                type="text"
                placeholder={t('settings.notifications.telegramChatIdPlaceholder')}
                value={settings?.telegramChatId || ''}
                onChange={e => setSettings((s: any) => ({ ...s, telegramChatId: e.target.value }))}
                className="flex-1 bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.7)] rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-blue-500"
              />
            </div>
          )}
          <div className="flex items-center justify-between">
            <div>
              <p className={TYPO.label}>{t('settings.notifications.email')}</p>
              <p className={TYPO.caption}>{t('settings.notifications.emailHint')}</p>
            </div>
            <Toggle
              enabled={!!settings?.emailEnabled}
              onToggle={() => setSettings((s: any) => ({ ...s, emailEnabled: !s.emailEnabled }))}
            />
          </div>

          {/* Browser Push */}
          <div className="flex items-center justify-between pt-1">
            <div>
              <p className={TYPO.label}><Smartphone size={13} className="inline mr-1 -mt-0.5" />{t('settings.notifications.browserPush')}</p>
              <p className={TYPO.caption}>
                {pushState === 'unsupported' && t('settings.notifications.pushUnsupported')}
                {pushState === 'denied' && t('settings.notifications.pushDenied')}
                {pushState === 'subscribed' && t('settings.notifications.pushActive')}
                {pushState === 'unsubscribed' && t('settings.notifications.pushInactive')}
              </p>
            </div>
            {pushState === 'unsupported' || pushState === 'denied' ? (
              <span className={`text-xs px-2 py-1 rounded-lg ${pushState === 'denied' ? 'text-red-400 bg-red-500/10' : 'text-muted-foreground bg-[hsl(var(--secondary)/0.5)]'}`}>
                {pushState === 'denied' ? t('settings.notifications.pushBlocked') : t('settings.notifications.pushNA')}
              </span>
            ) : pushState === 'subscribed' ? (
              <button
                onClick={handleDisablePush}
                disabled={pushLoading}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition disabled:opacity-60"
              >
                {pushLoading ? <Loader size={11} className="animate-spin" /> : <CheckCircle size={11} />}
                {t('settings.notifications.pushActiveDisable')}
              </button>
            ) : (
              <button
                onClick={handleEnablePush}
                disabled={pushLoading}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg btn btn-primary disabled:opacity-60"
              >
                {pushLoading ? <Loader size={11} className="animate-spin" /> : <Bell size={11} />}
                {t('settings.notifications.pushEnable')}
              </button>
            )}
          </div>
        </div>
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={handleSaveSettings}
          disabled={saving}
          className={`mt-4 w-full py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 ${
            saved
              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
              : 'btn btn-primary'
          }`}
        >
          {saving ? <><Loader size={14} className="animate-spin" /> {t('settings.notifications.saving')}</>
           : saved ? <><CheckCircle size={14} /> {t('common.saved')}</>
           : <><Send size={14} /> {t('settings.notifications.saveSettings')}</>}
        </motion.button>
      </div>

      {/* Notification Rules */}
      <div className="spatial-card rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-foreground">{t('settings.notifications.alertRules')}</p>
          <button
            onClick={() => setShowAddRule(!showAddRule)}
            className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition"
          >
            <Plus size={14} /> {t('settings.notifications.addRule')}
          </button>
        </div>

        {/* Quick-add presets */}
        {!showAddRule && (
          <div className="mb-4">
            <div className="flex items-center gap-1.5 mb-2">
              <Wand2 size={11} className="text-muted-foreground" />
              <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">{t('settings.notifications.quickAdd')}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {([
                { icon: <Battery size={11} />, label: t('settings.notifications.presetLowBattery'), triggerType: 'SOC_BELOW', threshold: 20 },
                { icon: <Zap size={11} />,     label: t('settings.notifications.presetChargingDone'), triggerType: 'CHARGING_COMPLETE', threshold: 0 },
                { icon: <Home size={11} />,    label: t('settings.notifications.presetNotChargingHome'), triggerType: 'NOT_CHARGING_AT_HOME', threshold: 80 },
                { icon: <Droplets size={11} />, label: t('settings.notifications.presetVampireDrain'), triggerType: 'VAMPIRE_DRAIN_ABOVE', threshold: 0.15 },
                { icon: <TrendingDown size={11} />, label: t('settings.notifications.presetDegradation'), triggerType: 'DEGRADATION_ABOVE', threshold: 15 },
              ] as const).map((p) => (
                <button
                  key={p.triggerType}
                  onClick={() => {
                    setNewRule({ name: p.label, triggerType: p.triggerType, threshold: p.threshold, channels: ['in_app'], enabled: true })
                    setShowAddRule(true)
                  }}
                  className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg border border-[hsl(var(--border)/0.6)] bg-[hsl(var(--secondary)/0.25)] text-muted-foreground hover:text-foreground hover:border-[hsl(var(--border)/0.9)] transition-colors"
                >
                  {p.icon}{p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {showAddRule && (
          <div className="mb-4 p-4 bg-[hsl(var(--secondary)/0.4)] border border-[hsl(var(--border)/0.6)]/50 rounded-xl space-y-3">
            <input
              type="text"
              placeholder={t('settings.notifications.ruleNamePlaceholder')}
              value={newRule.name}
              onChange={e => setNewRule(prev => ({ ...prev, name: e.target.value }))}
              className="w-full bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.7)] rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[hsl(var(--brand-h)_var(--brand-s)_var(--brand-l-500))]"
            />
            <select
              value={newRule.triggerType}
              onChange={e => setNewRule(prev => ({ ...prev, triggerType: e.target.value }))}
              className="w-full bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.7)] rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-blue-500"
            >
              {TRIGGER_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {TRIGGER_OPTIONS.find(o => o.value === newRule.triggerType)?.hasThreshold && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-20">{t('settings.notifications.threshold')}</span>
                <input
                  type="number"
                  value={newRule.threshold}
                  onChange={e => setNewRule(prev => ({ ...prev, threshold: +e.target.value }))}
                  className="w-24 bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.7)] rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-blue-500"
                />
                <span className="text-xs text-muted-foreground">
                  {TRIGGER_OPTIONS.find(o => o.value === newRule.triggerType)?.unit}
                </span>
              </div>
            )}
            <div className="flex gap-2">
              {['in_app', 'telegram', 'email'].map(ch => (
                <button
                  key={ch}
                  onClick={() => toggleChannel(ch)}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                    newRule.channels.includes(ch)
                      ? 'bg-blue-500/20 border-blue-500/50 text-blue-200'
                      : 'border-[hsl(var(--border)/0.85)] text-[hsl(var(--muted-foreground)/0.92)] hover:border-[hsl(var(--border))] hover:text-foreground'
                  }`}
                >
                  {channelLabel(ch)}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreateRule}
                disabled={saving || !newRule.name.trim()}
                className="btn btn-primary text-xs flex-1 flex items-center justify-center gap-1"
              >
                {saving ? <Loader size={12} className="animate-spin" /> : <Plus size={12} />}
                {t('settings.notifications.createRule')}
              </button>
              <button
                onClick={() => setShowAddRule(false)}
                className="btn btn-ghost text-xs px-4 border border-[hsl(var(--border)/0.8)]"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {rules.length === 0 && !showAddRule ? (
          <p className="text-sm text-muted-foreground text-center py-6">{t('settings.notifications.noRules')}</p>
        ) : (
          <div className="space-y-2">
            {rules.map(rule => {
              const isExpanded = expandedRuleId === rule.id
              const history = ruleHistories[rule.id]
              const isHistoryLoading = ruleHistoryLoading === rule.id
              return (
                <div key={rule.id} className="rounded-xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--secondary)/0.4)] overflow-hidden">
                  {/* Rule header */}
                  <div className="flex items-center justify-between p-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{rule.name}</p>
                      <p className="text-xs text-muted-foreground">{triggerLabel(rule)}</p>
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {(rule.channels || ['in_app']).map((ch: string) => (
                          <span key={ch} className="text-[10px] px-1.5 py-0.5 bg-[hsl(var(--secondary)/0.78)] border border-[hsl(var(--border)/0.7)] rounded text-[hsl(var(--muted-foreground)/0.95)]">{channelLabel(ch)}</span>
                        ))}
                        {rule.lastFiredAt && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground/60">
                            {t('settings.notifications.lastFired', { defaultValue: 'Last fired' })}: {new Date(rule.lastFiredAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 ml-3 shrink-0">
                      <button
                        onClick={() => loadRuleHistory(rule.id)}
                        title={t('settings.notifications.showHistory', { defaultValue: 'Show history' })}
                        className={`p-1.5 rounded-lg transition-colors ${isExpanded ? 'text-blue-400 bg-blue-500/10' : 'text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--secondary)/0.6)]'}`}
                      >
                        {isHistoryLoading
                          ? <Loader size={13} className="animate-spin" />
                          : <History size={13} />}
                      </button>
                      <button
                        onClick={() => { setEditorRule(rule); setEditorOpen(true) }}
                        title={t('settings.notifications.editConditions', { defaultValue: 'Edit conditions & actions' })}
                        className={`p-1.5 rounded-lg transition-colors ${
                          (rule.conditions?.length || rule.actions?.length)
                            ? 'text-violet-400 bg-violet-500/10'
                            : 'text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--secondary)/0.6)]'
                        }`}
                      >
                        <Wand2 size={13} />
                      </button>
                      <Toggle enabled={rule.enabled} onToggle={() => handleToggleRule(rule)} />
                      <button
                        onClick={() => handleDeleteRule(rule.id)}
                        className="text-muted-foreground hover:text-red-400 transition p-1"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Firing history panel */}
                  {isExpanded && (
                    <div className="border-t border-[hsl(var(--border)/0.4)] px-3 py-2.5 bg-[hsl(var(--background)/0.4)]">
                      {!history || history.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground py-1 text-center">
                          {t('settings.notifications.noHistory', { defaultValue: 'No firings recorded yet' })}
                        </p>
                      ) : (
                        <ul className="space-y-1.5">
                          {history.map((item: any) => (
                            <li key={item.id} className="flex items-start gap-2">
                              <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${item.read ? 'bg-muted-foreground/40' : 'bg-blue-400'}`} />
                              <div className="min-w-0 flex-1">
                                <p className="text-[11px] font-medium text-foreground truncate">{item.title}</p>
                                {item.body && <p className="text-[10px] text-muted-foreground truncate">{item.body}</p>}
                              </div>
                              <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
                                {new Date(item.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <RuleEditorDrawer
        open={editorOpen}
        rule={editorRule}
        vehicles={vehiclesForEditor}
        onClose={() => setEditorOpen(false)}
        onSave={async (ruleId, conditions, actions) => {
          await apiClient.updateNotificationRule(ruleId, { conditions, actions }, accessToken ?? '')
          setRules(prev => prev.map(r => r.id === ruleId ? { ...r, conditions, actions } : r))
        }}
      />
    </div>
  )
}

/* ─── Profile Tab ───────────────────────────────── */

function ProfileTab() {
  const { accessToken, user, setUser } = useAuthStore()
  const { t } = useTranslation()
  const { plan, status, isActive, limits, features } = useSubscription()

  // ── Profile form ──────────────────────────────
  const [firstName, setFirstName] = useState(user?.firstName ?? '')
  const [lastName,  setLastName]  = useState(user?.lastName  ?? '')
  const [email,     setEmail]     = useState(user?.email     ?? '')
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)

  // ── Password form ─────────────────────────────
  const [currentPw,  setCurrentPw]  = useState('')
  const [newPw,      setNewPw]      = useState('')
  const [confirmPw,  setConfirmPw]  = useState('')
  const [savingPw,   setSavingPw]   = useState(false)
  const [savedPw,    setSavedPw]    = useState(false)
  const [pwError,    setPwError]    = useState<string | null>(null)
  const [showPw,     setShowPw]     = useState(false)

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault()
    if (!accessToken) return
    setSaving(true)
    setProfileError(null)
    try {
      const updated = await apiClient.updateProfile({ firstName, lastName, email }, accessToken)
      setUser(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err: any) {
      setProfileError(err.message)
    }
    setSaving(false)
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwError(null)
    if (newPw.length < 8) { setPwError(t('settings.profile.passwordMinLengthError')); return }
    if (newPw !== confirmPw) { setPwError(t('settings.profile.passwordsDoNotMatch')); return }
    if (!accessToken) return
    setSavingPw(true)
    try {
      await apiClient.changePassword(currentPw, newPw, accessToken)
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      setSavedPw(true)
      setTimeout(() => setSavedPw(false), 2500)
    } catch (err: any) {
      setPwError(err.message)
    }
    setSavingPw(false)
  }

  const initials = [user?.firstName, user?.lastName]
    .filter(Boolean).map(s => s![0].toUpperCase()).join('') ||
    user?.email?.[0].toUpperCase() || '?'

  const { preferences: profilePrefs } = useUIStore()
  const joinedDate = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString(profilePrefs.language || 'en', { month: 'long', year: 'numeric' })
    : null

  const pwStrength = newPw.length === 0 ? null
    : newPw.length < 8 ? 'weak'
    : newPw.length < 12 || !/[A-Z]/.test(newPw) || !/[0-9]/.test(newPw) ? 'fair'
    : 'strong'

  const pwStrengthBar = {
    weak:   { w: 'w-1/3', color: 'bg-red-500',    label: t('settings.profile.passwordStrength.weak') },
    fair:   { w: 'w-2/3', color: 'bg-amber-500',  label: t('settings.profile.passwordStrength.fair') },
    strong: { w: 'w-full', color: 'bg-emerald-500', label: t('settings.profile.passwordStrength.strong') },
  }

  return (
    <div className="space-y-4 w-full">

      {/* ── Avatar + identity ── */}
      <div className="spatial-card rounded-2xl p-5 flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shrink-0 text-2xl font-bold text-[hsl(var(--foreground))] select-none">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="text-lg font-semibold text-foreground truncate">
            {[user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email?.split('@')[0] || 'User'}
          </p>
          <p className="text-sm text-muted-foreground truncate">{user?.email}</p>
          <div className="flex items-center gap-2 mt-1.5">
            {user?.role && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-medium border border-blue-500/20">
                {user.role}
              </span>
            )}
            {joinedDate && (
              <span className="text-xs text-muted-foreground">{t('settings.profile.memberSince', { date: joinedDate })}</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Personal info ── */}
      <div className="spatial-card rounded-2xl p-5">
        <p className="text-base font-semibold text-foreground mb-4">{t('settings.profile.title')}</p>
        <form onSubmit={handleSaveProfile} className="space-y-3">

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">{t('settings.profile.firstName')}</label>
              <input
                value={firstName}
                onChange={e => setFirstName(e.target.value)}
                placeholder={t('settings.profile.firstName')}
                className="w-full px-3 py-2 rounded-lg bg-[hsl(var(--secondary)/0.45)] border border-[hsl(var(--border)/0.75)] text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:border-[hsl(var(--brand-h)_var(--brand-s)_var(--brand-l-500))] transition"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">{t('settings.profile.lastName')}</label>
              <input
                value={lastName}
                onChange={e => setLastName(e.target.value)}
                placeholder={t('settings.profile.lastName')}
                className="w-full px-3 py-2 rounded-lg bg-[hsl(var(--secondary)/0.45)] border border-[hsl(var(--border)/0.75)] text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:border-[hsl(var(--brand-h)_var(--brand-s)_var(--brand-l-500))] transition"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('settings.profile.email')}</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={t('settings.profile.emailPlaceholder')}
              className="w-full px-3 py-2 rounded-lg bg-[hsl(var(--secondary)/0.45)] border border-[hsl(var(--border)/0.75)] text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:border-[hsl(var(--brand-h)_var(--brand-s)_var(--brand-l-500))] transition"
            />
          </div>

          {profileError && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertCircle size={13} /> {profileError}
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 ${
              saved ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'btn-primary'
            }`}
          >
            {saving  ? <><Loader size={14} className="animate-spin" /> {t('common.loading')}</>
           : saved   ? <><CheckCircle size={14} /> {t('settings.profile.saved')}</>
           : t('settings.profile.saveChanges')}
          </button>
        </form>
      </div>

      {/* ── Subscription plan ── */}
      <div className="spatial-card rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Euro size={18} className="text-purple-400" />
          <p className="text-base font-semibold text-foreground">{t('settings.subscription.title')}</p>
        </div>

        {/* Plan badge row */}
        <div className="flex items-center justify-between p-4 rounded-xl bg-gradient-to-r from-purple-500/10 to-indigo-500/5 border border-purple-500/20">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-purple-500/20">
              <Zap size={18} className="text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-purple-300">{plan}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  isActive
                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                    : 'bg-[hsl(var(--secondary))] text-muted-foreground border border-[hsl(var(--border)/0.5)]'
                }`}>
                  {isActive ? `● ${t('settings.subscription.active')}` : t('settings.subscription.inactive')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('settings.subscription.historyLine', {
                  months: Math.round(limits.tripHistoryDays / 30),
                  max: limits.maxVehicles,
                  fleet: features.fleetDashboard ? t('settings.subscription.fleetSuffix') : '',
                })}
              </p>
            </div>
          </div>
          {features.fleetDashboard && (
            <div className="shrink-0 px-2.5 py-1 rounded-lg bg-purple-500/15 border border-purple-500/20">
              <p className="text-[11px] font-semibold text-purple-300 uppercase tracking-wider">FLEET</p>
            </div>
          )}
        </div>

        {/* Limits grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { labelKey: 'settings.subscription.tripsHistory',   value: t('settings.subscription.days', { count: limits.tripHistoryDays }),    icon: '🛣️' },
            { labelKey: 'settings.subscription.chargingHistory', value: t('settings.subscription.days', { count: limits.chargingHistoryDays }), icon: '⚡' },
            { labelKey: 'settings.subscription.analytics',      value: t('settings.subscription.days', { count: limits.analyticsDepthDays }),  icon: '📊' },
            { labelKey: 'settings.subscription.vehicles',       value: t('settings.subscription.upTo', { count: limits.maxVehicles }),         icon: '🚗' },
          ].map(({ labelKey, value, icon }) => (
            <div key={labelKey} className="p-3 rounded-lg bg-[hsl(var(--secondary)/0.35)] border border-[hsl(var(--border)/0.4)]">
              <p className="text-base mb-0.5">{icon}</p>
              <p className="text-xs text-muted-foreground leading-tight">{t(labelKey)}</p>
              <p className="text-sm font-semibold text-foreground mt-0.5">{value}</p>
            </div>
          ))}
        </div>

        {/* Feature flags */}
        <div className="flex flex-wrap gap-2">
          {[
            { flag: features.aiInsights,      labelKey: 'settings.subscription.aiInsights' },
            { flag: features.fleetDashboard,  labelKey: 'settings.subscription.fleetDashboard' },
            { flag: features.webhooks,        labelKey: 'settings.subscription.webhooks' },
          ].map(({ flag, labelKey }) => (
            <span key={labelKey} className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border font-medium ${
              flag
                ? 'bg-purple-500/10 border-purple-500/20 text-purple-300'
                : 'bg-[hsl(var(--secondary)/0.4)] border-[hsl(var(--border)/0.5)] text-muted-foreground'
            }`}>
              {flag ? <CheckCircle size={11} /> : <XCircle size={11} />}
              {t(labelKey)}
            </span>
          ))}
        </div>
      </div>

      {/* ── Change password ── */}
      <div className="spatial-card rounded-2xl p-5">
        <p className="text-base font-semibold text-foreground mb-1">{t('settings.profile.changePassword')}</p>
        <p className="text-xs text-muted-foreground mb-4">{t('settings.profile.passwordMinLength')}</p>

        <form onSubmit={handleChangePassword} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('settings.profile.currentPassword')}</label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                value={currentPw}
                onChange={e => setCurrentPw(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3 py-2 pr-10 rounded-lg bg-[hsl(var(--secondary)/0.45)] border border-[hsl(var(--border)/0.75)] text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:border-[hsl(var(--brand-h)_var(--brand-s)_var(--brand-l-500))] transition"
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('settings.profile.newPassword')}</label>
            <input
              type={showPw ? 'text' : 'password'}
              value={newPw}
              onChange={e => setNewPw(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3 py-2 rounded-lg bg-[hsl(var(--secondary)/0.45)] border border-[hsl(var(--border)/0.75)] text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:border-[hsl(var(--brand-h)_var(--brand-s)_var(--brand-l-500))] transition"
            />
            {/* Strength bar */}
            {pwStrength && (
              <div className="mt-1.5 flex items-center gap-2">
                <div className="flex-1 h-1 bg-[hsl(var(--secondary)/0.8)] rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${pwStrengthBar[pwStrength].w} ${pwStrengthBar[pwStrength].color}`} />
                </div>
                <span className={`text-xs font-medium ${pwStrengthBar[pwStrength].color.replace('bg-', 'text-')}`}>
                  {pwStrengthBar[pwStrength].label}
                </span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('settings.profile.confirmNewPassword')}</label>
            <input
              type={showPw ? 'text' : 'password'}
              value={confirmPw}
              onChange={e => setConfirmPw(e.target.value)}
              placeholder="••••••••"
              className={`w-full px-3 py-2 rounded-lg bg-[hsl(var(--secondary)/0.45)] border text-foreground placeholder:text-muted-foreground text-sm focus:outline-none transition ${
                confirmPw && confirmPw !== newPw
                  ? 'border-red-500/60'
                  : 'border-[hsl(var(--border)/0.75)] focus:border-[hsl(var(--brand-h)_var(--brand-s)_var(--brand-l-500))]'
              }`}
            />
          </div>

          {pwError && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertCircle size={13} /> {pwError}
            </div>
          )}

          <button
            type="submit"
            disabled={savingPw || !currentPw || !newPw || !confirmPw}
            className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 ${
              savedPw ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'btn-primary'
            }`}
          >
            {savingPw ? <><Loader size={14} className="animate-spin" /> {t('settings.profile.updatingPassword')}</>
            : savedPw ? <><CheckCircle size={14} /> {t('settings.profile.passwordUpdated')}</>
            : t('settings.profile.updatePassword')}
          </button>
        </form>
      </div>

      {/* ── Account info + Plan ── */}
      <div className="spatial-card rounded-2xl p-5">
        <p className="text-base font-semibold text-foreground mb-4">{t('settings.profile.accountInfo')}</p>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('settings.profile.accountId')}</span>
            <span className="text-foreground font-mono text-xs bg-[hsl(var(--secondary)/0.55)] px-2 py-0.5 rounded">
              {user?.id?.slice(0, 16) ?? '—'}…
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('settings.profile.memberSinceLabel')}</span>
            <span className="text-foreground">{joinedDate ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('settings.profile.roleLabel')}</span>
            <span className="text-foreground capitalize">{user?.role ?? 'user'}</span>
          </div>
        </div>
      </div>


    </div>
  )
}

/* ─── Security Tab ──────────────────────────────── */

function SecurityTab({ onSwitchToProfile }: { onSwitchToProfile: () => void }) {
  const { user, accessToken, reset } = useAuthStore()
  const { t } = useTranslation()
  const router = useRouter()
  const [showApiKey, setShowApiKey] = useState(false)
  const [copied, setCopied] = useState(false)

  // Login history
  const [loginHistory, setLoginHistory] = useState<import('@/lib/api').LoginEvent[]>([])
  const [loginHistoryOpen, setLoginHistoryOpen] = useState(false)
  const [loginHistoryLoaded, setLoginHistoryLoaded] = useState(false)

  useEffect(() => {
    if (!loginHistoryOpen || loginHistoryLoaded || !accessToken) return
    setLoginHistoryLoaded(true)
    apiClient.getLoginHistory(20, accessToken).then(setLoginHistory).catch(() => {})
  }, [loginHistoryOpen, loginHistoryLoaded, accessToken])

  // Delete account modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const apiKey = 'evp_' + (user?.id ?? 'demo').replace(/-/g, '').slice(0, 24) + 'xxxx'

  function copyApiKey() {
    navigator.clipboard.writeText(apiKey).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleDeleteAccount() {
    if (!accessToken) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await apiClient.deleteAccount(accessToken)
      reset()
      router.replace('/login')
    } catch (e: any) {
      setDeleteError(e?.message ?? t('common.error'))
      setDeleting(false)
    }
  }

  const sessions = [
    {
      device: t('settings.security.thisDevice'),
      browser: 'Chrome / Desktop',
      location: t('settings.security.currentSession'),
      current: true,
    },
  ]

  return (
    <div className="space-y-4 w-full">

      {/* Password */}
      <div className="spatial-card rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Lock size={18} className="text-brand-500" />
          <p className="text-base font-semibold text-foreground">{t('settings.security.passwordTitle')}</p>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          {t('settings.security.passwordHintPrefix')}{' '}
          <button
            className="text-brand-500 underline underline-offset-2"
            onClick={onSwitchToProfile}
          >{t('settings.security.profileTab')}</button>.{' '}
          {t('settings.security.passwordHintSuffix')}
        </p>
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[hsl(var(--secondary)/0.4)] border border-[hsl(var(--border)/0.6)]/40">
          <CheckCircle size={16} className="text-emerald-400 shrink-0" />
          <span className="text-sm text-foreground">{t('settings.security.passwordSet')}</span>
        </div>
      </div>

      {/* 2FA */}
      <div className="spatial-card rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Smartphone size={18} className="text-brand-500" />
            <p className="text-base font-semibold text-foreground">{t('settings.security.twoFactorTitle')}</p>
          </div>
          <span className="text-xs font-medium bg-[hsl(var(--secondary)/0.6)] border border-[hsl(var(--border)/0.6)] text-muted-foreground px-2.5 py-1 rounded-full">{t('settings.security.comingSoon')}</span>
        </div>
        <p className="text-sm text-muted-foreground mb-4">{t('settings.security.twoFactorHint')}</p>
        <div className="flex items-center gap-3">
          <button disabled className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--secondary)/0.6)] text-muted-foreground border border-[hsl(var(--border)/0.65)] cursor-not-allowed">
            <Key size={14} />
            {t('settings.security.enable2fa')}
          </button>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info size={12} />
            {t('settings.security.currentlyInDevelopment')}
          </div>
        </div>
      </div>

      {/* Active Sessions */}
      <div className="spatial-card rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Globe size={18} className="text-brand-500" />
          <p className="text-base font-semibold text-foreground">{t('settings.security.activeSessions')}</p>
        </div>
        <div className="space-y-2">
          {sessions.map((s, i) => (
            <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-[hsl(var(--secondary)/0.4)] border border-[hsl(var(--border)/0.6)]/40">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[hsl(var(--secondary)/0.8)] flex items-center justify-center">
                  <Monitor size={14} className="text-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{s.device}</p>
                  <p className="text-xs text-muted-foreground">{s.browser} · {s.location}</p>
                </div>
              </div>
              {s.current && (
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                  {t('settings.security.activeNow')}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Login History */}
      <div className="spatial-card rounded-2xl overflow-hidden">
        <button
          onClick={() => setLoginHistoryOpen(v => !v)}
          className="flex items-center justify-between w-full p-5 cursor-pointer hover:bg-[hsl(var(--accent)/0.04)] transition-colors"
        >
          <div className="flex items-center gap-2">
            <History size={18} className="text-brand-500" />
            <p className="text-base font-semibold text-foreground">{t('settings.security.loginHistoryTitle')}</p>
          </div>
          <ChevronDown size={15} className={`text-muted-foreground transition-transform ${loginHistoryOpen ? 'rotate-180' : ''}`} />
        </button>
        {loginHistoryOpen && (
          <div className="border-t border-[hsl(var(--border)/0.5)]">
            {loginHistory.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted-foreground">
                {t('settings.security.loginHistoryEmpty')}
              </p>
            ) : (
              <div className="divide-y divide-[hsl(var(--border)/0.35)]">
                {loginHistory.map(ev => (
                  <div key={ev.id} className="flex items-center justify-between px-5 py-3 gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${ev.success ? 'bg-emerald-500/12' : 'bg-red-500/12'}`}>
                        {ev.success
                          ? <CheckCircle size={13} className="text-emerald-400" />
                          : <XCircle size={13} className="text-red-400" />
                        }
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">
                          {ev.device
                            ? ev.device.charAt(0).toUpperCase() + ev.device.slice(1)
                            : t('settings.security.unknownDevice')}
                          {ev.ip && <span className="text-muted-foreground font-normal"> · {ev.ip}</span>}
                        </p>
                        {!ev.success && ev.failReason && (
                          <p className="text-xs text-red-400/80">{ev.failReason.replace(/_/g, ' ')}</p>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {new Date(ev.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* API Access */}
      <div className="spatial-card rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Key size={18} className="text-brand-500" />
            <p className="text-base font-semibold text-foreground">{t('settings.security.apiAccessTitle')}</p>
          </div>
          <span className="text-xs font-medium bg-[hsl(var(--secondary)/0.6)] border border-[hsl(var(--border)/0.6)] text-muted-foreground px-2.5 py-1 rounded-full">{t('settings.security.comingSoon')}</span>
        </div>
        <p className="text-sm text-muted-foreground mb-4">{t('settings.security.apiAccessHint')}</p>
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-[hsl(var(--secondary)/0.4)] border border-[hsl(var(--border)/0.6)] font-mono text-sm text-muted-foreground">
            {showApiKey ? apiKey : '•'.repeat(32)}
          </div>
          <button onClick={() => setShowApiKey(!showApiKey)} className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg bg-[hsl(var(--secondary)/0.5)] border border-[hsl(var(--border)/0.6)] text-muted-foreground hover:text-foreground transition">
            {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button onClick={copyApiKey} className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg bg-[hsl(var(--secondary)/0.5)] border border-[hsl(var(--border)/0.6)] text-muted-foreground hover:text-foreground transition">
            {copied ? <CheckCircle size={16} className="text-emerald-400" /> : <Copy size={16} />}
          </button>
        </div>
      </div>

      {/* ── Danger Zone ── */}
      <div className="spatial-card rounded-2xl p-5 border-red-500/30">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle size={18} className="text-red-400" />
          <p className="text-base font-semibold text-red-400">{t('settings.security.deleteAccount')}</p>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          {t('settings.security.deleteAccountHint')}
        </p>
        <button
          onClick={() => { setShowDeleteModal(true); setDeleteConfirmText(''); setDeleteError(null) }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition"
        >
          <Trash2 size={14} />
          {t('settings.security.deleteAccountBtn')}
        </button>
      </div>

      {/* ── Delete confirmation modal ── */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-md spatial-card rounded-2xl p-6 border-red-500/30"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
                <AlertTriangle size={20} className="text-red-400" />
              </div>
              <div>
                <p className="text-base font-semibold text-foreground">{t('settings.security.deleteAccountTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.security.deleteAccountIrreversible')}</p>
              </div>
            </div>

            <div className="space-y-3 mb-5">
              <div className="p-3 rounded-lg bg-red-500/8 border border-red-500/20 text-xs text-red-300 space-y-1">
                <p>• {t('settings.security.deleteWarning1')}</p>
                <p>• {t('settings.security.deleteWarning2')}</p>
                <p>• {t('settings.security.deleteWarning3')}</p>
              </div>
              <div>
                <p
                  className="text-xs text-muted-foreground mb-1.5"
                  dangerouslySetInnerHTML={{
                    __html: t('settings.security.deleteConfirmHint', { word: t('settings.security.deleteConfirmWord') }),
                  }}
                />
                <input
                  type="text"
                  value={deleteConfirmText}
                  onChange={e => setDeleteConfirmText(e.target.value)}
                  placeholder={t('settings.security.deleteConfirmPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg bg-[hsl(var(--secondary)/0.5)] border border-[hsl(var(--border)/0.7)] text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-red-500/50"
                  autoFocus
                />
              </div>
              {deleteError && (
                <div className="flex items-center gap-2 text-xs text-red-400">
                  <XCircle size={13} />
                  {deleteError}
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
                className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--secondary)/0.6)] border border-[hsl(var(--border)/0.65)] text-muted-foreground hover:text-foreground transition"
              >
                {t('settings.security.deleteCancel')}
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleting || deleteConfirmText.toLowerCase() !== t('settings.security.deleteConfirmWord')}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {deleting ? <Loader size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {deleting ? t('settings.security.deletingLabel') : t('settings.security.deletePermanently')}
              </button>
            </div>
          </motion.div>
        </div>
      )}

    </div>
  )
}

/* ─── Preferences Tab ────────────────────────────── */

function AIPreferencesSection() {
  const { accessToken } = useAuthStore()
  const { t } = useTranslation()
  const [autoMode, setAutoMode] = useState<'off' | 'suggest' | 'auto'>('suggest')
  const [maxActions, setMaxActions] = useState(3)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!accessToken) return
    apiClient.getAIPreferences(accessToken)
      .then(p => {
        setAutoMode((p.autoMode as any) ?? 'suggest')
        setMaxActions(p.maxAutoActionsPerHour ?? 3)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [accessToken])

  async function save() {
    if (!accessToken) return
    setSaving(true)
    setSaveError(null)
    try {
      await apiClient.setAIPreferences({ autoMode, maxAutoActionsPerHour: maxActions }, accessToken)
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
    } catch (e: any) {
      setSaveError(e?.message ?? t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  const modes: { id: 'off' | 'suggest' | 'auto'; label: string; desc: string }[] = [
    { id: 'off',     label: t('ai.mode.off'),     desc: t('ai.mode.offDesc') },
    { id: 'suggest', label: t('ai.mode.suggest'), desc: t('ai.mode.suggestDesc') },
    { id: 'auto',    label: t('ai.mode.auto'),    desc: t('ai.mode.autoDesc') },
  ]

  if (loading) return <div className="spatial-card rounded-2xl p-5 animate-pulse h-32" />

  return (
    <div className="spatial-card rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={18} className="text-brand-500" />
        <p className="text-base font-semibold text-foreground">{t('ai.preferencesTitle')}</p>
      </div>
      <p className="text-xs text-muted-foreground mb-4">{t('ai.preferencesSubtitle')}</p>

      <div className="space-y-2 mb-4">
        {modes.map(m => (
          <button
            key={m.id}
            onClick={() => setAutoMode(m.id)}
            className={`w-full flex items-start gap-3 p-3 rounded-xl border text-left transition ${
              autoMode === m.id
                ? 'bg-blue-500/10 border-blue-500/30 text-foreground'
                : 'bg-[hsl(var(--secondary)/0.3)] border-[hsl(var(--border)/0.5)] text-muted-foreground hover:border-[hsl(var(--border)/0.8)]'
            }`}
          >
            <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex-shrink-0 transition ${
              autoMode === m.id ? 'bg-brand-500 border-brand-500' : 'border-[hsl(var(--border)/0.9)]'
            }`} />
            <div>
              <p className="text-sm font-medium">{m.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{m.desc}</p>
            </div>
          </button>
        ))}
      </div>

      {autoMode === 'auto' && (
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-medium text-foreground">{t('ai.maxActions')}</p>
            <p className="text-xs text-muted-foreground">{t('ai.maxActionsHint')}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMaxActions(Math.max(1, maxActions - 1))}
              className="w-7 h-7 rounded-lg bg-[hsl(var(--secondary)/0.75)] border border-[hsl(var(--border)/0.75)] text-foreground hover:brightness-110 flex items-center justify-center text-lg leading-none"
            >−</button>
            <span className="text-sm font-semibold text-foreground w-4 text-center">{maxActions}</span>
            <button
              onClick={() => setMaxActions(Math.min(10, maxActions + 1))}
              className="w-7 h-7 rounded-lg bg-[hsl(var(--secondary)/0.75)] border border-[hsl(var(--border)/0.75)] text-foreground hover:brightness-110 flex items-center justify-center text-lg leading-none"
            >+</button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-brand-500 text-[hsl(var(--foreground))] hover:bg-brand-600 disabled:opacity-60 transition"
        >
          {saving ? <Loader size={14} className="animate-spin" /> : saved ? <CheckCircle size={14} /> : null}
          {saved ? t('common.saved') : t('ai.savePrefs')}
        </button>
        {saveError && (
          <span className="text-xs text-red-400 flex items-center gap-1">
            <AlertCircle size={12} /> {saveError}
          </span>
        )}
      </div>
    </div>
  )
}

function PreferencesTab() {
  const { preferences, setPreferences } = useUIStore()
  const { t } = useTranslation()
  const [saved, setSaved] = useState(false)
  const [exporting, setExporting] = useState(false)
  const { accessToken } = useAuthStore()

  // Exchange rates for smart rate suggestion
  const { rates, isStale, updatedAt } = useExchangeRates()

  // When user switches currency, we suggest an updated energy rate
  const [rateConvertSuggestion, setRateConvertSuggestion] = useState<{
    fromCurrency: string
    toCurrency:   string
    oldRate:      number
    newRate:      number
    exchangeRate: number
  } | null>(null)

  function save(partial: Partial<AppPreferences>) {
    // When currency changes, calculate a rate conversion suggestion
    if (partial.currency && partial.currency !== preferences.currency) {
      const fromCode = preferences.currency
      const toCode   = partial.currency
      const fromRate = fromCode === 'EUR' ? 1 : rates[fromCode]
      const toRate   = toCode   === 'EUR' ? 1 : rates[toCode]
      if (fromRate && toRate) {
        const exchangeRate = toRate / fromRate
        const newEnergyRate = Math.round(preferences.energyRate * exchangeRate * 100) / 100
        if (newEnergyRate !== preferences.energyRate) {
          setRateConvertSuggestion({
            fromCurrency: fromCode,
            toCurrency:   toCode,
            oldRate:      preferences.energyRate,
            newRate:      newEnergyRate,
            exchangeRate: Math.round(exchangeRate * 1000) / 1000,
          })
        }
      }
    }
    setPreferences(partial)
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }

  function applyRateSuggestion() {
    if (!rateConvertSuggestion) return
    // Update both the rate AND baseCurrency so future costs are computed in the new currency
    // (no further conversion will be applied — the new rate IS in the new currency)
    setPreferences({
      energyRate:   rateConvertSuggestion.newRate,
      baseCurrency: rateConvertSuggestion.toCurrency,
    })
    setRateConvertSuggestion(null)
  }

  async function handleExport() {
    if (!accessToken || exporting) return
    setExporting(true)
    try {
      const vehicles = await apiClient.getVehicles(accessToken)
      const allTrips = await Promise.all(
        vehicles.map((v: any) => apiClient.getTrips(v.id, 500, accessToken).then(r => r.data ?? r).catch(() => []))
      )
      const payload = vehicles.map((v: any, i: number) => ({ vehicle: v, trips: allTrips[i] }))
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `evpulse-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  const languages = [
    { code: 'en', label: 'English' },
    { code: 'de', label: 'Deutsch' },
    { code: 'ru', label: 'Русский' },
  ]

  const currencies = [
    { code: 'EUR', symbol: '€', label: 'Euro' },
    { code: 'USD', symbol: '$', label: 'US Dollar' },
    { code: 'GBP', symbol: '£', label: 'British Pound' },
    { code: 'CHF', symbol: 'CHF', label: 'Swiss Franc' },
  ]

  return (
    <div className="space-y-4 w-full">

      {saved && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
          <CheckCircle size={16} />
          {t('settings.preferences.saved')}
        </div>
      )}

      {/* AI Co-pilot */}
      <AIPreferencesSection />

      {/* Language */}
      <div className="spatial-card rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Languages size={18} className="text-brand-500" />
          <p className="text-base font-semibold text-foreground">{t('settings.preferences.language')}</p>
        </div>
        <select
          value={preferences.language ?? 'en'}
          onChange={(e) => save({ language: e.target.value })}
          className="w-full rounded-xl border border-[hsl(var(--border)/0.6)] bg-[hsl(var(--secondary)/0.4)] px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-brand-500/50 [color-scheme:dark]"
        >
          {languages.map(({ code, label }) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
      </div>

      {/* Date & Time */}
      <div className="spatial-card rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Calendar size={18} className="text-brand-500" />
          <p className="text-base font-semibold text-foreground">{t('settings.preferences.dateTime')}</p>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">{t('settings.preferences.dateFormat')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.preferences.dateFormatHint')}</p>
            </div>
            <SegmentedControl
              size="sm"
              value={(preferences.dateFormat ?? 'dmy') as 'dmy' | 'mdy' | 'ymd'}
              onChange={(v) => save({ dateFormat: v })}
              options={[
                { value: 'dmy', label: 'DD/MM' },
                { value: 'mdy', label: 'MM/DD' },
                { value: 'ymd', label: 'YYYY-MM' },
              ]}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">{t('settings.preferences.timeFormat')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.preferences.timeFormatHint')}</p>
            </div>
            <SegmentedControl
              size="sm"
              value={(preferences.timeFormat ?? '24h') as '24h' | '12h'}
              onChange={(v) => save({ timeFormat: v })}
              options={[
                { value: '24h', label: '24h' },
                { value: '12h', label: '12h' },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Energy & Cost */}
      <div className="spatial-card rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Euro size={18} className="text-brand-500" />
            <p className="text-base font-semibold text-foreground">{t('settings.preferences.energyCost')}</p>
          </div>
          {/* Exchange rate freshness indicator */}
          <span className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${
            isStale
              ? 'text-amber-400 bg-amber-500/8 border-amber-500/20'
              : 'text-emerald-400 bg-emerald-500/8 border-emerald-500/20'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isStale ? 'bg-amber-400' : 'bg-emerald-400'}`} />
            {isStale
              ? t('settings.preferences.ratesStale')
              : updatedAt
                ? t('settings.preferences.ratesUpdated', {
                    time: new Date(updatedAt).toLocaleTimeString(preferences.language || 'en', { hour: '2-digit', minute: '2-digit' }),
                  })
                : t('settings.preferences.exchangeRate')
            }
          </span>
        </div>

        {/* Rate conversion suggestion banner */}
        {rateConvertSuggestion && (
          <div className="mb-4 p-3 rounded-xl bg-sky-500/8 border border-sky-500/20 space-y-2">
            <p className="text-xs font-semibold text-sky-300">
              {t('settings.preferences.rateConvertTitle', { currency: rateConvertSuggestion.toCurrency })}
            </p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {t('settings.preferences.rateConvertHint', {
                oldRate:     `${rateConvertSuggestion.oldRate.toFixed(2)} ${rateConvertSuggestion.fromCurrency}`,
                oldCurrency: rateConvertSuggestion.fromCurrency,
                rate:        `1 ${rateConvertSuggestion.fromCurrency} = ${rateConvertSuggestion.exchangeRate} ${rateConvertSuggestion.toCurrency}`,
                newRate:     `${rateConvertSuggestion.newRate.toFixed(2)} ${rateConvertSuggestion.toCurrency}`,
              })}
            </p>
            <div className="flex gap-2">
              <button
                onClick={applyRateSuggestion}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-sky-500/15 border border-sky-500/30 text-sky-300 hover:bg-sky-500/25 transition font-medium"
              >
                <CheckCircle size={12} />
                {t('settings.preferences.rateConvertApply', { newRate: `${rateConvertSuggestion.newRate.toFixed(2)} ${rateConvertSuggestion.toCurrency}/kWh` })}
              </button>
              <button
                onClick={() => setRateConvertSuggestion(null)}
                className="text-xs px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition"
              >
                {t('settings.preferences.rateConvertKeep')}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t('settings.preferences.homeRate')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.preferences.homeRateHint')}</p>
            </div>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={2}
                step={0.01}
                value={preferences.energyRate}
                onChange={e => save({ energyRate: parseFloat(e.target.value) || 0 })}
                className="w-20 px-2 py-1.5 rounded-lg bg-[hsl(var(--secondary)/0.7)] border border-[hsl(var(--border)/0.75)] text-foreground text-sm text-right focus:border-brand-500/60 focus:outline-none"
              />
              <span className="text-muted-foreground text-sm">/kWh</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">{t('settings.preferences.currency')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.preferences.currencyHint')}</p>
            </div>
            <div className="flex bg-[hsl(var(--secondary)/0.5)] rounded-lg p-0.5">
              {currencies.map(({ code, symbol }) => (
                <button
                  key={code}
                  onClick={() => save({ currency: code })}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                    preferences.currency === code
                      ? 'bg-[hsl(var(--card))] text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {symbol}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Data & Privacy */}
      <div className="spatial-card rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Shield size={18} className="text-brand-500" />
          <p className="text-base font-semibold text-foreground">{t('settings.preferences.dataPrivacy')}</p>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 rounded-lg bg-[hsl(var(--secondary)/0.4)] border border-[hsl(var(--border)/0.6)]/40">
            <div>
              <p className="text-sm font-medium text-foreground">{t('settings.preferences.exportData')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.preferences.exportHint')}</p>
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[hsl(var(--secondary)/0.7)] border border-[hsl(var(--border)/0.75)] text-foreground hover:brightness-110 transition disabled:opacity-60"
            >
              {exporting ? <Loader size={12} className="animate-spin" /> : <Download size={12} />}
              {t('settings.preferences.export')}
            </button>
          </div>
        </div>
      </div>

    </div>
  )
}

/* ─── Appearance Tab ─────────────────────────────── */

const THEME_OPTIONS = [
  {
    id: 'dark',
    labelKey: 'dark',
    Icon: Moon,
    preview: {
      bg: 'bg-[hsl(var(--foreground))]',
      header: 'bg-[hsl(var(--card))]',
      cards: ['bg-[hsl(var(--secondary))]', 'bg-[hsl(var(--secondary))]', 'bg-[hsl(var(--secondary))]'],
    },
  },
  {
    id: 'light',
    labelKey: 'light',
    Icon: Sun,
    preview: {
      bg: 'bg-[hsl(var(--background))]',
      header: 'bg-[hsl(var(--card))]',
      cards: ['bg-[hsl(var(--secondary)/0.7)]', 'bg-[hsl(var(--secondary)/0.7)]', 'bg-[hsl(var(--secondary)/0.7)]'],
    },
  },
  {
    id: 'system',
    labelKey: 'system',
    Icon: Monitor,
    preview: {
      bg: 'bg-gradient-to-br from-[hsl(var(--foreground))] to-[hsl(var(--background))]',
      header: 'bg-gradient-to-r from-[hsl(var(--card))] to-[hsl(var(--secondary))]',
      cards: ['bg-[hsl(var(--secondary))]', 'bg-[hsl(var(--secondary)/0.8)]', 'bg-[hsl(var(--secondary)/0.65)]'],
    },
  },
] as const;

const ACCENT_OPTIONS: { id: AccentColor; label: string; tw: string; hex: string }[] = [
  { id: 'blue',    label: 'Blue',    tw: 'bg-blue-500',    hex: '#3b82f6' },
  { id: 'teal',    label: 'Teal',    tw: 'bg-teal-500',    hex: '#14b8a6' },
  { id: 'violet',  label: 'Violet',  tw: 'bg-violet-500',  hex: '#8b5cf6' },
  { id: 'emerald', label: 'Emerald', tw: 'bg-emerald-500', hex: '#10b981' },
  { id: 'amber',   label: 'Amber',   tw: 'bg-amber-500',   hex: '#f59e0b' },
  { id: 'sky',     label: 'Sky',     tw: 'bg-sky-500',     hex: '#0ea5e9' },
  { id: 'rose',    label: 'Rose',    tw: 'bg-rose-500',    hex: '#f43f5e' },
  { id: 'indigo',  label: 'Indigo',  tw: 'bg-indigo-500',  hex: '#6366f1' },
  { id: 'lime',    label: 'Lime',    tw: 'bg-lime-500',    hex: '#84cc16' },
];

function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  const { accent, setAccent, units, setUnits, tempUnits, setTempUnits } = useUIStore();
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-48 rounded-xl" />
        <div className="skeleton h-36 rounded-xl" />
        <div className="skeleton h-36 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* Theme */}
      <div className="spatial-card rounded-2xl p-5">
        <p className="text-base font-semibold text-foreground mb-1">{t('settings.appearance.theme')}</p>
        <p className="text-xs text-muted-foreground mb-4">{t('settings.appearance.themeHint')}</p>
        <SegmentedControl
          value={(theme ?? 'system') as 'dark' | 'light' | 'system'}
          onChange={setTheme}
          options={[
            { value: 'dark',   label: t('settings.appearance.dark'),   icon: <Moon size={14} /> },
            { value: 'light',  label: t('settings.appearance.light'),  icon: <Sun size={14} /> },
            { value: 'system', label: t('settings.appearance.system'), icon: <Monitor size={14} /> },
          ]}
        />
      </div>

      {/* Accent Color */}
      <div className="spatial-card rounded-2xl p-5">
        <p className="text-base font-semibold text-foreground mb-1">{t('settings.appearance.accentColor')}</p>
        <p className="text-xs text-muted-foreground mb-4">{t('settings.appearance.accentHint')}</p>
        <div className="flex gap-4 flex-wrap">
          {ACCENT_OPTIONS.map(({ id, label, tw, hex }) => {
            const active = accent === id;
            return (
              <button
                key={id}
                onClick={() => setAccent(id)}
                className="flex flex-col items-center justify-start gap-1.5 group"
              >
                <div className="h-10 flex items-center justify-center">
                  <div
                    className={`relative w-10 h-10 rounded-full ${tw} transition-all ring-2 ring-offset-2 ring-offset-[hsl(var(--background))] ${
                      active ? 'ring-current scale-110' : 'ring-transparent group-hover:scale-105'
                    }`}
                    style={active ? { boxShadow: `0 0 0 2px ${hex}` } : undefined}
                  >
                    {active && (
                      <CheckCircle size={14} className="absolute inset-0 m-auto text-white drop-shadow" />
                    )}
                  </div>
                </div>
                <span className={`text-xs leading-none font-medium ${active ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Units */}
      <div className="spatial-card rounded-2xl p-5">
        <p className="text-base font-semibold text-foreground mb-1">{t('settings.appearance.units')}</p>
        <p className="text-xs text-muted-foreground mb-4">{t('settings.appearance.unitsSubtitle')}</p>
        <div className="space-y-4">

          {/* Distance */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Ruler size={16} className="text-muted-foreground" />
              <div>
                <p className="text-sm font-medium text-foreground">{t('settings.appearance.distance')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.appearance.distanceHint')}</p>
              </div>
            </div>
            <SegmentedControl
              size="sm"
              options={[
                { value: 'metric', label: t('settings.appearance.metric') },
                { value: 'imperial', label: t('settings.appearance.imperial') },
              ]}
              value={units}
              onChange={setUnits}
            />
          </div>

          {/* Temperature — independent from distance */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Thermometer size={16} className="text-muted-foreground" />
              <div>
                <p className="text-sm font-medium text-foreground">{t('settings.appearance.temperature')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.appearance.temperatureHint')}</p>
              </div>
            </div>
            <SegmentedControl
              size="sm"
              options={[
                { value: 'celsius', label: t('settings.appearance.celsius') },
                { value: 'fahrenheit', label: t('settings.appearance.fahrenheit') },
              ]}
              value={tempUnits}
              onChange={setTempUnits}
            />
          </div>

        </div>
      </div>

    </div>
  );
}

/* ─── Billing Tab ────────────────────────────── */

const PLAN_LABELS: Record<string, { name: string; color: string; desc: string }> = {
  FREE:  { name: 'FREE',  color: 'text-muted-foreground', desc: '14 дней истории · 1 авто · базовая аналитика' },
  PRO:   { name: 'PRO',   color: 'text-brand-500',        desc: '1 год истории · AI-инсайты · до 2 авто' },
  FLEET: { name: 'FLEET', color: 'text-purple-400',       desc: '2 года истории · флит-дашборд · до 50 авто' },
};

function BillingTab() {
  const { t } = useTranslation()
  const { accessToken } = useAuthStore()
  const { plan, status, pastDue, isActive, limits } = useSubscription()
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  const [portalLoading, setPortalLoading] = useState(false)

  const planInfo = PLAN_LABELS[plan] ?? PLAN_LABELS.FREE

  async function openPortal() {
    setPortalLoading(true)
    try {
      const { url } = await apiClient.createPortalSession(accessToken ?? '')
      window.location.href = url
    } catch {
      setPortalLoading(false)
    }
  }

  return (
    <div className="space-y-4">

      {/* Past-due warning */}
      {pastDue && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle size={16} className="shrink-0" />
          <span>Платёж не прошёл. Доступ сохранён, но обновите карту чтобы избежать отключения.</span>
          <button onClick={openPortal} className="ml-auto text-xs underline underline-offset-2 whitespace-nowrap">
            Обновить карту →
          </button>
        </div>
      )}

      {/* Current plan card */}
      <div className="spatial-card rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Euro size={18} className="text-brand-500" />
          <p className="text-base font-semibold text-foreground">Текущий план</p>
        </div>

        <div className="flex items-center justify-between p-4 rounded-xl bg-[hsl(var(--secondary)/0.4)] border border-[hsl(var(--border)/0.5)]">
          <div>
            <div className="flex items-center gap-2">
              <span className={`text-lg font-bold ${planInfo.color}`}>{planInfo.name}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                isActive ? 'bg-green-500/15 text-green-500' : 'bg-[hsl(var(--secondary))] text-muted-foreground'
              }`}>
                {isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{planInfo.desc}</p>
          </div>

          {isActive && plan !== 'FREE' ? (
            <button
              onClick={openPortal}
              disabled={portalLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[hsl(var(--secondary)/0.7)] border border-[hsl(var(--border)/0.75)] text-foreground hover:brightness-110 transition disabled:opacity-60"
            >
              {portalLoading ? <Loader size={12} className="animate-spin" /> : <ExternalLink size={12} />}
              Управлять
            </button>
          ) : (
            <button
              onClick={() => setUpgradeOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-brand-500 text-white hover:bg-brand-600 transition"
            >
              <Zap size={12} />
              Upgrade
            </button>
          )}
        </div>
      </div>

      {/* Limits overview */}
      <div className="spatial-card rounded-2xl p-5">
        <p className="text-sm font-semibold text-foreground mb-3">Ваши лимиты</p>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'История поездок', value: `${limits.tripHistoryDays} дн` },
            { label: 'История зарядок', value: `${limits.chargingHistoryDays} дн` },
            { label: 'Аналитика',       value: `${limits.analyticsDepthDays} дн` },
            { label: 'Автомобилей',     value: `до ${limits.maxVehicles}` },
          ].map(({ label, value }) => (
            <div key={label} className="p-3 rounded-lg bg-[hsl(var(--secondary)/0.4)] border border-[hsl(var(--border)/0.4)]">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-sm font-semibold text-foreground mt-0.5">{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Plan comparison */}
      {plan === 'FREE' && (
        <div className="spatial-card rounded-2xl p-5 space-y-3">
          <p className="text-sm font-semibold text-foreground">Что открывает PRO</p>
          {[
            '1 год истории поездок и зарядок',
            'AI-инсайты: аномалии, range predictor, рекомендации',
            'Полная аналитика батареи с SOH трендами',
            'До 2 автомобилей на аккаунт',
          ].map((f) => (
            <div key={f} className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle size={14} className="text-brand-500 shrink-0" />
              {f}
            </div>
          ))}
          <button
            onClick={() => setUpgradeOpen(true)}
            className="w-full mt-1 py-2.5 rounded-xl text-sm font-medium bg-brand-500 text-white hover:bg-brand-600 transition flex items-center justify-center gap-2"
          >
            <Zap size={14} /> Перейти на PRO
          </button>
        </div>
      )}

      <UpgradeModal open={upgradeOpen} onOpenChange={setUpgradeOpen} defaultPlan="PRO" />
    </div>
  )
}

export default function SettingsPage() {

  const [activeTab, setActiveTab] = useState<SettingsTab>('profile')
  const { accessToken } = useAuthStore()
  const { t } = useTranslation()
  const tabs = TAB_DEFS.map(td => ({ ...td, label: t(`settings.tabs.${td.id}`) }))

  // Handle ?tab=vehicles&tesla=connected query params from OAuth callback
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const tabParam = params.get('tab') as SettingsTab | null
    const teslaParam = params.get('tesla')
    if (tabParam && TAB_DEFS.some(td => td.id === tabParam)) {
      setActiveTab(tabParam)
    }
    if (tabParam || teslaParam) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  function getTab() {

    switch (activeTab) {

      case 'profile':
        return <ProfileTab />

      case 'vehicles':
        return <VehiclesTab />

      case 'notifications':
        return <NotificationsTab />

      case 'security':
        return <SecurityTab onSwitchToProfile={() => setActiveTab('profile')} />

      case 'preferences':
        return <PreferencesTab />

      case 'appearance':
        return <AppearanceTab />

    }

  }

  return (

    <Page title={t('pages.settings.title')} subtitle={t('pages.settings.subtitle')}>

      <div className="flex gap-2 mb-6 overflow-x-auto pb-1 flex-shrink-0 scrollbar-hide">

        {tabs.map(tab => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id as SettingsTab)}
          />
        ))}

      </div>

      <div className="pb-24 md:pb-8 w-full max-w-6xl">
        {getTab()}
      </div>

    </Page>

  )

}