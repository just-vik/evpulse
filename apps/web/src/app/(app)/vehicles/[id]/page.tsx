'use client'

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import {
  Battery,
  Gauge,
  Thermometer,
  Wind,
  Lock,
  Unlock,
  Zap,
  ZapOff,
  ArrowLeft,
  Navigation,
  MapPin,
  Power,
  Lightbulb,
  Car,
  CarFront,
  CheckCircle2,
  XCircle,
  WifiOff,
  Plug,
  Eye,
  EyeOff,
  Shield,
  ShieldOff,
  Settings2,
  ChevronDown,
  ChevronUp,
  History,
  Star,
  Trash2,
  Plus,
  Camera,
  CameraOff,
  Sun,
  Megaphone,
  Package,
  ArrowUpFromLine,
  ArrowDownToLine,
} from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { apiClient } from '@/lib/api'
import type { CommandPreset, CommandHistoryItem } from '@/lib/api'
import { formatRelativeTime, getBatteryColor } from '@/lib/utils'
import type { TelemetryData } from '@/types/api'
import { useWebSocket } from '@/hooks/useWebSocket'
import { ErrorState } from '@/shared/ui/ErrorState'
import { LoadingState } from '@/shared/ui/LoadingState'

interface Vehicle {
  id: string; model: string; trim?: string; year?: number; vin: string; displayName?: string
}
interface Telemetry {
  soc?: number; speed?: number; power?: number; batteryTemp?: number
  outsideTemp?: number; insideTemp?: number; odometer?: number; timestamp?: string
  batteryRangeKm?: number | null; heading?: number; locked?: boolean
  vehicleState?: string
}
type ToastState = { type: 'success' | 'error'; text: string } | null

/* ─── Commands by group ──────────────────────────────────────── */
interface CmdDef {
  key: string; icon: React.ElementType; labelKey: string
  cmd: string; params?: Record<string, unknown>; loadingKey?: string
  colSpan?: number
}
interface CmdGroup {
  labelKey: string
  gridClass: string   // literal Tailwind class — must be static for purge
  color: string
  cmds: CmdDef[]
}
const CMD_GROUPS: CmdGroup[] = [
  {
    // Lock, Unlock, Sentry On/Off — 4 items → clean 2×2 grid
    labelKey: 'vehicleDetail.commandGroups.security',
    gridClass: 'grid-cols-2',
    color: '#f43f5e',
    cmds: [
      { key: 'lock',       icon: Lock,      labelKey: 'quickActions.lock',      cmd: 'lock'   },
      { key: 'unlock',     icon: Unlock,    labelKey: 'quickActions.unlock',    cmd: 'unlock' },
      { key: 'sentry-on',  icon: Camera,    labelKey: 'quickActions.sentryOn',  cmd: 'sentry', params: { on: true  }, loadingKey: 'sentry-on'  },
      { key: 'sentry-off', icon: CameraOff, labelKey: 'quickActions.sentryOff', cmd: 'sentry', params: { on: false }, loadingKey: 'sentry-off' },
    ],
  },
  {
    // Climate On/Off, Overheat On/Off — 4 items → clean 2×2 grid
    labelKey: 'vehicleDetail.commandGroups.climate',
    gridClass: 'grid-cols-2',
    color: '#06b6d4',
    cmds: [
      { key: 'climate-on',   icon: Wind,        labelKey: 'quickActions.climateOn',   cmd: 'climate',             params: { action: 'start' }, loadingKey: 'climate-on'   },
      { key: 'climate-off',  icon: Thermometer, labelKey: 'quickActions.climateOff',  cmd: 'climate',             params: { action: 'stop'  }, loadingKey: 'climate-off'  },
      { key: 'overheat-on',  icon: Sun,         labelKey: 'quickActions.overheatOn',  cmd: 'overheat-protection', params: { on: true  },       loadingKey: 'overheat-on'  },
      { key: 'overheat-off', icon: ShieldOff,   labelKey: 'quickActions.overheatOff', cmd: 'overheat-protection', params: { on: false },       loadingKey: 'overheat-off' },
    ],
  },
  {
    // Start/Stop Charging — 2 items → clean 1×2 grid
    labelKey: 'vehicleDetail.commandGroups.charging',
    gridClass: 'grid-cols-2',
    color: '#10b981',
    cmds: [
      { key: 'start-charging', icon: Plug,   labelKey: 'quickActions.startCharge', cmd: 'start-charging' },
      { key: 'stop-charging',  icon: ZapOff, labelKey: 'quickActions.stopCharge',  cmd: 'stop-charging'  },
    ],
  },
  {
    // Wake (full-row hero) + 6 signals → 1+6 in 3-col = 3 perfect rows
    labelKey: 'vehicleDetail.commandGroups.access',
    gridClass: 'grid-cols-3',
    color: '#f59e0b',
    cmds: [
      { key: 'wake',          icon: Zap,             labelKey: 'quickActions.wake',         cmd: 'wake',    colSpan: 3                                                     },
      { key: 'flash-lights',  icon: Lightbulb,       labelKey: 'quickActions.flash',        cmd: 'flash-lights'                                                            },
      { key: 'honk',          icon: Megaphone,       labelKey: 'quickActions.honk',         cmd: 'honk'                                                                    },
      { key: 'frunk',         icon: CarFront,        labelKey: 'quickActions.frunk',        cmd: 'frunk'                                                                   },
      { key: 'trunk',         icon: Package,         labelKey: 'quickActions.trunk',        cmd: 'trunk'                                                                   },
      { key: 'windows-vent',  icon: ArrowUpFromLine, labelKey: 'quickActions.windowsVent',  cmd: 'windows', params: { action: 'vent'  }, loadingKey: 'windows-vent'        },
      { key: 'windows-close', icon: ArrowDownToLine, labelKey: 'quickActions.windowsClose', cmd: 'windows', params: { action: 'close' }, loadingKey: 'windows-close'       },
    ],
  },
]
// flat list for index-based animation delay
const ALL_CMDS = CMD_GROUPS.flatMap(g => g.cmds)

