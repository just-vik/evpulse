'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Page } from '@/components/layout'
import { useAuthStore } from '@/stores/authStore'
import { useLayoutStore } from '@/stores/layout.store'
import { apiClient } from '@/lib/api'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useCurrency } from '@/hooks/useCurrency'
import { useTranslation } from 'react-i18next'
import {
  MapPin, Star, Wind, ChevronDown, Mountain,
  Droplets, RefreshCw, Play,
} from 'lucide-react'
import {
  TripIcon, BoltIcon, LeafIcon, SpeedIcon,
  BatteryIcon, VehicleIcon, AnalyticsIcon,
} from '@/components/icons/NavIcons'
import dynamic from 'next/dynamic'
import { TripReplay } from '@/components/trips/TripReplay'
import { EmptyState } from '@/shared/ui/EmptyState'
import { ErrorState } from '@/shared/ui/ErrorState'
import { LoadingState } from '@/shared/ui/LoadingState'
import { ClampedBanner } from '@/components/billing/ClampedBanner'
import { MetricBanknoteIcon } from '@/components/icons/MetricBanknoteIcon'
import { useTripsPeriodStats } from '@/hooks/usePeriodComparison'
import { PeriodDeltaBadge } from '@/shared/ui'
import { PeriodFilterBar, periodToApiRange, type PeriodValue } from '@/shared/ui/PeriodFilterBar'
import { usePeriodParam } from '@/hooks/usePeriodParam'
const EfficiencyChart = dynamic(
  () => import('@/widgets/charts/EfficiencyChart').then(m => m.EfficiencyChart),
  { ssr: false, loading: () => <div className="h-48 rounded-xl bg-[hsl(var(--secondary)/0.7)] animate-pulse" /> },
)

const TripMapGL = dynamic(
  () => import('@/components/trips/TripMapGL'),
  { ssr: false, loading: () => <div className="h-52 rounded-xl bg-[hsl(var(--secondary)/0.7)] animate-pulse" /> },
)

// ─── Types ────────────────────────────────────────────────────────────────────

interface RepairTagItem {
  tag: string
  source: 'watchdog' | 'engine' | 'post-processor' | 'gap-recovery' | 'reconciler' | 'backfill'
  ts: string
  version?: number
}

interface ApiTrip {
  id: string
  vehicleId: string
  startTime: string
  endTime: string | null
  startLocation: string | null
  endLocation: string | null
  distanceKm: number | null
  energyUsedKwh: number | null
  efficiencyWhkm: number | null
  startSoc: number | null
  endSoc: number | null
  polyline: string | null
  qualityScore: number | null
  drivingScore: number | null
  costTotal: number | null
  anomalyFlags: string | null
  reliability: string | null
  repairReason: string | null
  repairTags?: RepairTagItem[] | null
  sessionId?: string
  _live?: boolean
  stats?: {
    avgSpeed: number | null
    maxSpeed: number | null
    trafficStopRatio: number | null
    elevationGain: number | null
    drivingStyle: string | null
    regenEnergyKwh: number | null
  } | null
}

interface ApiVehicle { id: string; model: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(start: string, end: string | null, t: (k: string, o?: any) => string): string | null {
  if (!end) return null
  const mins = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000)
  if (mins < 60) return t('trips.durationMin', { count: mins, defaultValue: `${mins} min` })
  const h = Math.floor(mins / 60), m = mins % 60
  return m
    ? t('trips.durationHourMin', { h, m, defaultValue: `${h}h ${m}m` })
    : t('trips.durationHour', { h, defaultValue: `${h}h` })
}

function formatTime(iso: string, locale?: string): string {
  return new Date(iso).toLocaleTimeString(locale || 'de-DE', { hour: '2-digit', minute: '2-digit' })
}

