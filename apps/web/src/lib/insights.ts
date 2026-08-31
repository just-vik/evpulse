/**
 * Client-side insight engine — generates actionable cards from telemetry data.
 * Used as fallback when AI endpoint is unavailable.
 */

import type { VehicleStatusResponse } from '@/lib/api'
import type { TripsTodaySummary } from '@/hooks/useVehicleAggregates'

// BatteryHealth covers both type-definition fields and actual API response fields
interface BatteryHealthData {
  sohPercent?: number | null
  healthPercent?: number | null
  degradationPercent?: number | null
  estimatedCapacityKwh?: number | null
  nominalCapacityKwh?: number | null
}
type BatteryHealth = BatteryHealthData

/* ── Battery SOC thresholds ────────────────────────────────────────────────── */
export const BATTERY_SOC = {
  CRITICAL:           15,  // rule-based: battery-critical insight
  LOW:                25,  // rule-based: battery-low insight
  HIGH_WHILE_CHARGING: 95, // rule-based: overcharge warning
  AI_SUPPRESS_LOW:    30,  // AI sanity filter: suppress battery-low if soc > this
  AI_SUPPRESS_CRITICAL: 20, // AI sanity filter: suppress battery-critical if soc > this
} as const;

/* ── Action system ─────────────────────────────────────────────────────────── */

export type InsightAction =
  | { type: 'navigate'; href: string; label: string }
  | { type: 'command';  command: string; label: string }
  | { type: 'ai';       prompt: string;  label: string }

export type InsightSeverity = 'info' | 'success' | 'warning' | 'danger'

export interface Insight {
  id: string
  severity: InsightSeverity
  icon: string          // lucide icon name
  title: string
  description: string
  reasons?: string[]    // explainability: why this insight was generated
  confidence?: number   // 0-100, AI confidence in this insight
  anomalyScore?: number // 0-100, how abnormal the underlying data is
  action?: InsightAction
  priority: number      // higher = shown first
  /** Raw numeric values behind title/description, for locale-aware re-interpolation. */
  params?: Record<string, number>
}

interface InsightInput {
  status:    VehicleStatusResponse | null
  health:    BatteryHealth | null
  tripsToday: TripsTodaySummary | null
  vampireDrainPct: number | null
  vampireDrainPerHr: number | null
  costPerKm: number | null
  /** ISO 4217 currency code used to format monetary values, e.g. 'EUR', 'USD' */
  currency?: string
  /** Outside temperature in Celsius (for cold weather impact rule) */
  outsideTemp?: number | null
}

/** Presentation-time rounding for i18n interpolation — `Insight.params` themselves stay raw. */
const PARAM_DECIMALS: Record<string, number> = {
  degradationPercent: 1,
  sohPercent: 1,
  drainPerHour: 2,
}

export function roundInsightParams(params: Record<string, number> | undefined): Record<string, string> {
  if (!params) return {}
  const rounded: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (!Number.isFinite(value)) continue
    const decimals = PARAM_DECIMALS[key] ?? 0
    rounded[key] = value.toFixed(decimals)
  }
  return rounded
}