// Maps backend-stored command strings → i18n keys
const CMD_LABEL_MAP: Record<string, string> = {
  'lock':                    'quickActions.lock',
  'unlock':                  'quickActions.unlock',
  'wake':                    'quickActions.wake',
  'sentry':                  'quickActions.sentryOn',
  'sentry-on':               'quickActions.sentryOn',
  'sentry-off':              'quickActions.sentryOff',
  'climate':                 'quickActions.climateOn',
  'climate-start':           'quickActions.climateOn',
  'climate-stop':            'quickActions.climateOff',
  'overheat-protection':     'quickActions.overheatOn',
  'overheat-protection-on':  'quickActions.overheatOn',
  'overheat-protection-off': 'quickActions.overheatOff',
  'start-charging':          'quickActions.startCharge',
  'stop-charging':           'quickActions.stopCharge',
  'flash-lights':            'quickActions.flash',
  'honk':                    'quickActions.honk',
  'frunk':                   'quickActions.frunk',
  'trunk':                   'quickActions.trunk',
  'windows':                 'quickActions.windowsVent',
  'windows-vent':            'quickActions.windowsVent',
  'windows-close':           'quickActions.windowsClose',
  'charge-limit':            'vehicleDetail.advanced.chargeLimit',
  'charging-amps':           'vehicleDetail.advanced.chargingAmps',
  'seat-heater':             'vehicleDetail.advanced.seatHeater',
  'scheduled-charging':      'vehicleDetail.advanced.scheduledCharging',
  'scheduled-departure':     'vehicleDetail.advanced.scheduledDeparture',
}

const SEAT_LABELS = ['quickActions.seatDriver', 'quickActions.seatPass', 'quickActions.seatRL', 'quickActions.seatRR']
const SEAT_IDS = [0, 1, 2, 3]

/* ─── Live Mini-Chart ────────────────────────────────────────── */
interface LivePoint { t: string; spd: number | null; pwr: number | null; soc: number | null }

function LiveMiniChart({ points }: { points: LivePoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || points.length < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)

    const drawLine = (
      vals: (number | null)[],
      color: string,
      minV: number,
      maxV: number,
    ) => {
      const range = maxV - minV || 1
      const valid = vals.map((v, i) => ({ v, i })).filter(x => x.v != null)
      if (valid.length < 2) return
      ctx.beginPath()
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      valid.forEach(({ v, i }, idx) => {
        const x = (i / (vals.length - 1)) * W
        const y = H - ((v! - minV) / range) * H * 0.85 - H * 0.075
        idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      })
      ctx.stroke()
    }

    const speeds = points.map(p => p.spd)
    const powers = points.map(p => p.pwr)
    const socs   = points.map(p => p.soc)

    const validSpeed = speeds.filter(v => v != null) as number[]
    const validPower = powers.filter(v => v != null) as number[]
    const validSoc   = socs.filter(v => v != null) as number[]

    if (validSpeed.length >= 2)
      drawLine(speeds, 'rgba(139,92,246,0.8)', 0, Math.max(...validSpeed, 10))
    if (validPower.length >= 2)
      drawLine(powers, 'rgba(245,158,11,0.7)', Math.min(...validPower, 0), Math.max(...validPower, 1))
    if (validSoc.length >= 2)
      drawLine(socs, 'rgba(52,211,153,0.65)', Math.min(...validSoc) - 2, Math.max(...validSoc) + 2)
  }, [points])

  if (points.length < 2) return null

  const lastPt = points[points.length - 1]
  const LEGEND = [
    { label: 'Spd', value: lastPt.spd != null ? `${Math.round(lastPt.spd)} km/h` : '—', color: '#8b5cf6' },
    { label: 'Pwr', value: lastPt.pwr != null ? `${lastPt.pwr.toFixed(1)} kW` : '—',   color: '#f59e0b' },
    { label: 'SoC', value: lastPt.soc != null ? `${Math.round(lastPt.soc)}%` : '—',     color: '#34d399' },
  ]

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="p-4 rounded-2xl bg-[hsl(var(--card))] border border-[hsl(var(--border)/0.7)]"
    >
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Live · 30 min</p>
        <div className="flex items-center gap-3">
          {LEGEND.map(l => (
            <span key={l.label} className="text-[11px] font-medium" style={{ color: l.color }}>
              {l.label} <span className="text-foreground">{l.value}</span>
            </span>
          ))}
        </div>
      </div>
      <canvas ref={canvasRef} width={600} height={72} className="w-full h-[72px]" />
    </motion.div>
  )
}

/* ─── Battery Arc ────────────────────────────────────────────── */
function BatteryArc({ pct, label }: { pct: number; label: string }) {
  const R = 52, circ = 2 * Math.PI * R, arc = circ * 0.75
  const offset = arc - (arc * pct) / 100
  const color = getBatteryColor(pct)
  return (
    <svg width="140" height="140" viewBox="0 0 140 140">
      <circle cx="70" cy="70" r={R} fill="none" stroke="hsl(var(--border))" strokeWidth="9"
        strokeDasharray={`${arc} ${circ}`} strokeDashoffset={-circ * 0.125}
        strokeLinecap="round" transform="rotate(-135 70 70)" />
      <motion.circle cx="70" cy="70" r={R} fill="none" stroke={color} strokeWidth="9"
        strokeDasharray={`${arc} ${circ}`}
        initial={{ strokeDashoffset: arc }} animate={{ strokeDashoffset: offset }}
        transition={{ duration: 1.2, ease: 'easeOut' }}
        strokeLinecap="round" transform="rotate(-135 70 70)"
        style={{ filter: `drop-shadow(0 0 6px ${color}60)` }} />
      <text x="70" y="64" textAnchor="middle" fill="hsl(var(--foreground))" fontSize="26" fontWeight="700" fontFamily="Inter">{pct}%</text>
      <text x="70" y="81" textAnchor="middle" fill="hsl(var(--muted-foreground))" fontSize="11" fontFamily="Inter">{label}</text>
    </svg>
  )
}

/* ─── Stat tile ──────────────────────────────────────────────── */
function Stat({ icon: Icon, label, value, unit, color }: {
  icon: React.ElementType; label: string; value?: string | number; unit?: string; color: string
}) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      className="p-4 rounded-2xl bg-[hsl(var(--card))] border border-[hsl(var(--border)/0.7)] flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${color}18` }}>
        <Icon size={17} style={{ color }} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
        <p className="text-lg font-bold text-foreground leading-tight">
          {value ?? '—'}
          {unit && <span className="text-sm font-normal text-muted-foreground ml-1">{unit}</span>}
        </p>
      </div>
    </motion.div>
  )
}