function formatGapEndpoint(iso: string, locale?: string): string {
  return new Date(iso).toLocaleString(locale || 'ru-RU', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDayHeader(iso: string, t: (k: string) => string): string {
  const d = new Date(iso)
  const todayD = new Date(); todayD.setHours(0, 0, 0, 0)
  const yesterdayD = new Date(todayD); yesterdayD.setDate(todayD.getDate() - 1)
  d.setHours(0, 0, 0, 0)
  if (d.getTime() === todayD.getTime())     return t('common.today')
  if (d.getTime() === yesterdayD.getTime()) return t('common.yesterday')
  return d.toLocaleDateString('ru', { weekday: 'long', day: 'numeric', month: 'long' })
}

function parseAddress(loc: string | null): { street: string; city: string } | null {
  if (!loc) return null
  const parts = loc.split(',').map(p => p.trim()).filter(Boolean)
  // Coords fallback
  if (parts.length === 2 && !isNaN(parseFloat(parts[0])) && !isNaN(parseFloat(parts[1]))) return null
  // "Road, Village, Region, DE" — prefer village/town (parts[1]) as area label like TezLab
  if (parts.length >= 2) return { street: parts[0], city: parts[1] }
  return { street: parts[0], city: parts[0] }
}

function formatLocation(loc: string | null): string {
  const addr = parseAddress(loc)
  if (!addr) {
    if (!loc) return '—'
    const parts = loc.split(',')
    if (parts.length === 2) {
      const lat = parseFloat(parts[0]), lon = parseFloat(parts[1])
      if (!isNaN(lat) && !isNaN(lon)) return `${lat.toFixed(3)}, ${lon.toFixed(3)}`
    }
    return loc.slice(0, 22)
  }
  return addr.city
}

// TezLab-style: same area → "Area · street → street"; cross-area → "PlaceA → PlaceB" (no street in list)
function formatRoute(
  startLoc: string | null,
  endLoc: string | null,
  isLive = false,
): { start: string; end: string; sameCity: boolean; city?: string } {
  const s = parseAddress(startLoc)
  const e = parseAddress(endLoc)

  if (!s) return { start: formatLocation(startLoc), end: isLive ? '…' : formatLocation(endLoc), sameCity: false }

  const norm = (x: string) =>
    x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const sameCity = !isLive && e != null && norm(s.city) === norm(e.city)

  if (sameCity && e) {
    return { start: s.street, end: isLive ? '…' : e.street, sameCity: true, city: s.city }
  }
  // Different areas: show locality → locality (matches TezLab long hops)
  return { start: s.city, end: isLive ? '…' : (e?.city ?? '—'), sameCity: false }
}

function dayKey(iso: string): string { return iso.slice(0, 10) }

function toStartOfDayIso(dateYmd: string): string {
  const d = new Date(`${dateYmd}T00:00:00`)
  return d.toISOString()
}

function toEndOfDayIso(dateYmd: string): string {
  const d = new Date(`${dateYmd}T23:59:59.999`)
  return d.toISOString()
}

/** Оценка потери SOC между концом поездки i и началом i+1 (без учёта зарядки между ними). */
function computeParkingSocGaps(trips: ApiTrip[]) {
  const done = trips
    .filter(t => t.endTime && t.endSoc != null && t.startSoc != null)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
  const out: {
    key: string
    hours: number
    lossPct: number
    perHr: number
    afterEnd: string
    beforeStart: string
  }[] = []
  for (let i = 0; i < done.length - 1; i++) {
    const a = done[i]
    const b = done[i + 1]
    const endA = new Date(a.endTime!).getTime()
    const startB = new Date(b.startTime).getTime()
    const hours = (startB - endA) / 3_600_000
    if (hours < 0.5 || hours > 96) continue
    const lossPct = (a.endSoc ?? 0) - (b.startSoc ?? 0)
    if (lossPct < 0.5) continue
    out.push({
      key: `${a.id}-${b.id}`,
      hours,
      lossPct,
      perHr: lossPct / hours,
      afterEnd: a.endTime!,
      beforeStart: b.startTime,
    })
  }
  return out
}

function groupByDay(trips: ApiTrip[], t: (k: string) => string) {
  const map = new Map<string, ApiTrip[]>()
  for (const t of trips) {
    const k = dayKey(t.startTime)
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(t)
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, dayTrips]) => ({
      day,
      label: formatDayHeader(day + 'T12:00:00', t),
      trips: [...dayTrips].sort((a, b) => b.startTime.localeCompare(a.startTime)),
      dayDistance: dayTrips.filter(t => t.endTime).reduce((s, t) => s + (t.distanceKm ?? 0), 0),
    }))
}

// ─── Small UI pieces ──────────────────────────────────────────────────────────

/** TeslaFi-style leaf efficiency badge: leaf icon + % relative to average. */
function LeafBadge({ pct }: { pct: number }) {
  const colorClass = pct >= 110
    ? 'text-teal-400'
    : pct >= 90
      ? 'text-sky-400'
      : 'text-amber-400'
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold tabular-nums ${colorClass}`}>
      <LeafIcon size={11} />
      {pct}%
    </span>
  )
}

function QDot({ score }: { score: number | null }) {
  if (score == null) return null
  const cls = score >= 80 ? 'bg-emerald-500' : score >= 50 ? 'bg-yellow-500' : 'bg-red-500'
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls} shrink-0`} title={`Q: ${score}`} />
}

// ─── Expanded detail section ──────────────────────────────────────────────────