export function generateInsights(input: InsightInput): Insight[] {
  const insights: Insight[] = []
  const { status, health, tripsToday, vampireDrainPct, vampireDrainPerHr, costPerKm, currency = 'EUR', outsideTemp } = input

  // Local currency formatter (avoids importing React hooks into a non-component module)
  function fmtCost(value: number, decimals = 3): string {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency', currency,
        minimumFractionDigits: decimals, maximumFractionDigits: decimals,
      }).format(value)
    } catch {
      return `${value.toFixed(decimals)}`
    }
  }

  // ── Battery level ──────────────────────────────────────────────────────────
  if (status?.soc != null) {
    if (status.soc <= BATTERY_SOC.CRITICAL) {
      insights.push({
        id: 'battery-critical',
        severity: 'danger',
        icon: 'BatteryWarning',
        title: 'Battery critically low',
        description: `Only ${Math.round(status.soc)}% remaining — find a charger now.`,
        action: { type: 'navigate', href: '/charging', label: 'Charging history' },
        priority: 100,
        params: { soc: Math.round(status.soc) },
      })
    } else if (
      status.soc <= BATTERY_SOC.LOW &&
      status.chargingState !== 'Charging' &&
      (status.dataQuality === 'REALTIME' || status.dataQuality === 'DELAYED')
    ) {
      insights.push({
        id: 'battery-low',
        severity: 'warning',
        icon: 'BatteryWarning',
        title: 'Charge soon',
        description: `Battery at ${Math.round(status.soc)}% — recommend charging tonight.`,
        action: { type: 'navigate', href: '/charging', label: 'Charging history' },
        priority: 80,
        params: { soc: Math.round(status.soc) },
      })
    } else if (
      status.soc >= BATTERY_SOC.HIGH_WHILE_CHARGING &&
      status.chargingState === 'Charging' &&
      (status.dataQuality === 'REALTIME' || status.dataQuality === 'DELAYED')
    ) {
      insights.push({
        id: 'battery-full',
        severity: 'info',
        icon: 'BatteryFull',
        title: 'Battery nearly full',
        description: `At ${Math.round(status.soc)}% — consider unplugging to reduce wear.`,
        action: { type: 'command', command: 'charge_stop', label: 'Stop charging' },
        priority: 30,
      })
    }
  }

  // ── Charging state ─────────────────────────────────────────────────────────
  // chargingState='Charging' is reliable even with stale telemetry because the backend
  // overrides it from the open charging session record in DB.
  if (
    status?.chargingState === 'Charging' &&
    status?.soc != null
  ) {
    insights.push({
      id: 'charging-active',
      severity: 'success',
      icon: 'Zap',
      title: 'Charging in progress',
      description: `Currently charging — ${Math.round(status.soc)}% reached.`,
      action: { type: 'navigate', href: '/charging', label: 'View sessions' },
      priority: 45,
    })
  }

  // ── Battery health ─────────────────────────────────────────────────────────
  const degrad = health?.degradationPercent
  const soh = health?.sohPercent ?? health?.healthPercent
  if (degrad != null) {
    if (degrad >= 10) {
      insights.push({
        id: 'battery-health-bad',
        severity: 'danger',
        icon: 'HeartCrack',
        title: 'Significant battery degradation',
        description: `SoH at ${soh?.toFixed(1) ?? '?'}% — ${degrad.toFixed(1)}% capacity lost.`,
        action: { type: 'navigate', href: '/battery', label: 'Battery analytics' },
        priority: 90,
      })
    } else if (degrad >= 5) {
      insights.push({
        id: 'battery-health-warn',
        severity: 'warning',
        icon: 'Heart',
        title: 'Battery degradation detected',
        description: `${degrad.toFixed(1)}% capacity lost (SoH: ${soh?.toFixed(1) ?? '?'}%).`,
        action: { type: 'navigate', href: '/battery', label: 'Battery analytics' },
        priority: 60,
      })
    } else if (soh != null && soh >= 96) {
      insights.push({
        id: 'battery-health-good',
        severity: 'success',
        icon: 'HeartHandshake',
        title: 'Battery in great shape',
        description: `State of health at ${soh.toFixed(1)}% — minimal degradation.`,
        priority: 15,
      })
    }
  }

  // ── Cold weather impact ────────────────────────────────────────────────────
  // Only fire when cold + elevated consumption are both true; avoids false positives
  if (
    outsideTemp != null && outsideTemp < 5 &&
    tripsToday?.efficiencyWhKm != null && tripsToday.efficiencyWhKm > 200 &&
    tripsToday.distanceKm > 2
  ) {
    const tempStr = `${outsideTemp.toFixed(0)}°C`
    const effStr  = `${Math.round(tripsToday.efficiencyWhKm)} Wh/km`
    insights.push({
      id: 'cold-weather',
      severity: 'info',
      icon: 'Thermometer',
      title: 'Cold weather reducing range',
      description: `At ${tempStr} outside, battery is heating itself — consuming ${effStr} vs ~160 Wh/km in mild weather. Pre-heat while plugged in to minimise loss.`,
      priority: 55,
    })
  }

  // ── Vampire drain ──────────────────────────────────────────────────────────
  if (vampireDrainPerHr != null) {
    if (vampireDrainPerHr > 0.5) {
      // >0.5%/hr = abnormally high — likely Sentry mode or background app
      insights.push({
        id: 'vampire-spike',
        severity: 'warning',
        icon: 'Ghost',
        title: 'Vampire drain spike',
        description: `${vampireDrainPerHr.toFixed(2)}%/hr while parked — unusually high. Sentry Mode or a third-party app may be keeping the car awake.`,
        priority: 72,
      })
    } else if (vampireDrainPct != null && vampireDrainPct > 5) {
      insights.push({
        id: 'vampire-high',
        severity: 'warning',
        icon: 'Ghost',
        title: 'High vampire drain',
        description: `~${vampireDrainPct.toFixed(1)}% per parking event (${vampireDrainPerHr.toFixed(2)}%/hr). Check Sentry Mode settings.`,
        priority: 70,
      })
    } else if (vampireDrainPct != null && vampireDrainPct > 2) {
      insights.push({
        id: 'vampire-medium',
        severity: 'info',
        icon: 'Ghost',
        title: 'Moderate vampire drain',
        description: `~${vampireDrainPct.toFixed(1)}% average while parked (${vampireDrainPerHr.toFixed(2)}%/hr).`,
        priority: 35,
      })
    }
  } else if (vampireDrainPct != null) {
    if (vampireDrainPct > 5) {
      insights.push({
        id: 'vampire-high',
        severity: 'warning',
        icon: 'Ghost',
        title: 'High vampire drain',
        description: `~${vampireDrainPct.toFixed(1)}% per parking event. Check Sentry mode.`,
        priority: 70,
      })
    } else if (vampireDrainPct > 2) {
      insights.push({
        id: 'vampire-medium',
        severity: 'info',
        icon: 'Ghost',
        title: 'Moderate vampire drain',
        description: `~${vampireDrainPct.toFixed(1)}% average while parked.`,
        priority: 35,
      })
    }
  }

  // ── Today's driving efficiency ─────────────────────────────────────────────
  if (tripsToday?.efficiencyWhKm != null && tripsToday.distanceKm > 2) {
    const eff = tripsToday.efficiencyWhKm
    // Only show efficiency warning when cold weather isn't already explaining it
    const coldAlreadyExplained = outsideTemp != null && outsideTemp < 5
    if (eff > 280 && !coldAlreadyExplained) {
      insights.push({
        id: 'efficiency-poor',
        severity: 'warning',
        icon: 'TrendingUp',
        title: 'High energy use today',
        description: `${Math.round(eff)} Wh/km — city traffic or frequent acceleration may be the cause.`,
        action: { type: 'navigate', href: '/trips', label: 'View trips' },
        priority: 50,
        params: { efficiency: Math.round(eff) },
      })
    } else if (eff < 160) {
      insights.push({
        id: 'efficiency-great',
        severity: 'success',
        icon: 'TrendingDown',
        title: 'Excellent efficiency today',
        description: `Only ${Math.round(eff)} Wh/km — great driving conditions!`,
        action: { type: 'navigate', href: '/trips', label: 'View trips' },
        priority: 20,
        params: { efficiency: Math.round(eff) },
      })
    }
  }

  // ── Cost insight ───────────────────────────────────────────────────────────
  if (costPerKm != null && costPerKm > 0.08) {
    insights.push({
      id: 'cost-high',
      severity: 'info',
      icon: 'Euro',
      title: 'Above-average cost per km',
      description: `${fmtCost(costPerKm)}/km this month — off-peak charging can help.`,
      action: { type: 'navigate', href: '/charging', label: 'View costs' },
      priority: 25,
    })
  }

  // ── All good fallback ──────────────────────────────────────────────────────
  if (insights.length === 0) {
    insights.push({
      id: 'all-good',
      severity: 'success',
      icon: 'CheckCircle2',
      title: 'Everything looks great',
      description: 'Battery, health, and efficiency are all within normal ranges.',
      priority: 10,
    })
  }

  return insights.sort((a, b) => b.priority - a.priority)
}