/* ─── Command button ─────────────────────────────────────────── */
function CmdBtn({ icon: Icon, label, onClick, loading, disabled, index = 0, groupColor = '#6366f1', fullWidth = false }: {
  icon: React.ElementType; label: string; onClick: () => void
  loading?: boolean; disabled?: boolean; index?: number; groupColor?: string; fullWidth?: boolean
}) {
  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.88 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: index * 0.035, type: 'spring', stiffness: 340, damping: 26 }}
      whileHover={{ y: -2, transition: { duration: 0.13 } }}
      whileTap={{ scale: 0.91 }}
      onClick={onClick}
      disabled={loading || disabled}
      className={`group flex items-center justify-center gap-3 rounded-2xl border w-full
                 bg-[hsl(var(--card))] border-[hsl(var(--border)/0.45)]
                 hover:border-[hsl(var(--border)/0.9)]
                 transition-all duration-200 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer
                 ${fullWidth ? 'px-5 py-3 flex-row' : 'flex-col p-2 pt-3.5 pb-3'}`}
      style={{ minHeight: 86 }}
    >
      <span
        className="rounded-2xl flex items-center justify-center shrink-0 transition-all duration-200"
        style={{
          background: `${groupColor}18`,
          boxShadow: `0 0 0 1px ${groupColor}20`,
          width: fullWidth ? 44 : 44,
          height: fullWidth ? 44 : 44,
        }}
      >
        {loading
          ? <span className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: `${groupColor}60`, borderTopColor: 'transparent' }} />
          : <Icon size={fullWidth ? 21 : 19} style={{ color: groupColor }} />
        }
      </span>
      <span className={`font-medium text-muted-foreground group-hover:text-foreground transition-colors leading-tight
                       ${fullWidth ? 'text-sm flex-1 text-left' : 'text-[10px] text-center w-full px-1 line-clamp-2'}`}
        style={fullWidth ? undefined : { hyphens: 'auto', wordBreak: 'break-word' }} lang="ru">
        {label}
      </span>
      {fullWidth && (
        <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-lg border"
          style={{ color: groupColor, borderColor: `${groupColor}30`, background: `${groupColor}12` }}>
          {loading ? '…' : '→'}
        </span>
      )}
    </motion.button>
  )
}

/* ─── Mobile sticky action bar ──────────────────────────────── */
interface StickyBtnProps {
  icon: React.ElementType; label: string; cmd: string
  params?: Record<string, unknown>; loadingKey?: string
  cmdLoading: string | null; isAsleep: boolean
  onSend: (cmd: string, params?: Record<string, unknown>, lk?: string) => void
}
function StickyBtn({ icon: Icon, label, cmd, params, loadingKey, cmdLoading, isAsleep, onSend }: StickyBtnProps) {
  const isLoading = cmdLoading === (loadingKey ?? cmd)
  const disabled = isLoading || (isAsleep && cmd !== 'wake')
  return (
    <button
      onClick={() => onSend(cmd, params ?? {}, loadingKey)}
      disabled={disabled}
      className="flex flex-col items-center justify-center gap-1 py-2 rounded-xl transition-colors active:scale-95
                 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-white/8">
        {isLoading
          ? <span className="w-4 h-4 border-2 border-t-transparent border-muted-foreground/60 rounded-full animate-spin" />
          : <Icon size={16} className="text-muted-foreground" />}
      </span>
      <span className="text-[9px] font-medium leading-tight text-center text-muted-foreground">{label}</span>
    </button>
  )
}

/* ─── VIN display with reveal toggle ────────────────────────── */
function VinDisplay({ vin }: { vin: string }) {
  const [revealed, setRevealed] = useState(false)
  const masked = `···${vin.slice(-7)}`
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); setRevealed(v => !v) }}
      className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      title={revealed ? 'Скрыть VIN' : 'Показать VIN'}
    >
      {revealed ? vin : masked}
      {revealed
        ? <EyeOff size={10} className="shrink-0 opacity-50" />
        : <Eye size={10} className="shrink-0 opacity-50" />}
    </button>
  )
}