function TripDetails({ trip }: { trip: ApiTrip }) {
  const { t } = useTranslation()
  const { formatMoney, formatPerKm } = useCurrency()
  const regen   = trip.stats?.regenEnergyKwh ?? null
  const energy  = trip.energyUsedKwh != null ? Number(trip.energyUsedKwh) : null
  const distance = trip.distanceKm != null ? Number(trip.distanceKm) : null
  const costPerKm = trip.costTotal && distance && distance > 0 ? (trip.costTotal / distance) : null

  const statItems = [
    energy     != null && { icon: BoltIcon,  label: t('trips.energy'),    value: `${energy.toFixed(2)} kWh` },
    regen != null && regen > 0 && { icon: Wind, label: t('trips.regen'), value: `${regen.toFixed(2)} kWh`, cls: 'text-teal-400' },
    trip.costTotal != null && trip.costTotal > 0 && {
      icon: MetricBanknoteIcon,
      label: t('trips.cost'),
      value: `${formatMoney(trip.costTotal)}${costPerKm ? ` · ${formatPerKm(costPerKm)}` : ''}`,
    },
    trip.stats?.avgSpeed != null && { icon: SpeedIcon, label: t('trips.avgSpeedLabel'), value: `${Math.round(trip.stats.avgSpeed)} ${t('trips.kmh')}` },
    trip.stats?.elevationGain != null && trip.stats.elevationGain > 0 && {
      icon: Mountain, label: t('trips.elevationGain'), value: `↑ ${Math.round(trip.stats.elevationGain)} ${t('trips.meters')}`,
    },
    trip.stats?.trafficStopRatio != null && trip.stats.trafficStopRatio > 0 && {
      icon: VehicleIcon, label: t('trips.traffic'), value: `${Math.round(trip.stats.trafficStopRatio * 100)}%`,
    },
    trip.stats?.drivingStyle && {
      icon: Star, label: t('trips.styleLabel'),
      value: trip.stats.drivingStyle === 'eco' ? t('trips.drivingStyle_eco') : trip.stats.drivingStyle === 'normal' ? t('trips.drivingStyle_normal') : t('trips.drivingStyle_aggressive'),
      cls: trip.stats.drivingStyle === 'eco' ? 'text-green-400' : trip.stats.drivingStyle === 'normal' ? 'text-blue-400' : 'text-red-400',
    },
    trip.startSoc != null && trip.endSoc != null && {
      icon: BatteryIcon, label: t('trips.chargeLabel'),
      value: `${Math.round(trip.startSoc)}% → ${Math.round(trip.endSoc)}%`,
    },
  ].filter(Boolean) as { icon: React.ComponentType<{ size?: number; className?: string }>; label: string; value: string; cls?: string }[]

  return (
    <div className="mt-3 space-y-3">
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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {statItems.map(item => {
            const Icon = item.icon
            return (
              <div key={item.label} className="flex items-start gap-2 p-2.5 rounded-xl bg-[hsl(var(--secondary)/0.45)] border border-[hsl(var(--border)/0.6)]">
                <Icon size={13} className="text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground leading-none mb-0.5">{item.label}</p>
                  <p className={`text-xs font-semibold truncate ${item.cls ?? 'text-foreground'}`}>{item.value}</p>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* User-facing trip flags: only auto-close and route-reconstruction warnings */}
      {(() => {
        const INTERNAL_TAGS = new Set([
          'map_matched', 'ok', 'short_trip_rating_gate',
          'energy_from_soc_preferred', 'energy_recovered_from_soc',
          'efficiency_out_of_range', 'low_quality_trip',
        ])
        const isInternalReason = (r: string) =>
          r === 'ok' ||
          r.startsWith('energy_') ||
          r.startsWith('gps_cleaned') ||
          r.startsWith('efficiency_') ||
          r.startsWith('low_quality')

        const userTags = (trip.repairTags ?? []).filter(rt => {
          if (INTERNAL_TAGS.has(rt.tag)) return false
          if (rt.tag.startsWith('energy_') || rt.tag.startsWith('gps_cleaned') || rt.tag.startsWith('efficiency_')) return false
          return rt.tag.includes('watchdog') || rt.tag.includes('force_closed') || rt.tag.includes('gap_recovery') || rt.tag.includes('reconstructed')
        })

        const legacyReasons = !trip.repairTags?.length && trip.repairReason && trip.repairReason !== 'ok'
          ? trip.repairReason.split('|').filter(r => !isInternalReason(r.trim())).filter(Boolean)
          : []

        const badges = [
          ...userTags.map((rt, i) => {
            const isWatchdog = rt.tag.includes('watchdog') || rt.tag.includes('force_closed')
            const cls = isWatchdog
              ? 'bg-red-500/10 border-red-500/30 text-red-400'
              : 'bg-orange-500/10 border-orange-500/30 text-orange-400'
            const label = isWatchdog ? t('trips.tagAutoClosed') : t('trips.tagPartialRoute')
            return <span key={`rt-${i}`} className={`text-[10px] border px-1.5 py-0.5 rounded-lg font-medium ${cls}`}>{label}</span>
          }),
          ...legacyReasons.slice(0, 1).map((r, i) => (
            <span key={`lr-${i}`} className="text-[10px] border px-1.5 py-0.5 rounded-lg font-medium bg-orange-500/10 border-orange-500/30 text-orange-400">
              {t('trips.tagPartialRoute')}
            </span>
          )),
        ]

        return badges.length > 0
          ? <div className="flex items-center gap-2 flex-wrap">{badges}</div>
          : null
      })()}
    </div>
  )
}

// ─── TripCard — TeslaFi-style: bold route title + metrics row ─────────────────

function TripCard({
  trip,
  avgEffWhkm,
  expanded,
  onToggle,
}: {
  trip: ApiTrip
  avgEffWhkm: number | null
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const [replayOpen, setReplayOpen] = React.useState(false)
  const isLive     = trip._live || !trip.endTime
  const duration   = formatDuration(trip.startTime, trip.endTime, t)
  const distance   = trip.distanceKm     != null ? Number(trip.distanceKm)     : null
  const efficiency = trip.efficiencyWhkm != null ? Number(trip.efficiencyWhkm) : null
  const effPct     = avgEffWhkm && efficiency && efficiency > 0
    ? Math.round((avgEffWhkm / efficiency) * 100) : null

  const route = formatRoute(trip.startLocation, trip.endLocation, isLive)
  // Title: "City · StreetA → StreetB" (same city) or "CityA → CityB" (cross-city)
  const routeTitle = route.sameCity && route.city
    ? `${route.city} · ${route.start} → ${route.end}`
    : `${route.start} → ${route.end}`

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`cursor-pointer transition-all duration-200 ${
        isLive
          ? 'bg-[linear-gradient(135deg,rgba(37,99,235,0.15),rgba(2,132,199,0.08))] shadow-[0_0_14px_rgba(59,130,246,0.16)]'
          : expanded
            ? 'bg-[hsl(var(--surface-1))]'
            : 'bg-[hsl(var(--card))] hover:bg-[hsl(var(--secondary)/0.2)]'
      }`}
      onClick={onToggle}
    >
      <div className="px-4 py-3">
        {/* ── Title row: route name + chevron ── */}
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <span className="text-[13px] font-semibold text-foreground leading-snug line-clamp-1 flex-1 min-w-0">
            {routeTitle}
          </span>
          <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
            {isLive && (
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
              </span>
            )}
            <QDot score={trip.qualityScore} />
            <div className={`transition-transform duration-200 text-muted-foreground ${expanded ? 'rotate-180' : ''}`}>
              <ChevronDown size={14} />
            </div>
          </div>
        </div>

        {/* ── Metrics row: time • duration | SOC | leaf% | distance ── */}
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
          {/* Time + duration */}
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {formatTime(trip.startTime)}
            {isLive
              ? <span className="text-green-400 ml-1">{t('status.driving')}</span>
              : duration && <span className="text-muted-foreground"> • {duration}</span>
            }
          </span>

          {/* SOC */}
          {trip.startSoc != null && trip.endSoc != null && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
              <BatteryIcon size={10} />
              {Math.round(trip.startSoc)}%–{Math.round(trip.endSoc)}%
            </span>
          )}

          {/* Leaf efficiency */}
          {effPct != null && <LeafBadge pct={effPct} />}

          {/* Distance — pushed to right */}
          {distance != null && (
            <span className="flex items-center gap-0.5 text-[11px] font-semibold text-foreground tabular-nums ml-auto">
              <MapPin size={10} className="text-muted-foreground shrink-0" />
              {distance.toFixed(1)} km
            </span>
          )}
        </div>
      </div>

      {/* ── Expanded content ── */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeInOut' }}
            className="overflow-hidden"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <div className="px-4 pb-4 border-t border-[hsl(var(--border)/0.35)] pt-3 space-y-3">
              <TripDetails trip={trip} />

              {/* Replay panel */}
              <AnimatePresence>
                {replayOpen && (
                  <TripReplay tripId={trip.id} onClose={() => setReplayOpen(false)} />
                )}
              </AnimatePresence>

              {/* Replay toggle button — only for completed trips with GPS */}
              {!isLive && trip.polyline && !replayOpen && (
                <button
                  onClick={() => setReplayOpen(true)}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl border border-[hsl(var(--border)/0.6)] text-muted-foreground hover:text-foreground hover:border-[hsl(var(--border)/0.9)] transition-colors"
                >
                  <Play size={12} />
                  {t('trips.replay')}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TripsPage() {
  const { t, i18n } = useTranslation()
  const { accessToken } = useAuthStore()
  const { symbol: currencySymbol, formatMoney: fmtMoney } = useCurrency()
  const selectedVehicleId = useLayoutStore(s => s.selectedVehicleId)
  const setSelectedVehicleId = useLayoutStore(s => s.setSelectedVehicleId)

  const [, setVehicles]                             = useState<ApiVehicle[]>([])
  const [trips, setTrips]                           = useState<ApiTrip[]>([])
  const [tripsMeta, setTripsMeta]                   = useState<{ clamped: boolean; limitDays: number } | null>(null)
  const [expandedTripId, setExpandedTripId]         = useState<string | null>(null)
  const [loading, setLoading]                       = useState(true)
  const [error, setError]                           = useState<string | null>(null)
  const [period, setPeriod] = usePeriodParam(30)

  // Derived API range — memoised so downstream effects only re-run when value changes
  const appliedRange = useMemo(() => periodToApiRange(period), [period])
  const [vampireSummary, setVampireSummary]         = useState<{
    avgPerHr: number
    avgDrainPct: number
    avgDurationHrs: number
    maxDrain: number
    avgIdlePowerKw: number | null
    logs: { drainPct: number }[]
  } | null>(null)
  const [backfillBusy, setBackfillBusy]             = useState(false)
  const [backfillMsg, setBackfillMsg]               = useState<string | null>(null)
  const [backfillOpen, setBackfillOpen]             = useState(false)
  const [drainsOpen, setDrainsOpen]                 = useState(false)
  const { connect, subscribeVehicle, unsubscribeVehicle, on, off } = useWebSocket({ autoConnect: true })

  const fetchTrips = useCallback(async (
    vehicleId: string,
    token: string,
    reconcileFirst = false,
    range?: { from?: string; to?: string },
  ) => {
    try {
      if (reconcileFirst) {
        await apiClient.reconcileTrips(vehicleId, token, 14).catch(() => undefined)
      }
      const limit = range?.from || range?.to ? 280 : 100
      const res = await apiClient.getTrips(vehicleId, limit, token, range)
      setTrips((res.data ?? res) as unknown as ApiTrip[])
      if (res.meta) setTripsMeta({ clamped: res.meta.clamped, limitDays: res.meta.limitDays })
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    if (!accessToken) return
    apiClient.getVehicles(accessToken)
      .then(data => {
        const vs = data as ApiVehicle[]
        setVehicles(vs)
        if (vs.length > 0 && !selectedVehicleId) setSelectedVehicleId(vs[0].id)
      })
      .catch(e => setError(e.message))
  }, [accessToken, selectedVehicleId, setSelectedVehicleId])

  useEffect(() => {
    if (!accessToken || !selectedVehicleId) return
    setLoading(true)
    setTrips([])
    setExpandedTripId(null)
    fetchTrips(selectedVehicleId, accessToken, true, appliedRange).finally(() => setLoading(false))
    const interval = setInterval(
      () => fetchTrips(selectedVehicleId, accessToken, false, appliedRange),
      30_000,
    )
    return () => clearInterval(interval)
  }, [selectedVehicleId, accessToken, fetchTrips, appliedRange])

  useEffect(() => {
    if (!accessToken || !selectedVehicleId) {
      setVampireSummary(null)
      return
    }
    apiClient
      .getVampireDrainStats(selectedVehicleId, 30, accessToken)
      .then((r: any) => {
        if (!r || typeof r !== 'object') {
          setVampireSummary(null)
          return
        }
        setVampireSummary({
          avgPerHr:       Number(r.avgPerHr)       || 0,
          avgDrainPct:    Number(r.avgDrainPct)    || 0,
          avgDurationHrs: Number(r.avgDurationHrs) || 0,
          maxDrain:       Number(r.maxDrain)       || 0,
          avgIdlePowerKw: r.avgIdlePowerKw != null ? Number(r.avgIdlePowerKw) : null,
          logs:           Array.isArray(r.logs) ? r.logs : [],
        })
      })
      .catch(() => setVampireSummary(null))
  }, [accessToken, selectedVehicleId])

  useEffect(() => {
    if (!accessToken || !selectedVehicleId) return
    connect()
    subscribeVehicle(selectedVehicleId)

    const onTripStarted = ({ trip }: { trip: ApiTrip }) => {
      setTrips(prev => prev.some(t => t.id === trip.id) ? prev : [{ ...trip, _live: true }, ...prev])
    }
    const onTripEnded = ({ trip }: { trip: ApiTrip }) => {
      setTrips(prev => {
        const exists = prev.some(t => t.id === trip.id)
        const updated = { ...trip, _live: false }
        return exists ? prev.map(t => t.id === trip.id ? updated : t) : [updated, ...prev]
      })
    }

    const onTripLive = ({ tripId, liveStats }: {
      tripId: string;
      liveStats: { distanceKm: number; durationMin: number; energyKwh: number; efficiencyWhkm: number | null; avgSpeedKmh: number | null }
    }) => {
      setTrips(prev => prev.map(t =>
        t.id === tripId
          ? {
              ...t,
              _live: true,
              distanceKm:     liveStats.distanceKm,
              energyUsedKwh:  liveStats.energyKwh,
              efficiencyWhkm: liveStats.efficiencyWhkm,
              stats: t.stats
                ? { ...t.stats, avgSpeed: liveStats.avgSpeedKmh }
                : { avgSpeed: liveStats.avgSpeedKmh, maxSpeed: null, trafficStopRatio: null, elevationGain: null, drivingStyle: null, regenEnergyKwh: null },
            }
          : t
      ))
    }

    on('trip:started', onTripStarted)
    on('trip:ended', onTripEnded)
    on('trip:live', onTripLive)
    return () => {
      off('trip:started', onTripStarted)
      off('trip:ended', onTripEnded)
      off('trip:live', onTripLive)
      unsubscribeVehicle(selectedVehicleId)
    }
  }, [accessToken, selectedVehicleId, connect, subscribeVehicle, unsubscribeVehicle, on, off])

  const completed    = trips.filter(t => t.endTime)
  const totalDist    = completed.reduce((s, t) => s + (t.distanceKm ?? 0), 0)
  const totalEnergy  = completed.reduce((s, t) => s + (t.energyUsedKwh ?? 0), 0)
  const effs         = completed.filter(t => t.efficiencyWhkm != null).map(t => t.efficiencyWhkm as number)
  const avgEffWhkm   = effs.length ? effs.reduce((a, b) => a + b) / effs.length : null
  const totalCost    = completed.reduce((s, t) => s + (t.costTotal ?? 0), 0)
  const grouped      = groupByDay(trips, t)
  const periodDeltas = useTripsPeriodStats(completed)

  const parkingGaps = useMemo(() => computeParkingSocGaps(trips), [trips])


  const runBackfill = useCallback(async () => {
    if (!accessToken || !selectedVehicleId) return
    const fromIso = appliedRange?.from
    const toIso   = appliedRange?.to
    if (!fromIso) {
      setBackfillMsg(t('trips.backfillNeedFrom'))
      return
    }
    setBackfillBusy(true)
    setBackfillMsg(null)
    try {
      // Use rebuild (delete + backfill) so re-running on an already-recorded day
      // doesn't create duplicates. Falls back to backfill API on older servers.
      const res = await apiClient.rebuildTrips(selectedVehicleId, accessToken, {
        from: fromIso,
        ...(toIso ? { to: toIso } : {}),
      })
      // dryRun is never passed above, so this is always the real-run branch —
      // narrow explicitly rather than asserting, since the API can also return
      // a dryRun preview shape (previewKind: 'reconcile_existing_only').
      if (res.dryRun) {
        setBackfillMsg('Unexpected dry-run response')
      } else {
        setBackfillMsg(
          `Удалено ${res.deleted} поездок, обработано ${res.processed} точек телеметрии` +
          (res.socUpFiltered > 0 ? `, отфильтровано ${res.socUpFiltered} аномалий` : ''),
        )
      }
      await fetchTrips(selectedVehicleId, accessToken, false, appliedRange)
    } catch (e: any) {
      setBackfillMsg(e?.message ?? 'Error')
    } finally {
      setBackfillBusy(false)
    }
  }, [accessToken, selectedVehicleId, appliedRange, fetchTrips, t])

  const efficiencyChartData = useMemo(() => {
    const map = new Map<string, { sum: number; n: number }>()
    for (const trip of completed) {
      if (trip.efficiencyWhkm == null || trip.efficiencyWhkm <= 0) continue
      const k = dayKey(trip.startTime)
      const cur = map.get(k) ?? { sum: 0, n: 0 }
      cur.sum += Number(trip.efficiencyWhkm)
      cur.n += 1
      map.set(k, cur)
    }
    const baseline =
      avgEffWhkm != null && avgEffWhkm > 0 ? avgEffWhkm : 150
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-14)
      .map(([day, { sum, n }]) => {
        const avgWh = sum / n
        const pct = Math.round(
          Math.min(200, Math.max(0, (baseline / avgWh) * 100)),
        )
        return {
          date: new Date(day + 'T12:00:00').toLocaleDateString(
            i18n.language || 'en',
            { month: 'short', day: 'numeric' },
          ),
          efficiencyPct: pct,
        }
      })
  }, [completed, avgEffWhkm, i18n.language])

  return (
    <Page title={t('pages.trips.title')} subtitle={t('pages.trips.subtitle', { count: completed.length })}>

      {/* Entitlement clamped banner */}
      {tripsMeta?.clamped && tripsMeta.limitDays < 365 && (
        <div className="mb-4">
          <ClampedBanner days={tripsMeta.limitDays} />
        </div>
      )}

      <div className="mb-6">
        <PeriodFilterBar value={period} onChange={setPeriod} defaultPeriod={30} />
      </div>

      {/* Stats bar — colored metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {([
          { icon: <TripIcon size={18} />,     label: t('trips.distance'),    value: totalDist.toFixed(1),            unit: t('common.km'),        color: 'text-sky-400',     bg: 'bg-sky-500/8 border-sky-500/15',         glow: 'shadow-sky-500/10',   delta: periodDeltas?.totalDist,   invertColor: false },
          { icon: <BoltIcon size={18} />,     label: t('trips.energy'),      value: totalEnergy.toFixed(1),          unit: t('common.kWh'),       color: 'text-emerald-400', bg: 'bg-emerald-500/8 border-emerald-500/15', glow: 'shadow-emerald-500/10', delta: periodDeltas?.totalEnergy, invertColor: false },
          { icon: <SpeedIcon size={18} />,    label: t('trips.efficiency'),  value: avgEffWhkm ? String(Math.round(avgEffWhkm)) : '—', unit: avgEffWhkm ? t('common.whPerKm') : '', color: 'text-amber-400',  bg: 'bg-amber-500/8 border-amber-500/15', glow: 'shadow-amber-500/10', delta: periodDeltas?.avgEffWhkm, invertColor: true },
          { icon: <AnalyticsIcon size={18} />, label: t('trips.trips'),      value: String(completed.length),        unit: '',                    color: 'text-violet-400',  bg: 'bg-violet-500/8 border-violet-500/15',   glow: 'shadow-violet-500/10',  delta: periodDeltas?.count,       invertColor: false },
          { icon: <MetricBanknoteIcon size={18} className="shrink-0" />, label: t('trips.cost'), value: totalCost > 0 ? fmtMoney(totalCost) : '—', unit: '', unitPrefix: false, color: 'text-rose-400', bg: 'bg-rose-500/8 border-rose-500/15', glow: 'shadow-rose-500/10', delta: periodDeltas?.totalCost, invertColor: true, wideOnMobile: true },
        ] as const).map((s) => (
          <div key={s.label} className={`rounded-2xl border p-4 shadow-lg ${s.bg} ${s.glow} ${'wideOnMobile' in s && s.wideOnMobile ? 'col-span-2 md:col-span-1' : ''}`}>
            <div className={`flex items-center gap-1.5 mb-2 ${s.color}`}>
              {s.icon}
              <span className="text-[11px] font-semibold uppercase tracking-wider opacity-80">{s.label}</span>
            </div>
            <div className="flex items-end justify-between gap-1 flex-wrap">
              <p className={`text-2xl font-bold tabular-nums ${s.color}`}>
                {(s as any).unitPrefix && s.unit}{s.value}
                {!(s as any).unitPrefix && s.unit && <span className="text-sm font-normal ml-1 opacity-70">{s.unit}</span>}
              </p>
              {(s as any).delta != null && <PeriodDeltaBadge delta={(s as any).delta} unit="%" invertColor={(s as any).invertColor} precision={0} />}
            </div>
          </div>
        ))}
      </div>

      {efficiencyChartData.length > 0 && (
        <div className="mb-6 space-y-2">
          <p className="text-xs text-muted-foreground px-0.5">
            {t('trips.efficiencyChartSubtitle')}
          </p>
          <EfficiencyChart
            data={efficiencyChartData}
            title={t('trips.efficiencyChartTitle')}
            height={220}
          />
        </div>
      )}


      {((vampireSummary != null && (vampireSummary.avgPerHr > 0 || vampireSummary.maxDrain > 0)) || parkingGaps.length > 0) && (() => {
        const hasTelemetry = vampireSummary != null && (vampireSummary.avgPerHr > 0 || vampireSummary.maxDrain > 0)
        const hasGaps = parkingGaps.length > 0
        const sortedGaps = hasGaps ? [...parkingGaps].sort((a, b) => b.lossPct - a.lossPct) : []
        const totalLoss = parkingGaps.reduce((s, g) => s + g.lossPct, 0)
        return (
          <div className="rounded-2xl border border-[hsl(var(--border)/0.4)] bg-[hsl(var(--secondary)/0.08)] p-4 mb-6">
            {/* Header */}
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-[hsl(var(--secondary)/0.4)] flex items-center justify-center shrink-0">
                <Droplets size={14} className="text-muted-foreground" />
              </div>
              <span className="text-sm font-semibold text-foreground/80">{t('trips.vampireSummaryTitle')}</span>
            </div>

            {/* Telemetry stats */}
            {hasTelemetry && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2.5 mb-3">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">{t('trips.vampireAvgLabel')}</p>
                  <p className="text-sm font-semibold tabular-nums text-foreground">{(vampireSummary.avgDrainPct ?? 0).toFixed(1)}%</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">{t('trips.vampirePerHrLabel')}</p>
                  <p className="text-sm font-semibold tabular-nums text-foreground">{vampireSummary.avgPerHr.toFixed(2)}%/h</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">{t('trips.vampireMaxLabel')}</p>
                  <p className="text-sm font-semibold tabular-nums text-foreground">{vampireSummary.maxDrain.toFixed(1)}%</p>
                </div>
                {vampireSummary.avgIdlePowerKw != null && vampireSummary.avgIdlePowerKw > 0 ? (
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">{t('trips.vampireIdleLabel')}</p>
                    <p className="text-sm font-semibold tabular-nums text-foreground">{(vampireSummary.avgIdlePowerKw * 1000).toFixed(0)} W</p>
                  </div>
                ) : (
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">{t('trips.vampireNightsLabel')}</p>
                    <p className="text-sm font-semibold tabular-nums text-foreground">{vampireSummary.logs?.length ?? 0}</p>
                  </div>
                )}
              </div>
            )}

            {/* Collapsible parking gaps */}
            {hasGaps && (
              <div>
                <button
                  type="button"
                  onClick={() => setDrainsOpen(v => !v)}
                  className="flex w-full items-center justify-between rounded-xl border border-[hsl(var(--border)/0.4)] bg-[hsl(var(--secondary)/0.2)] px-3 py-2 text-left hover:bg-[hsl(var(--secondary)/0.35)] transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <BatteryIcon size={12} className="text-muted-foreground" />
                    <span className="text-[11px] text-muted-foreground truncate">{t('trips.parkingLossTitle')}</span>
                    <span className="text-[10px] text-muted-foreground/50 hidden sm:inline truncate">{t('trips.parkingLossHint')}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <span className="text-[11px] font-semibold tabular-nums text-foreground/70">−{totalLoss.toFixed(1)}% · {parkingGaps.length} {t('trips.parkingGapsCount')}</span>
                    <ChevronDown size={12} className={`text-muted-foreground transition-transform ${drainsOpen ? 'rotate-180' : ''}`} />
                  </div>
                </button>
                {drainsOpen && (
                  <ul className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
                    {sortedGaps.map((g) => {
                      const severity = g.lossPct > 5 ? 'high' : g.lossPct > 2 ? 'medium' : 'low'
                      const badgeClass = severity === 'high' ? 'bg-red-500/15 text-red-400' : severity === 'medium' ? 'bg-amber-500/15 text-amber-400' : 'bg-green-500/15 text-green-400'
                      return (
                        <li
                          key={g.key}
                          className="flex items-center justify-between gap-3 rounded-xl border border-[hsl(var(--border)/0.3)] bg-[hsl(var(--card)/0.4)] px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground truncate tabular-nums">
                              {formatGapEndpoint(g.afterEnd, i18n.language)} → {formatGapEndpoint(g.beforeStart, i18n.language)}
                            </p>
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5 tabular-nums">
                              {g.hours.toFixed(1)}{t('trips.parkingHours')} · {g.perHr.toFixed(2)}%/h
                            </p>
                          </div>
                          <span className={`shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-semibold tabular-nums ${badgeClass}`}>
                            −{g.lossPct.toFixed(1)}%
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        )
      })()}

      <div className="rounded-2xl border border-[hsl(var(--border)/0.35)] bg-[hsl(var(--secondary)/0.08)] mb-6 overflow-hidden">
        <button
          type="button"
          onClick={() => setBackfillOpen(v => !v)}
          className="flex w-full items-center justify-between px-4 py-3 hover:bg-[hsl(var(--secondary)/0.12)] transition-colors"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <RefreshCw size={14} />
            {t('trips.backfillTitle')}
          </span>
          <ChevronDown size={14} className={`text-muted-foreground transition-transform ${backfillOpen ? 'rotate-180' : ''}`} />
        </button>
        <AnimatePresence initial={false}>
          {backfillOpen && (
            <motion.div
              key="backfill"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              <div className="px-4 pb-4 border-t border-[hsl(var(--border)/0.3)] pt-3 space-y-3">
                <p className="text-[11px] text-muted-foreground">{t('trips.backfillHint')}</p>
                <button
                  type="button"
                  disabled={backfillBusy || !appliedRange?.from}
                  onClick={runBackfill}
                  className="inline-flex items-center gap-2 rounded-xl border border-sky-500/40 bg-sky-500/15 px-4 py-2 text-sm font-medium text-sky-200 disabled:opacity-40"
                >
                  {backfillBusy ? t('trips.backfillRunning') : t('trips.backfillRun')}
                </button>
                {backfillMsg && <p className="text-xs text-muted-foreground">{backfillMsg}</p>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Trip list */}
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} />
      ) : trips.length === 0 ? (
        <EmptyState
          icon={<TripIcon size={28} className="text-muted-foreground" />}
          title={t('trips.noTrips')}
          description={t('trips.noTripsHint')}
        />
      ) : (
        <div className="space-y-5">
          {grouped.map(({ day, label, trips: dayTrips, dayDistance }) => (
            <div key={day}>
              {/* Day header */}
              <div className="flex items-center gap-3 mt-2 mb-3 py-2 px-1">
                <span className="inline-block w-2 h-2 rounded-full bg-sky-400 shrink-0" />
                <span className="text-sm font-semibold text-foreground">{label}</span>
                <div className="flex-1 h-px bg-[hsl(var(--border)/0.45)]" />
                <span className="text-xs text-muted-foreground tabular-nums">{dayDistance.toFixed(1)} {t('common.km')}</span>
              </div>

              {/* Trip rows — unified container */}
              <div className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] shadow-xl overflow-hidden divide-y divide-[hsl(var(--border)/0.35)]">
                {dayTrips.map(trip => (
                  <TripCard
                    key={trip.id}
                    trip={trip}
                    avgEffWhkm={avgEffWhkm}
                    expanded={trip.id === expandedTripId}
                    onToggle={() => setExpandedTripId(trip.id === expandedTripId ? null : trip.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Page>
  )
}