/* ─── Toast ──────────────────────────────────────────────────── */
function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onDismiss, 3500)
    return () => clearTimeout(t)
  }, [toast, onDismiss])

  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.97 }}
          transition={{ duration: 0.18, type: 'spring', stiffness: 400, damping: 30 }}
          className={`fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 z-50
            flex items-center gap-2.5 px-4 py-3 rounded-2xl shadow-2xl border text-sm font-medium whitespace-nowrap
            ${toast.type === 'success'
              ? 'bg-emerald-950/95 border-emerald-500/25 text-emerald-300'
              : 'bg-red-950/95 border-red-500/25 text-red-300'}`}
        >
          {toast.type === 'success' ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
          {toast.text}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ─── Page ───────────────────────────────────────────────────── */
export default function VehicleDetailPage() {
  const { id: vehicleId } = useParams() as { id: string }
  const { accessToken } = useAuthStore()
  const { t, i18n } = useTranslation()

  const [vehicle,    setVehicle]    = useState<Vehicle | null>(null)
  const [telemetry,  setTelemetry]  = useState<Telemetry | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const [cmdLoading, setCmdLoading] = useState<string | null>(null)
  const [toast,      setToast]      = useState<ToastState>(null)
  const lastCmdAtRef = useRef<number>(0)
  const cancelled = useRef(false)
  const { connect, subscribeVehicle, unsubscribeVehicle, on, off } = useWebSocket({ autoConnect: true })

  // Command presets & history
  const [presets,           setPresets]           = useState<CommandPreset[]>([])
  const [showNewPreset,     setShowNewPreset]      = useState(false)
  const [newPresetName,     setNewPresetName]      = useState('')
  const [newPresetCmd,      setNewPresetCmd]       = useState('lock')
  const [savingPreset,      setSavingPreset]       = useState(false)
  const [historyItems,      setHistoryItems]       = useState<CommandHistoryItem[]>([])
  const [historyOpen,       setHistoryOpen]        = useState(false)
  const [historyLoaded,     setHistoryLoaded]      = useState(false)

  // Live mini-chart
  const [livePoints, setLivePoints] = useState<LivePoint[]>([])

  // Advanced settings state
  const [showAdvanced,      setShowAdvanced]      = useState(false)
  const [chargeLimit,       setChargeLimit]       = useState(80)
  const [chargingAmps,      setChargingAmps]      = useState(16)
  const [seatSeat,          setSeatSeat]          = useState(0)
  const [seatLevel,         setSeatLevel]         = useState(0)
  const [schedChargingTime, setSchedChargingTime] = useState('23:00')
  const [schedDepartureTime,setSchedDepartureTime]= useState('07:00')

  const showToast = (type: 'success' | 'error', text: string) => setToast({ type, text })

  const applyTelemetryPayload = useCallback((raw: Record<string, unknown>) => {
    setTelemetry(prev => ({
      ...prev,
      soc:            (raw.soc            as number | null) ?? prev?.soc,
      speed:          (raw.speed          as number | null) ?? prev?.speed,
      power:          (raw.power          as number | null) ?? prev?.power,
      batteryTemp:    (raw.batteryTemp    as number | null) ?? prev?.batteryTemp,
      outsideTemp:    (raw.outsideTemp    as number | null) ?? prev?.outsideTemp,
      insideTemp:     (raw.insideTemp     as number | null) ?? prev?.insideTemp,
      odometer:       (raw.odometer       as number | null) ?? prev?.odometer,
      batteryRangeKm: (raw.batteryRangeKm as number | null) ?? prev?.batteryRangeKm,
      heading:        (raw.heading        as number | null) ?? prev?.heading,
      locked:         (raw.locked         as boolean | null) ?? prev?.locked,
      vehicleState:   (raw.vehicleState   as string | null) ?? prev?.vehicleState,
      timestamp:      (raw.lastUpdate     as string | null) ?? (raw.timestamp as string | null) ?? prev?.timestamp,
    }))
  }, [])

  const loadTelemetry = useCallback(async () => {
    if (!accessToken || !vehicleId || cancelled.current) return
    try {
      const data = await apiClient.getLatestTelemetry(vehicleId, accessToken)
      if (cancelled.current) return
      applyTelemetryPayload(data as unknown as Record<string, unknown>)
    } catch { /* silent */ }
  }, [vehicleId, accessToken, applyTelemetryPayload])

  useEffect(() => {
    cancelled.current = false
    if (!vehicleId || !accessToken) { setLoading(true); return }
    Promise.all([
      apiClient.getVehicle(vehicleId, accessToken).then(d => setVehicle(d as Vehicle)),
      loadTelemetry(),
    ]).catch(e => setError(e.message)).finally(() => setLoading(false))
    const iv = setInterval(loadTelemetry, 15_000)
    return () => { cancelled.current = true; clearInterval(iv) }
  }, [vehicleId, accessToken, loadTelemetry])

  useEffect(() => {
    if (!accessToken || !vehicleId) return
    connect()
    subscribeVehicle(vehicleId)
    const onTelemetry = ({ data }: { data: Record<string, unknown> }) => applyTelemetryPayload(data)
    const onVehicleUpdate = ({ data }: { data: Record<string, unknown> }) => {
      const normalized = { ...data }
      if (data.state && !data.vehicleState) normalized.vehicleState = data.state
      applyTelemetryPayload(normalized)
    }
    on('telemetry', onTelemetry)
    on('vehicle:update', onVehicleUpdate)
    return () => {
      off('telemetry', onTelemetry)
      off('vehicle:update', onVehicleUpdate)
      unsubscribeVehicle(vehicleId)
    }
  }, [accessToken, vehicleId, applyTelemetryPayload, connect, subscribeVehicle, unsubscribeVehicle, on, off])

  useEffect(() => {
    if (!vehicleId || !accessToken) return
    const fetchLive = () => {
      apiClient.getLiveTelemetry(vehicleId, accessToken, 30, 120)
        .then(r => setLivePoints(r.points))
        .catch(() => {})
    }
    fetchLive()
    const iv = setInterval(fetchLive, 30_000)
    return () => clearInterval(iv)
  }, [vehicleId, accessToken])

  useEffect(() => {
    if (!vehicleId || !accessToken) return
    apiClient.getCommandPresets(vehicleId, accessToken).then(setPresets).catch(() => {})
  }, [vehicleId, accessToken])

  useEffect(() => {
    if (!historyOpen || historyLoaded || !vehicleId || !accessToken) return
    setHistoryLoaded(true)
    apiClient.getCommandHistory(vehicleId, 20, accessToken).then(setHistoryItems).catch(() => {})
  }, [historyOpen, historyLoaded, vehicleId, accessToken])

  const savePreset = async () => {
    if (!newPresetName.trim() || !accessToken) return
    setSavingPreset(true)
    try {
      const preset = await apiClient.createCommandPreset({ vehicleId, name: newPresetName.trim(), command: newPresetCmd }, accessToken)
      setPresets(p => [...p, preset])
      setShowNewPreset(false)
      setNewPresetName('')
    } catch { /* silent */ }
    setSavingPreset(false)
  }

  const deletePreset = async (id: string) => {
    if (!accessToken) return
    setPresets(p => p.filter(x => x.id !== id))
    apiClient.deleteCommandPreset(id, accessToken).catch(() => {})
  }

  const runPreset = (preset: CommandPreset) => {
    sendCmd(preset.command, (preset.params as Record<string, unknown>) ?? {})
  }

  const applyOptimistic = (cmd: string, params: Record<string, unknown>): Telemetry | null => {
    const snap = telemetry ? { ...telemetry } : null
    setTelemetry(prev => {
      if (!prev) return prev
      switch (cmd) {
        case 'lock':           return { ...prev, locked: true }
        case 'unlock':         return { ...prev, locked: false }
        case 'wake':           return { ...prev, vehicleState: 'online' }
        case 'climate':
          return { ...prev, vehicleState: params.action === 'start' ? 'conditioning' : prev.vehicleState }
        case 'start-charging': return { ...prev, vehicleState: 'charging' }
        case 'stop-charging':  return { ...prev, vehicleState: 'online' }
        default:               return prev
      }
    })
    return snap
  }

  const sendCmd = async (cmd: string, params: Record<string, unknown> = {}, loadingKey?: string) => {
    if (!accessToken || !vehicleId) return
    const state = String(telemetry?.vehicleState ?? '').toLowerCase()
    const isAsleepNow = state === 'sleeping' || state === 'asleep' || state === 'offline'
    const isWakeCmd = cmd === 'wake'

    if (isAsleepNow && !isWakeCmd) {
      showToast('error', t('vehicleDetail.commands.asleep'))
      return
    }

    const now = Date.now()
    if (now - lastCmdAtRef.current < 1200) {
      showToast('error', 'Слишком часто: подождите 1-2 секунды')
      return
    }
    lastCmdAtRef.current = now

    const key = loadingKey ?? cmd
    setCmdLoading(key)
    const snapshot = applyOptimistic(cmd, params)
    try {
      await apiClient.sendVehicleCommand(vehicleId, cmd, params, accessToken)
      showToast('success', t('vehicleDetail.commands.success'))
    } catch (err: any) {
      // Rollback optimistic update on failure
      if (snapshot !== null) setTelemetry(snapshot)
      const status = Number(err?.status ?? 0)
      const raw: string = err?.message ?? ''
      const low = raw.toLowerCase()
      let toastMsg: string
      if (status === 429) {
        toastMsg = 'Слишком много команд за короткое время'
      } else if (low.includes('sleep') || low.includes('asleep') || low.includes('unavailable') || low.includes('offline')) {
        toastMsg = t('vehicleDetail.commands.asleep')
      } else if (status === 503) {
        toastMsg = t('vehicleDetail.commands.asleep')
      } else if (low.includes('circuit open')) {
        toastMsg = t('vehicleDetail.commands.circuitOpen')
      } else if (low.includes('timeout') || low.includes('timed out')) {
        toastMsg = t('vehicleDetail.commands.timeout')
      } else if (raw.length > 0 && raw.length < 120) {
        toastMsg = raw
      } else {
        toastMsg = t('vehicleDetail.commands.failed')
      }
      showToast('error', toastMsg)
    } finally {
      setCmdLoading(null)
    }
  }

  const timeToMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }

  if (loading) return <LoadingState className="h-64 py-0" />
  if (error) return (
    <div className="pt-8 max-w-2xl mx-auto">
      <ErrorState message={error} className="rounded-2xl" />
    </div>
  )

  const soc = telemetry?.soc != null ? Math.round(+telemetry.soc) : 0
  const SLEEP_STATES = new Set(['sleeping', 'Sleeping', 'offline', 'Offline'])
  const isAsleep = telemetry != null && SLEEP_STATES.has(telemetry.vehicleState ?? '')

  return (
    <>
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {/* Mobile sticky action bar */}
      <div className="fixed bottom-0 inset-x-0 z-40 lg:hidden pointer-events-none">
        <AnimatePresence>
          {!loading && (
            <motion.div
              initial={{ y: 80, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 80, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 340, damping: 32 }}
              className="pointer-events-auto mx-3 mb-3 rounded-2xl overflow-hidden"
              style={{ background: 'hsl(var(--card) / 0.92)', backdropFilter: 'blur(16px)', border: '1px solid hsl(var(--border) / 0.5)', boxShadow: '0 -4px 32px rgba(0,0,0,0.35)' }}
            >
              <div className="grid grid-cols-5 gap-1 px-2 py-2">
                <StickyBtn
                  icon={telemetry?.locked === true ? Unlock : Lock}
                  label={telemetry?.locked === true ? t('quickActions.unlock') : t('quickActions.lock')}
                  cmd={telemetry?.locked === true ? 'unlock' : 'lock'}
                  cmdLoading={cmdLoading} isAsleep={isAsleep} onSend={sendCmd}
                />
                <StickyBtn
                  icon={Wind} label={t('quickActions.climateOn')} cmd="climate" params={{ action: 'start' }} loadingKey="climate-on"
                  cmdLoading={cmdLoading} isAsleep={isAsleep} onSend={sendCmd}
                />
                <StickyBtn
                  icon={Plug} label={t('quickActions.startCharge')} cmd="start-charging"
                  cmdLoading={cmdLoading} isAsleep={isAsleep} onSend={sendCmd}
                />
                <StickyBtn
                  icon={Eye} label={t('quickActions.sentryOn')} cmd="sentry" params={{ on: true }} loadingKey="sentry-on"
                  cmdLoading={cmdLoading} isAsleep={isAsleep} onSend={sendCmd}
                />
                <StickyBtn
                  icon={Power} label={t('quickActions.wake')} cmd="wake"
                  cmdLoading={cmdLoading} isAsleep={false} onSend={sendCmd}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="pt-3 pb-28 lg:pb-6 space-y-4 max-w-2xl mx-auto lg:max-w-4xl">

        {/* Breadcrumb */}
        <div className="flex items-center gap-3 py-1">
          <Link href="/vehicles" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft size={16} />
            {t('nav.vehicles')}
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <h1 className="text-base font-semibold text-foreground truncate">
            {vehicle?.displayName ?? `${vehicle?.model ?? ''} ${vehicle?.trim ?? ''}`}
          </h1>
          {telemetry?.timestamp && (
            <span className="text-xs text-muted-foreground shrink-0 ml-auto">
              {formatRelativeTime(telemetry.timestamp, i18n.language)}
            </span>
          )}
        </div>

        {/* Hero */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          className="relative overflow-hidden p-5 rounded-2xl border border-[hsl(var(--border)/0.6)] flex flex-col sm:flex-row items-center gap-5"
          style={{ background: 'linear-gradient(135deg, hsl(var(--card)) 0%, color-mix(in srgb, var(--a-500) 4%, hsl(var(--card))) 100%)' }}
        >
          <div className="absolute -top-20 -right-20 w-56 h-56 rounded-full pointer-events-none"
            style={{ background: `${getBatteryColor(soc)}06`, filter: 'blur(48px)' }} />
          <BatteryArc pct={soc} label={t('vehicleStatus.battery')} />
          <div className="flex-1 w-full space-y-3">
            <div>
              <p className="text-lg font-bold text-foreground">
                {vehicle?.displayName ?? `${vehicle?.model} ${vehicle?.trim ?? ''}`}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                {vehicle?.year}{vehicle?.year && vehicle?.vin ? ' · ' : ''}
                {vehicle?.vin ? <><span>VIN:</span><VinDisplay vin={vehicle.vin} /></> : ''}
              </p>
            </div>

            {isAsleep && (
              <div className="flex items-center gap-2 p-2.5 rounded-xl bg-amber-500/8 border border-amber-500/20">
                <WifiOff size={14} className="text-amber-400 shrink-0" />
                <span className="text-xs text-amber-300/80">
                  {t('vehicleDetail.possiblyAsleep')}
                </span>
              </div>
            )}

            {telemetry?.batteryRangeKm != null && (
              <div className="flex items-center gap-2 p-3 rounded-xl"
                style={{ background: 'color-mix(in srgb, var(--a-500) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--a-500) 18%, transparent)' }}>
                <Navigation size={15} style={{ color: 'var(--a-500)' }} />
                <span className="text-sm font-semibold text-foreground">{Math.round(+telemetry.batteryRangeKm)} km</span>
                <span className="text-xs text-muted-foreground">{t('vehicleDetail.estimatedRange')}</span>
              </div>
            )}

            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{t('vehicleDetail.batteryLevel')}</span>
                <span>{soc}%</span>
              </div>
              <div className="h-2 bg-[hsl(var(--secondary)/0.6)] rounded-full overflow-hidden">
                <motion.div className="h-full rounded-full"
                  initial={{ width: 0 }} animate={{ width: `${soc}%` }}
                  transition={{ duration: 1, ease: 'easeOut' }}
                  style={{ background: getBatteryColor(soc), boxShadow: `0 0 8px ${getBatteryColor(soc)}50` }} />
              </div>
            </div>
          </div>
        </motion.div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <Stat icon={Gauge}       label={t('vehicleStatus.speed')}       value={telemetry?.speed}                                                             unit="km/h" color="#8b5cf6" />
          <Stat icon={Power}       label={t('vehicleStatus.power')}       value={telemetry?.power != null ? telemetry.power.toFixed(1) : undefined}            unit="kW"   color="#f59e0b" />
          <Stat icon={Thermometer} label={t('vehicleStatus.insideTemp')}  value={telemetry?.insideTemp != null ? telemetry.insideTemp.toFixed(1) : undefined}  unit="°C"   color="#ef4444" />
          <Stat icon={Thermometer} label={t('vehicleStatus.outsideTemp')} value={telemetry?.outsideTemp != null ? telemetry.outsideTemp.toFixed(1) : undefined} unit="°C"   color="#06b6d4" />
          <Stat icon={MapPin}      label={t('vehicleStatus.odometer')}    value={telemetry?.odometer != null ? Math.round(+telemetry.odometer).toLocaleString() : undefined} unit="km" color="#10b981" />
          {telemetry?.batteryTemp != null && (
            <Stat icon={Battery}   label={t('vehicleStatus.batteryTemp')} value={telemetry.batteryTemp.toFixed(1)} unit="°C" color="#3b82f6" />
          )}
        </div>

        {/* Live mini-chart */}
        {livePoints.length >= 2 && <LiveMiniChart points={livePoints} />}

        {/* Commands — 4 semantic groups */}
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">{t('vehicleDetail.commandsTitle')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {CMD_GROUPS.map((group) => (
              <div
                key={group.labelKey}
                className="rounded-2xl border border-[hsl(var(--border)/0.5)] overflow-hidden"
                style={{ background: 'hsl(var(--card))' }}
              >
                {/* Group header */}
                <div
                  className="flex items-center gap-2 px-4 py-2.5 border-b border-[hsl(var(--border)/0.35)]"
                  style={{ background: `${group.color}0a` }}
                >
                  <span className="w-1.5 h-4 rounded-full shrink-0" style={{ background: group.color }} />
                  <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: group.color }}>
                    {t(group.labelKey)}
                  </p>
                </div>
                {/* Buttons grid */}
                <div className={`grid gap-2 p-3 ${group.gridClass}`}>
                  {group.cmds.map((cmd) => (
                    <div key={cmd.key} style={cmd.colSpan ? { gridColumn: `span ${cmd.colSpan}` } : undefined}>
                      <CmdBtn
                        icon={cmd.icon}
                        label={t(cmd.labelKey)}
                        loading={cmdLoading === (cmd.loadingKey ?? cmd.cmd)}
                        disabled={isAsleep && cmd.cmd !== 'wake'}
                        onClick={() => sendCmd(cmd.cmd, cmd.params ?? {}, cmd.loadingKey)}
                        index={ALL_CMDS.indexOf(cmd)}
                        groupColor={group.color}
                        fullWidth={!!cmd.colSpan}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Command Presets */}
        <div className="p-4 rounded-2xl bg-[hsl(var(--card))] border border-[hsl(var(--border)/0.7)] space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Star size={14} className="text-amber-400" />
              {t('vehicleDetail.presets.title')}
            </h2>
            <button
              onClick={() => setShowNewPreset(v => !v)}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-lg hover:bg-[hsl(var(--accent)/0.08)]"
            >
              <Plus size={13} />
              {t('vehicleDetail.presets.add')}
            </button>
          </div>

          {/* New preset form */}
          <AnimatePresence initial={false}>
            {showNewPreset && (
              <motion.div
                initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}
                className="overflow-hidden"
              >
                <div className="flex flex-col sm:flex-row gap-2 pt-1">
                  <input
                    value={newPresetName}
                    onChange={e => setNewPresetName(e.target.value)}
                    placeholder={t('vehicleDetail.presets.namePlaceholder')}
                    className="flex-1 bg-[hsl(var(--secondary)/0.5)] border border-[hsl(var(--border)/0.5)] rounded-lg px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-violet-500/50"
                    onKeyDown={e => e.key === 'Enter' && savePreset()}
                  />
                  <select
                    value={newPresetCmd}
                    onChange={e => setNewPresetCmd(e.target.value)}
                    className="bg-[hsl(var(--secondary)/0.5)] border border-[hsl(var(--border)/0.5)] rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none"
                  >
                    {CMD_GROUPS.flatMap(g => g.cmds).map(c => (
                      <option key={c.key} value={c.cmd}>{t(c.labelKey)}</option>
                    ))}
                  </select>
                  <button
                    onClick={savePreset}
                    disabled={!newPresetName.trim() || savingPreset}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 transition-colors disabled:opacity-40 shrink-0"
                  >
                    {savingPreset
                      ? <span className="w-3.5 h-3.5 border border-t-transparent border-violet-400 rounded-full animate-spin inline-block" />
                      : t('vehicleDetail.presets.save')}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Preset chips */}
          {presets.length === 0 && !showNewPreset ? (
            <div className="flex flex-col items-center py-5 text-center gap-1.5">
              <span className="text-2xl opacity-40">⚡</span>
              <p className="text-xs text-muted-foreground/60">{t('vehicleDetail.presets.empty')}</p>
              <p className="text-[11px] text-muted-foreground/35">Сохрани команду для быстрого доступа</p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {presets.map(p => (
                <div key={p.id} className="group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-xl border border-[hsl(var(--border)/0.6)] bg-[hsl(var(--secondary)/0.35)] hover:border-[hsl(var(--border)/0.9)] transition-colors">
                  <button
                    onClick={() => runPreset(p)}
                    disabled={isAsleep && p.command !== 'wake'}
                    className="text-xs font-medium text-foreground disabled:opacity-40"
                  >
                    {p.name}
                  </button>
                  <button
                    onClick={() => deletePreset(p.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/60 hover:text-red-400 p-0.5 rounded"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Command History */}
        <div className="rounded-2xl bg-[hsl(var(--card))] border border-[hsl(var(--border)/0.7)] overflow-hidden">
          <button
            onClick={() => setHistoryOpen(v => !v)}
            className="flex items-center justify-between w-full px-4 py-3.5 cursor-pointer hover:bg-[hsl(var(--accent)/0.04)] transition-colors"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <History size={15} className="text-muted-foreground" />
              {t('vehicleDetail.history.title')}
            </span>
            {historyOpen ? <ChevronUp size={15} className="text-muted-foreground" /> : <ChevronDown size={15} className="text-muted-foreground" />}
          </button>
          <AnimatePresence initial={false}>
            {historyOpen && (
              <motion.div
                key="history"
                initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: 'easeInOut' }}
                className="overflow-hidden"
              >
                <div className="border-t border-[hsl(var(--border)/0.5)]">
                  {historyItems.length === 0 ? (
                    <p className="px-4 py-4 text-xs text-muted-foreground">
                      {t('vehicleDetail.history.empty')}
                    </p>
                  ) : (
                    <div className="divide-y divide-[hsl(var(--border)/0.35)]">
                      {historyItems.map(h => {
                        const labelKey = CMD_LABEL_MAP[h.command]
                        const label = labelKey ? t(labelKey) : h.command
                        return (
                          <div key={h.id} className="flex items-center justify-between px-4 py-2.5 gap-3">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${h.status === 'success' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                              <span className="text-xs font-medium text-foreground truncate">{label}</span>
                              {h.error && <span className="text-xs text-red-400/80 truncate">{h.error.slice(0, 50)}</span>}
                            </div>
                            <span className="text-[10px] text-muted-foreground shrink-0">{formatRelativeTime(h.executedAt, i18n.language)}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Advanced settings — charge limit, amps, seat heater, schedules */}
        <div className="rounded-2xl border border-[hsl(var(--border)/0.5)] overflow-hidden" style={{ background: 'hsl(var(--card))' }}>
          <button
            onClick={() => setShowAdvanced(v => !v)}
            className="flex items-center justify-between w-full px-4 py-3.5 cursor-pointer hover:bg-white/[0.02] transition-colors"
          >
            <span className="flex items-center gap-2.5 text-sm font-semibold text-foreground">
              <span className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--a-500) 12%, transparent)' }}>
                <Settings2 size={14} style={{ color: 'var(--a-500)' }} />
              </span>
              {t('vehicleDetail.advanced.title')}
            </span>
            {showAdvanced
              ? <ChevronUp size={15} className="text-muted-foreground" />
              : <ChevronDown size={15} className="text-muted-foreground" />}
          </button>

          <AnimatePresence initial={false}>
            {showAdvanced && (
              <motion.div
                key="advanced"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: 'easeInOut' }}
                className="overflow-hidden"
              >
                <div className="px-4 pb-4 space-y-3 border-t border-[hsl(var(--border)/0.4)] pt-4">

                  {/* Charge limit */}
                  <div className="rounded-xl border border-[hsl(var(--border)/0.4)] p-3 space-y-2.5" style={{ background: '#10b98110' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-emerald-400">{t('vehicleDetail.advanced.chargeLimit')}</span>
                      <span className="text-sm font-bold text-foreground tabular-nums">{chargeLimit}%</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range" min={50} max={100} step={5} value={chargeLimit}
                        onChange={e => setChargeLimit(+e.target.value)}
                        className="flex-1 h-1.5 cursor-pointer accent-emerald-400"
                        disabled={isAsleep}
                      />
                      <button
                        onClick={() => sendCmd('charge-limit', { percent: chargeLimit }, 'charge-limit')}
                        disabled={isAsleep || cmdLoading === 'charge-limit'}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                        style={{ background: '#10b98120', color: '#10b981' }}
                      >
                        {cmdLoading === 'charge-limit'
                          ? <span className="w-3.5 h-3.5 border border-t-transparent border-emerald-400 rounded-full animate-spin inline-block" />
                          : t('vehicleDetail.advanced.apply')}
                      </button>
                    </div>
                  </div>

                  {/* Charging amps */}
                  <div className="rounded-xl border border-[hsl(var(--border)/0.4)] p-3 space-y-2.5" style={{ background: 'color-mix(in srgb, var(--a-500) 6%, transparent)' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold" style={{ color: 'var(--a-500)' }}>{t('vehicleDetail.advanced.chargingAmps')}</span>
                      <span className="text-sm font-bold text-foreground tabular-nums">{chargingAmps} A</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range" min={5} max={48} step={1} value={chargingAmps}
                        onChange={e => setChargingAmps(+e.target.value)}
                        className="flex-1 h-1.5 cursor-pointer"
                        style={{ accentColor: 'var(--a-500)' }}
                        disabled={isAsleep}
                      />
                      <button
                        onClick={() => sendCmd('charging-amps', { amps: chargingAmps }, 'charging-amps')}
                        disabled={isAsleep || cmdLoading === 'charging-amps'}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                        style={{ background: 'color-mix(in srgb, var(--a-500) 15%, transparent)', color: 'var(--a-500)' }}
                      >
                        {cmdLoading === 'charging-amps'
                          ? <span className="w-3.5 h-3.5 border border-t-transparent rounded-full animate-spin inline-block" style={{ borderColor: 'var(--a-500)' }} />
                          : t('vehicleDetail.advanced.apply')}
                      </button>
                    </div>
                  </div>

                  {/* Seat heater */}
                  <div className="rounded-xl border border-[hsl(var(--border)/0.4)] p-3 space-y-2.5" style={{ background: '#f59e0b08' }}>
                    <span className="text-xs font-semibold text-amber-400">{t('vehicleDetail.advanced.seatHeater')}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {SEAT_IDS.map((s, i) => (
                        <button key={s}
                          onClick={() => setSeatSeat(s)}
                          className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors border"
                          style={seatSeat === s
                            ? { background: '#f59e0b25', color: '#fbbf24', borderColor: '#f59e0b40' }
                            : { background: 'hsl(var(--secondary)/0.5)', color: 'hsl(var(--muted-foreground))', borderColor: 'transparent' }}
                        >
                          {t(SEAT_LABELS[i])}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      {[0, 1, 2, 3].map(lvl => (
                        <button key={lvl}
                          onClick={() => setSeatLevel(lvl)}
                          className="flex-1 py-1 rounded-lg text-xs font-semibold transition-colors border"
                          style={seatLevel === lvl
                            ? { background: '#f59e0b20', color: '#fcd34d', borderColor: '#f59e0b35' }
                            : { background: 'hsl(var(--secondary)/0.5)', color: 'hsl(var(--muted-foreground))', borderColor: 'transparent' }}
                        >
                          {lvl === 0 ? t('vehicleDetail.advanced.levelOff') : lvl}
                        </button>
                      ))}
                      <button
                        onClick={() => sendCmd('seat-heater', { seat: seatSeat, level: seatLevel }, 'seat-heater')}
                        disabled={isAsleep || cmdLoading === 'seat-heater'}
                        className="px-3 py-1 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                        style={{ background: '#f59e0b15', color: '#f59e0b' }}
                      >
                        {cmdLoading === 'seat-heater'
                          ? <span className="w-3.5 h-3.5 border border-t-transparent border-amber-400 rounded-full animate-spin inline-block" />
                          : t('vehicleDetail.advanced.apply')}
                      </button>
                    </div>
                  </div>

                  {/* Scheduled charging */}
                  <div className="rounded-xl border border-[hsl(var(--border)/0.4)] p-3 space-y-2" style={{ background: 'hsl(var(--secondary)/0.15)' }}>
                    <span className="text-xs font-semibold text-muted-foreground">{t('vehicleDetail.advanced.scheduledCharging')}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="time" value={schedChargingTime}
                        onChange={e => setSchedChargingTime(e.target.value)}
                        className="flex-1 min-w-0 bg-[hsl(var(--secondary)/0.5)] border border-[hsl(var(--border)/0.5)] rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none [color-scheme:dark]"
                        disabled={isAsleep}
                      />
                      <button
                        onClick={() => sendCmd('scheduled-charging', { enabled: true, timeMinutes: timeToMinutes(schedChargingTime) }, 'sched-charge-on')}
                        disabled={isAsleep || cmdLoading === 'sched-charge-on'}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                        style={{ background: 'color-mix(in srgb, var(--a-500) 15%, transparent)', color: 'var(--a-500)' }}
                      >
                        {cmdLoading === 'sched-charge-on'
                          ? <span className="w-3 h-3 border border-t-transparent rounded-full animate-spin inline-block" style={{ borderColor: 'var(--a-500)' }} />
                          : t('vehicleDetail.advanced.enable')}
                      </button>
                      <button
                        onClick={() => sendCmd('scheduled-charging', { enabled: false, timeMinutes: 0 }, 'sched-charge-off')}
                        disabled={isAsleep || cmdLoading === 'sched-charge-off'}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[hsl(var(--secondary)/0.5)] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                      >
                        {cmdLoading === 'sched-charge-off'
                          ? <span className="w-3 h-3 border border-t-transparent border-current rounded-full animate-spin inline-block" />
                          : t('vehicleDetail.advanced.disable')}
                      </button>
                    </div>
                  </div>

                  {/* Scheduled departure */}
                  <div className="rounded-xl border border-[hsl(var(--border)/0.4)] p-3 space-y-2" style={{ background: 'hsl(var(--secondary)/0.15)' }}>
                    <span className="text-xs font-semibold text-muted-foreground">{t('vehicleDetail.advanced.scheduledDeparture')}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="time" value={schedDepartureTime}
                        onChange={e => setSchedDepartureTime(e.target.value)}
                        className="flex-1 min-w-0 bg-[hsl(var(--secondary)/0.5)] border border-[hsl(var(--border)/0.5)] rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none [color-scheme:dark]"
                        disabled={isAsleep}
                      />
                      <button
                        onClick={() => sendCmd('scheduled-departure', { enabled: true, departureTimeMinutes: timeToMinutes(schedDepartureTime) }, 'sched-dep-on')}
                        disabled={isAsleep || cmdLoading === 'sched-dep-on'}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                        style={{ background: 'color-mix(in srgb, var(--a-500) 15%, transparent)', color: 'var(--a-500)' }}
                      >
                        {cmdLoading === 'sched-dep-on'
                          ? <span className="w-3 h-3 border border-t-transparent rounded-full animate-spin inline-block" style={{ borderColor: 'var(--a-500)' }} />
                          : t('vehicleDetail.advanced.enable')}
                      </button>
                      <button
                        onClick={() => sendCmd('scheduled-departure', { enabled: false, departureTimeMinutes: 0 }, 'sched-dep-off')}
                        disabled={isAsleep || cmdLoading === 'sched-dep-off'}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[hsl(var(--secondary)/0.5)] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                      >
                        {cmdLoading === 'sched-dep-off'
                          ? <span className="w-3 h-3 border border-t-transparent border-current rounded-full animate-spin inline-block" />
                          : t('vehicleDetail.advanced.disable')}
                      </button>
                    </div>
                  </div>

                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

      </div>
    </>
  )
}
