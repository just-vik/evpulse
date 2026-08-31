'use client'

import type {
  Vehicle,
  Trip,
  ChargingSession,
  TelemetryData,
  BatteryHealth,
  Automation,
  Notification,
  User,
  LoginResponse,
  PaginatedResponse,
  VehicleCommand,
  TelemetryStats,
  AutomationExecution,
} from '@/types/api'

// NotificationPreferences может отсутствовать в types/api — определяем здесь
export interface NotificationPreferences {
  email:    boolean
  push:     boolean
  telegram: boolean
  lowBatteryThreshold:   number
  chargingAlerts:        boolean
  locationAlerts:        boolean
  vehicleUnlockedAlerts: boolean
}

// ── Vehicle Status (расширенный) ────────────────────────────────────────────
export interface VehicleStatusResponse {
  vehicleId:      string
  // Battery
  soc:            number | null
  batteryRangeKm: number | null
  batteryTemp:    number | null
  // Motion
  speed:          number | null
  power:          number | null
  odometer:       number | null
  // Climate
  insideTemp:     number | null
  outsideTemp:    number | null
  // State
  vehicleState:   string
  chargingState:  string | null
  drivingState:   string | null
  locked:         boolean | null
  // Meta
  lastUpdate:        string | null
  // Data freshness — set by backend from telemetry timestamp
  isOnline:          boolean
  dataFreshnessSec:  number | null
  dataQuality:       'REALTIME' | 'DELAYED' | 'STALE' | 'OFFLINE'
}

// ── Vehicle spec (combined Vehicle + VehicleSpec) ────────────────────────────
export interface VehicleSpecResponse {
  vehicleId:            string
  vin:                  string
  model:                string
  displayName:          string
  trim:                 string | null
  year:                 number | null
  region:               string | null
  modelCode:            string | null
  generation:           string | null   // 'Juniper' | 'Highland' | null
  batteryNominalKwh:    number
  batteryUsableKwh:     number
  batteryDetectedKwh:   number | null
  peakChargingKw:       number | null
  driveType:            string | null
  cellChemistry:        string | null   // 'NMC' | 'LFP' | null
  chargeRecommendation: string | null   // 'charge_to_80' | 'charge_to_100' | null
  wltpKm:               number | null
}

// ── Vehicle settings (per-vehicle tariffs & thresholds) ─────────────────────
export interface VehicleSettings {
  vehicleId:           string
  homeChargingRate:    number
  superchargerRate:    number
  thirdPartyRate:      number
  defaultChargeLimit:  number
  lowBatteryThreshold: number
  updatedAt:           string
}

// ── Aggregate response types ────────────────────────────────────────────────
export interface TripsTodayResponse {
  vehicleId:      string
  tripCount:      number
  distanceKm:     number
  energyKwh:      number
  efficiencyWhKm: number | null
}

export interface ChargingSummaryResponse {
  vehicleId:     string
  sessions:      number
  energyKwh:     number
  avgSessionKwh: number | null
}

export interface CostSummaryResponse {
  vehicleId:   string
  period:      { startDate: string; endDate: string }
  energyKwh:   number
  totalCost:   number
  costPerKm:   number | null
  sessions:    number
  pricePerKwh: number
}

export interface CostTelemetryResponse {
  vehicleId: string
  period: { startDate: string; endDate: string }
  totalSessions: number
  teslaApiSessions: number
  fallbackSessions: number
  scopeMissingSessions: number
  manualSessions: number
  teslaCoveragePct: number
  pendingRetrySessions: number
  avgRetryAttempts: number
  maxRetryAttempts: number
  fallbackCostTotal: number
}

// ── Efficiency prediction ─────────────────────────────────────────────────────
export interface EfficiencyPredictionResponse {
  vehicleId:         string
  predictedWhKm:     number
  predictedRangeKm:  number
  assumptions?: {
    avgSpeed:    number
    outsideTemp: number
    usableKwh:   number
  }
}

// ── Cost forecast ─────────────────────────────────────────────────────────────
export interface CostForecastResponse {
  weeklyCost:      number
  monthlyCost:     number
  avgEnergyPerDay: number
  effectiveRate:   number
  rateSource:      'sessions' | 'settings' | 'default' | 'override'
  dataSource:      'daily_energy' | 'trips'
}

export interface RuntimeDiagnosticsResponse {
  appRole: 'api' | 'worker' | 'all'
  queueDepth: number
  counters: {
    pointsReceived: number
    pointsStored: number
    dedupDropped: number
    detectorErrors: number
  }
  rates: {
    dedupDropRatePct: number
    detectorErrorRatePct: number
  }
  timestamp: string
}

// ─────────────────────────────────────────────────────────────────────────────

// Always use relative URL — Next.js rewrites proxy /api/v1/* to the internal API container.
// This avoids CORS preflight entirely (same-origin from the browser's perspective).
// See rewrites() in next.config.js → INTERNAL_API_URL env var.
const API_BASE = ''

// ── Token-refresh machinery ──────────────────────────────────────────────────

let _refreshPromise: Promise<string | null> | null = null

function readAuthStorage(): {
  accessToken:  string | null
  refreshToken: string | null
  user:         { id: string } | null
} | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem('auth-storage')
    if (!raw) return null
    return JSON.parse(raw)?.state ?? null
  } catch {
    return null
  }
}

function writeTokens(accessToken: string, refreshToken: string): void {
  if (typeof window === 'undefined') return
  try {
    const raw = localStorage.getItem('auth-storage')
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (parsed?.state) {
      parsed.state.accessToken     = accessToken
      parsed.state.refreshToken    = refreshToken
      parsed.state.isAuthenticated = true
      localStorage.setItem('auth-storage', JSON.stringify(parsed))
    }
  } catch { /* best-effort */ }
}

function clearAuth(): void {
  if (typeof window === 'undefined') return
  try { localStorage.removeItem('auth-storage') } catch { /* ignore */ }
  if (typeof document !== 'undefined') {
    document.cookie =
      'access_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
  }
}

function setAccessCookie(token: string): void {
  if (typeof document === 'undefined') return
  const exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString()
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `access_token=${token}; path=/; expires=${exp}; SameSite=Lax${secure}`
}

async function tryRefreshToken(): Promise<string | null> {
  const state = readAuthStorage()
  if (!state?.refreshToken || !state?.user?.id) {
    clearAuth()
    return null
  }

  try {
    const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        userId:       state.user.id,
        refreshToken: state.refreshToken,
      }),
    })

    if (!res.ok) {
      clearAuth()
      if (typeof window !== 'undefined') window.location.href = '/login'
      return null
    }

    const data = await res.json()
    writeTokens(data.accessToken, data.refreshToken)
    setAccessCookie(data.accessToken)
    return data.accessToken as string
  } catch {
    clearAuth()
    return null
  }
}

// ── Core fetch wrapper ───────────────────────────────────────────────────────

async function apiCall<T>(
  endpoint:  string,
  options:   RequestInit = {},
  token?:    string | null,
  _isRetry = false,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }

  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  })

  // Transparent token refresh on 401
  if (res.status === 401 && token && !_isRetry) {
    if (!_refreshPromise) {
      _refreshPromise = tryRefreshToken().finally(() => { _refreshPromise = null })
    }
    const newToken = await _refreshPromise
    if (newToken) return apiCall<T>(endpoint, options, newToken, true)
    throw Object.assign(
      new Error('Session expired. Please log in again.'),
      { status: 401 },
    )
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }))
    throw Object.assign(
      new Error(body?.message ?? `API error ${res.status}`),
      { status: res.status },
    )
  }

  // 204 No Content
  if (res.status === 204) return undefined as unknown as T

  return res.json() as Promise<T>
}

// ── Typed API client ─────────────────────────────────────────────────────────

export const apiClient = {

  // ════════════════════════════════════════
  // VEHICLES
  // ════════════════════════════════════════

  getVehicles(
    token: string,
    init?: RequestInit,
  ): Promise<Vehicle[]> {
    return apiCall('/api/v1/vehicles', init ?? {}, token)
  },

  getRuntimeDiagnostics(token: string): Promise<RuntimeDiagnosticsResponse> {
    return apiCall('/api/v1/runtime/diagnostics', {}, token)
  },

  getVehicle(vehicleId: string, token: string): Promise<Vehicle> {
    return apiCall(`/api/v1/vehicles/${vehicleId}`, {}, token)
  },

  deleteVehicle(
    vehicleId: string,
    token:     string,
  ): Promise<void> {
    return apiCall(`/api/v1/vehicles/${vehicleId}`, { method: 'DELETE' }, token)
  },

  getVehicleSpec(
    vehicleId: string,
    token:     string,
  ): Promise<VehicleSpecResponse> {
    return apiCall(`/api/v1/vehicles/${vehicleId}/spec`, {}, token)
  },

  // Vehicle Settings (tariffs, limits)
  getVehicleSettings(
    vehicleId: string,
    token: string,
  ): Promise<VehicleSettings> {
    return apiCall(`/api/v1/vehicles/${vehicleId}/settings`, {}, token)
  },

  updateVehicleSettings(
    vehicleId: string,
    data: Partial<VehicleSettings>,
    token: string,
  ): Promise<VehicleSettings> {
    return apiCall(
      `/api/v1/vehicles/${vehicleId}/settings`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
      },
      token,
    )
  },

  sendVehicleCommand(
    vehicleId: string,
    command:   string,
    params:    Record<string, unknown>,
    token:     string,
  ): Promise<VehicleCommand> {
    const ROUTES: Record<string, string> = {
      'lock':           'lock',
      'unlock':         'unlock',
      'start-charging': 'start-charging',
      'stop-charging':  'stop-charging',
      'charge-limit':   'charge-limit',
      'climate':        'climate',
      'flash-lights':          'flash-lights',
      'honk':                  'honk',
      'frunk':                 'frunk',
      'trunk':                 'trunk',
      'windows':               'windows',
      'sentry':                'sentry',
      'charging-amps':         'charging-amps',
      'seat-heater':           'seat-heater',
      'overheat-protection':   'overheat-protection',
      'scheduled-charging':    'scheduled-charging',
      'scheduled-departure':   'scheduled-departure',
      'wake':                  'wake',
    }
    const route = ROUTES[command]
    if (!route) throw new Error(`Unsupported command: ${command}`)

    return apiCall(
      `/api/v1/vehicles/${vehicleId}/commands/${route}`,
      {
        method: 'POST',
        body:   Object.keys(params ?? {}).length ? JSON.stringify(params) : undefined,
      },
      token,
    )
  },

  // Упрощённый алиас для новых компонентов
  sendCommand(
    vehicleId: string,
    command:   string,
    token:     string,
  ): Promise<VehicleCommand> {
    return this.sendVehicleCommand(vehicleId, command, {}, token)
  },

  // ════════════════════════════════════════
  // VEHICLE STATUS  (dashboard live tile)
  // ════════════════════════════════════════

  getVehicleStatus(
    vehicleId: string,
    token:     string,
  ): Promise<VehicleStatusResponse> {
    return apiCall(`/api/v1/vehicles/${vehicleId}/status`, {}, token)
  },

  // ════════════════════════════════════════
  // TELEMETRY
  // ════════════════════════════════════════

  async getLatestTelemetry(
    vehicleId: string,
    token:     string,
  ): Promise<TelemetryData> {
    // Use the analytics/status endpoint which falls back to last known non-null
    // values for SOC, range and odometer — the raw /telemetry/:id/latest point
    // often has null SOC because fleet telemetry sends fields at different rates.
    const raw = await apiCall<Record<string, unknown>>(
      `/api/v1/vehicles/${vehicleId}/status`,
      {},
      token,
    )

    if (!raw) {
      return {
        batteryLevel:   null,
        batteryRangeKm: null,
        speedKmh:       null,
        odometerKm:     null,
        timestamp:      null,
      } as unknown as TelemetryData
    }

    return {
      ...raw,
      batteryLevel:   (raw.soc ?? null) as number | null,
      batteryRangeKm: (raw.batteryRangeKm ?? null) as number | null,
      speedKmh:       (raw.speed ?? null) as number | null,
      odometerKm:     (raw.odometer ?? null) as number | null,
      timestamp:      (raw.lastUpdate ?? null) as string | null,
    } as TelemetryData
  },

  wakePoll(vehicleId: string, token: string): Promise<void> {
    return apiCall(`/api/v1/telemetry/${vehicleId}/wake-poll`, { method: 'POST' }, token)
  },

  getTelemetryRange(
    vehicleId: string,
    startDate: string,
    endDate:   string,
    token:     string,
  ): Promise<TelemetryData[]> {
    const q = new URLSearchParams({ startDate, endDate })
    return apiCall(`/api/v1/telemetry/${vehicleId}/history?${q}`, {}, token)
  },

  getTelemetryStats(
    vehicleId: string,
    token:     string,
    startDate?: string,
    endDate?:   string,
  ): Promise<TelemetryStats | null> {
    const q = new URLSearchParams()
    if (startDate) q.set('startDate', startDate)
    if (endDate)   q.set('endDate',   endDate)
    const qs = q.toString()
    return apiCall(
      `/api/v1/telemetry/${vehicleId}/stats${qs ? `?${qs}` : ''}`,
      {},
      token,
    )
  },

  // ════════════════════════════════════════
  // TRIPS
  // ════════════════════════════════════════

  getTrips(
    vehicleId: string,
    limit  = 30,
    token  = '',
    opts?: { from?: string; to?: string },
  ): Promise<{ data: Trip[]; meta: { clamped: boolean; limitDays: number; plan: string } }> {
    const q = new URLSearchParams()
    q.set('limit', String(limit))
    if (opts?.from) q.set('from', opts.from)
    if (opts?.to) q.set('to', opts.to)
    return apiCall(`/api/v1/trips/vehicle/${vehicleId}?${q}`, {}, token)
  },

  /** Rebuild trips from telemetry_points for [from, to] — POST body, not query string. */
  backfillTrips(
    vehicleId: string,
    token: string,
    body?: { from?: string; to?: string },
  ): Promise<{ status: string; processed: number; socUpFiltered: number }> {
    return apiCall(
      `/api/v1/trips/vehicle/${vehicleId}/backfill`,
      { method: 'POST', body: JSON.stringify(body ?? {}) },
      token,
    )
  },

  /**
   * Delete existing trips in range and rebuild from telemetry — safe to run on already-recorded
   * days. Also re-reconciles (merges) fragments over the same range afterwards.
   *
   * Pass `dryRun: true` for a **reconcile-only preview** (no writes) — it does NOT simulate
   * telemetry re-detection/re-splitting, only previews merging of trips that already exist
   * in the range (`previewKind: 'reconcile_existing_only'`). See the API's JSDoc on
   * TripBackfillService.reconcilePreview() for why a full-rebuild simulation isn't done.
   */
  rebuildTrips(
    vehicleId: string,
    token: string,
    body: {
      from: string
      to?: string
      /**
       * dryRun=true performs reconcile_existing_only;
       * it does not simulate telemetry re-detection or a full rebuild.
       * Future: a dedicated `mode: 'reconcile_preview' | 'full_rebuild'` field would be
       * clearer than this overloaded boolean — not worth a contract change until
       * full_rebuild actually exists.
       */
      dryRun?: boolean
    },
  ): Promise<
    | {
        status: 'completed' | 'partial'
        dryRun: false
        rangeStart: string
        rangeEnd: string
        deleted: number
        processed: number
        socUpFiltered: number
        detected: number
        created: number
        filtered: number
        reconciled: boolean
        merged: number
        skippedDueToCharging: number
        warnings: string[]
      }
    | {
        previewKind: 'reconcile_existing_only'
        status: 'dry_run'
        dryRun: true
        rangeStart: string
        rangeEnd: string
        existingTrips: number
        candidatePairs: number
        mergeablePairs: number
        skippedDueToCharging: number
        warnings: string[]
      }
  > {
    return apiCall(
      `/api/v1/trips/vehicle/${vehicleId}/rebuild`,
      { method: 'POST', body: JSON.stringify(body) },
      token,
    )
  },

  /** Merge split trips (gap ≤ 5 min, same area) — idempotent; heals red-light / telemetry splits. */
  reconcileTrips(
    vehicleId: string,
    token: string,
    days = 14,
  ): Promise<{ status: string; merged: number }> {
    return apiCall(
      `/api/v1/trips/vehicle/${vehicleId}/reconcile?days=${days}`,
      { method: 'POST' },
      token,
    )
  },

  getTripStats(
    vehicleId: string,
    days  = 30,
    token = '',
  ): Promise<unknown> {
    return apiCall(
      `/api/v1/trips/vehicle/${vehicleId}/stats?days=${days}`,
      {},
      token,
    )
  },

  async downloadExport(
    entity: 'trips' | 'charging' | 'telemetry',
    params: { vehicleId: string; format: string; startDate?: string; endDate?: string },
    token: string,
  ): Promise<void> {
    const qs = new URLSearchParams({ vehicleId: params.vehicleId, format: params.format });
    if (params.startDate) qs.set('startDate', params.startDate);
    if (params.endDate)   qs.set('endDate',   params.endDate);
    const res = await fetch(`${API_BASE}/api/v1/export/${entity}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: 'Export failed' }));
      throw new Error(err.message ?? 'Export failed');
    }
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] ?? `${entity}.${params.format}`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },

  getLiveTelemetry(
    vehicleId: string,
    token: string,
    minutes = 30,
    limit = 120,
  ): Promise<{
    vehicleId: string;
    windowMinutes: number;
    points: { t: string; spd: number | null; pwr: number | null; soc: number | null; outsideTemp: number | null }[];
  }> {
    return apiCall(`/api/v1/telemetry/${vehicleId}/live?minutes=${minutes}&limit=${limit}`, {}, token);
  },

  getTripPoints(
    tripId: string,
    token = '',
  ): Promise<{
    tripId: string;
    startTime: string;
    endTime: string | null;
    points: { t: string; lat: number; lng: number; spd: number | null; pwr: number | null; soc: number | null }[];
  }> {
    return apiCall(`/api/v1/trips/${tripId}/points`, {}, token);
  },

  // ── Trips Today aggregate ──
  getTripsToday(
    vehicleId: string,
    token:     string,
  ): Promise<TripsTodayResponse> {
    // Pass local midnight as ISO so the server counts trips in the user's timezone,
    // not UTC midnight (which would misattribute late-night trips to the wrong day).
    const localMidnight = new Date()
    localMidnight.setHours(0, 0, 0, 0)
    const q = new URLSearchParams({ dayStart: localMidnight.toISOString() })
    return apiCall(`/api/v1/vehicles/${vehicleId}/trips/today?${q}`, {}, token)
  },

  // ════════════════════════════════════════
  // CHARGING
  // ════════════════════════════════════════

  getChargingSessions(
    vehicleId: string,
    limit  = 30,
    token  = '',
    opts?: { from?: string; to?: string },
  ): Promise<{ data: ChargingSession[]; meta: { clamped: boolean; limitDays: number; plan: string } }> {
    const q = new URLSearchParams()
    q.set('limit', String(limit))
    if (opts?.from) q.set('from', opts.from)
    if (opts?.to) q.set('to', opts.to)
    return apiCall(
      `/api/v1/charging/vehicle/${vehicleId}/sessions?${q}`,
      {},
      token,
    )
  },

  /** Merge fragmented DB rows from telemetry gaps (runs cheaply; idempotent). */
  reconcileChargingSessions(
    vehicleId: string,
    token: string,
    days = 90,
  ): Promise<{ merged: number }> {
    return apiCall(
      `/api/v1/charging/vehicle/${vehicleId}/reconcile-sessions?days=${days}`,
      { method: 'POST' },
      token,
    )
  },

  getChargingStats(
    vehicleId: string,
    days  = 30,
    token = '',
  ): Promise<unknown> {
    return apiCall(
      `/api/v1/charging/vehicle/${vehicleId}/stats?days=${days}`,
      {},
      token,
    )
  },

  getChargingSummary(
    vehicleId: string,
    token:     string,
  ): Promise<ChargingSummaryResponse> {
    return apiCall(
      `/api/v1/vehicles/${vehicleId}/charging/summary`,
      {},
      token,
    )
  },

  // ════════════════════════════════════════
  // COST
  // ════════════════════════════════════════

  getCostSummary(
    vehicleId: string,
    rate: number | undefined,
    token = '',
  ): Promise<CostSummaryResponse> {
    // No rate → API resolves from settings (homeChargingRate) → default 0.25
    const q = rate != null ? `?rate=${rate}` : ''
    return apiCall(
      `/api/v1/vehicles/${vehicleId}/cost${q}`,
      {},
      token,
    )
  },

  getCostTelemetry(
    vehicleId: string,
    token = '',
  ): Promise<CostTelemetryResponse> {
    return apiCall(
      `/api/v1/vehicles/${vehicleId}/cost-telemetry`,
      {},
      token,
    )
  },

  // ════════════════════════════════════════
  // ANALYTICS
  // ════════════════════════════════════════

  getEnergyHistory(
    vehicleId: string,
    days  = 30,
    token = '',
  ): Promise<unknown> {
    return apiCall(
      `/api/v1/analytics/vehicle/${vehicleId}/energy-history?days=${days}`,
      {},
      token,
    )
  },

  getChargingCosts(
    vehicleId: string,
    rate  = 0.35,
    token = '',
  ): Promise<unknown> {
    return apiCall(
      `/api/v1/analytics/vehicle/${vehicleId}/charging-costs?rate=${rate}`,
      {},
      token,
    )
  },

  getVampireDrainStats(
    vehicleId: string,
    days = 30,
    token = '',
  ): Promise<unknown> {
    return apiCall(
      `/api/v1/telemetry/${vehicleId}/vampire-drain?days=${days}`,
      {},
      token,
    )
  },

  getChargingCostSummary(
    vehicleId: string,
    months = 3,
    token = '',
  ): Promise<unknown> {
    return apiCall(
      `/api/v1/charging/vehicle/${vehicleId}/cost-summary?months=${months}`,
      {},
      token,
    )
  },

  setSessionManualCost(
    sessionId: string,
    manualCost: number,
    token = '',
  ): Promise<unknown> {
    return apiCall(
      `/api/v1/charging/sessions/${sessionId}/cost`,
      { method: 'PUT', body: JSON.stringify({ manualCost }) },
      token,
    )
  },

  // ════════════════════════════════════════
  // BATTERY
  // ════════════════════════════════════════

  getBatteryHealth(
    vehicleId: string,
    token:     string,
  ): Promise<BatteryHealth> {
    return apiCall(`/api/v1/battery/${vehicleId}/health`, {}, token)
  },

  getBatteryHistory(
    vehicleId: string,
    days  = 30,
    token = '',
  ): Promise<BatteryHealth[]> {
    return apiCall(
      `/api/v1/battery/${vehicleId}/history?days=${days}`,
      {},
      token,
    )
  },

  // ════════════════════════════════════════
  // AI / PREDICTIONS
  // ════════════════════════════════════════

  getEfficiencyPrediction(
    vehicleId: string,
    token:     string,
  ): Promise<EfficiencyPredictionResponse | null> {
    return apiCall(
      `/api/v1/analytics/vehicle/${vehicleId}/efficiency-prediction`,
      {},
      token,
    )
  },

  getCostForecast(
    vehicleId: string,
    token: string,
    pricePerKwhOverride?: number,
  ): Promise<CostForecastResponse> {
    const q = pricePerKwhOverride
      ? new URLSearchParams({ pricePerKwh: String(pricePerKwhOverride) }).toString()
      : ''
    return apiCall(
      `/api/v1/analytics/vehicle/${vehicleId}/cost-forecast${q ? `?${q}` : ''}`,
      {},
      token,
    )
  },

  // ════════════════════════════════════════
  // TESLA OAUTH
  // ════════════════════════════════════════

  initiateTeslaLink(token: string): Promise<{ url: string }> {
    return apiCall('/api/v1/auth/tesla/link', { method: 'POST' }, token)
  },

  getTeslaStatus(
    token: string,
  ): Promise<{
    connected: boolean
    authExpired?: boolean
    expiresAt?: string
    dataBlockedReason?: 'telemetry_stale' | null
    guardrail?: {
      monthlyBudgetEur: number
      softLimitEur: number
      estimatedMonthSpendEur: number
    }
  }> {
    return apiCall('/api/v1/auth/tesla/status', {}, token)
  },

  configureTeslaTelemetry(
    token: string,
  ): Promise<{ ok: boolean }> {
    return apiCall('/api/v1/auth/tesla/configure-telemetry', { method: 'POST' }, token)
  },

  disconnectTesla(token: string): Promise<{ success: boolean }> {
    return apiCall('/api/v1/auth/tesla/disconnect', { method: 'POST' }, token)
  },

  getFleetTelemetryStatus(token: string): Promise<{
    vehicles: Array<{
      vehicleId: string;
      vin: string | null;
      keyPaired: boolean | null;
      synced: boolean | null;
      configured: boolean;
    }>;
  }> {
    return apiCall('/api/v1/auth/tesla/fleet-telemetry-status', {}, token)
  },

  addVehicle(
    data:  { vin: string; model: string; trim?: string; year?: number },
    token: string,
  ): Promise<Vehicle> {
    return apiCall('/api/v1/vehicles', {
      method: 'POST',
      body:   JSON.stringify(data),
    }, token)
  },

  // ════════════════════════════════════════
  // AUTOMATIONS
  // ════════════════════════════════════════

  getAutomations(token: string): Promise<Automation[]> {
    return apiCall('/api/v1/automations', {}, token)
  },

  getAutomation(id: string, token: string): Promise<Automation> {
    return apiCall(`/api/v1/automations/${id}`, {}, token)
  },

  createAutomation(
    data:  Partial<Automation>,
    token: string,
  ): Promise<Automation> {
    return apiCall('/api/v1/automations', {
      method: 'POST',
      body:   JSON.stringify(data),
    }, token)
  },

  updateAutomation(
    id:    string,
    data:  Partial<Automation>,
    token: string,
  ): Promise<Automation> {
    return apiCall(`/api/v1/automations/${id}`, {
      method: 'PATCH',
      body:   JSON.stringify(data),
    }, token)
  },

  deleteAutomation(id: string, token: string): Promise<void> {
    return apiCall(`/api/v1/automations/${id}`, { method: 'DELETE' }, token)
  },

  getAutomationExecutions(
    id:    string,
    token: string,
  ): Promise<AutomationExecution[]> {
    return apiCall(`/api/v1/automations/${id}/executions`, {}, token)
  },

  // ════════════════════════════════════════
  // NOTIFICATIONS
  // ════════════════════════════════════════

  getNotifications(
    page  = 1,
    limit = 20,
    token = '',
  ): Promise<PaginatedResponse<Notification>> {
    return apiCall(
      `/api/v1/notifications?page=${page}&limit=${limit}`,
      {},
      token,
    )
  },

  markNotificationRead(
    id:    string,
    token: string,
  ): Promise<Notification> {
    return apiCall(`/api/v1/notifications/${id}/read`, {
      method: 'PATCH',
      body:   JSON.stringify({ read: true }),
    }, token)
  },

  getNotificationPreferences(
    token: string,
  ): Promise<NotificationPreferences> {
    return apiCall('/api/v1/notifications/preferences', {}, token)
  },

  updateNotificationPreferences(
    prefs: Partial<NotificationPreferences>,
    token: string,
  ): Promise<NotificationPreferences> {
    return apiCall('/api/v1/notifications/preferences', {
      method: 'PATCH',
      body:   JSON.stringify(prefs),
    }, token)
  },

  // ── Notification Rules ──────────────────────────────────────────────────────

  getNotificationRules(token: string): Promise<any[]> {
    return apiCall('/api/v1/notifications/rules', {}, token)
  },

  createNotificationRule(data: any, token: string): Promise<any> {
    return apiCall('/api/v1/notifications/rules', {
      method: 'POST',
      body:   JSON.stringify(data),
    }, token)
  },

  updateNotificationRule(id: string, data: any, token: string): Promise<any> {
    return apiCall(`/api/v1/notifications/rules/${id}`, {
      method: 'PUT',
      body:   JSON.stringify(data),
    }, token)
  },

  deleteNotificationRule(id: string, token: string): Promise<any> {
    return apiCall(`/api/v1/notifications/rules/${id}`, { method: 'DELETE' }, token)
  },

  getNotificationRuleHistory(
    ruleId: string,
    limit = 5,
    token = '',
  ): Promise<Array<{ id: string; title: string; body: string; createdAt: string; vehicleId: string | null; read: boolean }>> {
    return apiCall(`/api/v1/notifications/rules/${ruleId}/history?limit=${limit}`, {}, token)
  },

  // ── Notification Settings (Telegram / channels) ─────────────────────────────

  getNotificationSettings(token: string): Promise<any> {
    return apiCall('/api/v1/notifications/settings', {}, token)
  },

  updateNotificationSettings(data: any, token: string): Promise<any> {
    return apiCall('/api/v1/notifications/settings', {
      method: 'PUT',
      body:   JSON.stringify(data),
    }, token)
  },

  markAllNotificationsRead(token: string): Promise<any> {
    return apiCall('/api/v1/notifications/read-all', { method: 'POST' }, token)
  },

  getUnreadNotificationsCount(token: string): Promise<{ count: number }> {
    return apiCall('/api/v1/notifications/unread-count', {}, token)
  },

  getVapidPublicKey(token: string): Promise<{ publicKey: string }> {
    return apiCall('/api/v1/notifications/push/vapid-key', {}, token)
  },

  subscribePush(
    sub: { endpoint: string; p256dh: string; auth: string },
    token: string,
  ): Promise<void> {
    return apiCall('/api/v1/notifications/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(sub),
    }, token)
  },

  unsubscribePush(endpoint: string, token: string): Promise<void> {
    return apiCall('/api/v1/notifications/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }, token)
  },

  // ════════════════════════════════════════
  // USER / AUTH
  // ════════════════════════════════════════

  getCurrentUser(token: string): Promise<User> {
    return apiCall('/api/v1/users/profile', {}, token)
  },

  updateProfile(data: Partial<User>, token: string): Promise<User> {
    return apiCall('/api/v1/users/profile', {
      method: 'PATCH',
      body:   JSON.stringify(data),
    }, token)
  },

  changePassword(currentPassword: string, newPassword: string, token: string): Promise<void> {
    return apiCall('/api/v1/users/password', {
      method: 'PATCH',
      body:   JSON.stringify({ currentPassword, newPassword }),
    }, token)
  },

  updatePreferences(
    prefs: Partial<User['preferences']>,
    token: string,
  ): Promise<User> {
    return apiCall('/api/v1/users/me/preferences', {
      method: 'PATCH',
      body:   JSON.stringify(prefs),
    }, token)
  },

  login(email: string, password: string): Promise<LoginResponse> {
    return apiCall('/api/v1/auth/login', {
      method: 'POST',
      body:   JSON.stringify({ email, password }),
    })
  },

  register(
    firstName: string,
    lastName:  string,
    email:     string,
    password:  string,
  ): Promise<LoginResponse> {
    return apiCall('/api/v1/auth/register', {
      method: 'POST',
      body:   JSON.stringify({ firstName, lastName, email, password }),
    })
  },

  refreshToken(
    userId:       string,
    refreshToken: string,
  ): Promise<LoginResponse> {
    return apiCall('/api/v1/auth/refresh', {
      method: 'POST',
      body:   JSON.stringify({ userId, refreshToken }),
    })
  },

  getMe(token: string): Promise<User> {
    return apiCall('/api/v1/auth/me', {}, token)
  },

  logout(token: string): Promise<void> {
    return apiCall<void>('/api/v1/auth/logout', { method: 'POST' }, token)
      .catch(() => { /* silent — очищаем локально */ })
  },

  /** GDPR Art.17 + Apple App Store: full account + data deletion with Tesla revoke */
  deleteAccount(token: string): Promise<{ deleted: true }> {
    return apiCall<{ deleted: true }>('/api/v1/auth/tesla/account', { method: 'DELETE' }, token)
  },

  // ════════════════════════════════════════
  // DASHBOARD AGGREGATE
  // ════════════════════════════════════════

  getDashboardSummary(
    vehicleId: string,
    rate = 0.35,
    token = '',
  ): Promise<{
    status:          VehicleStatusResponse
    tripsToday:      TripsTodayResponse
    chargingSummary: ChargingSummaryResponse
    costSummary:     CostSummaryResponse
  }> {
    return apiCall(
      `/api/v1/vehicles/${vehicleId}/dashboard?rate=${rate}`,
      {},
      token,
    )
  },

  // ════════════════════════════════════════
  // FULL DASHBOARD (with battery + drain)
  // ════════════════════════════════════════

  getFullDashboard(
    vehicleId: string,
    rate = 0.35,
    token = '',
  ): Promise<{
    status:          VehicleStatusResponse
    tripsToday:      TripsTodayResponse
    chargingSummary: ChargingSummaryResponse
    costSummary:     CostSummaryResponse
    batteryHealth:   Record<string, any> | null
    vampireDrain:    Record<string, any> | null
  }> {
    return apiCall(
      `/api/v1/vehicles/${vehicleId}/dashboard/full?rate=${rate}`,
      {},
      token,
    )
  },

  // ════════════════════════════════════════
  // AI INSIGHTS
  // ════════════════════════════════════════

  getAIInsights(
    context: object,
    token = '',
  ): Promise<Array<{
    id: string
    severity: string
    icon: string
    title: string
    description: string
    action?: { type: string; href?: string; command?: string; prompt?: string; label: string }
    priority: number
    /** Raw numeric values behind title/description, present for the rule-based fallback. */
    params?: Record<string, number>
  }>> {
    return apiCall('/api/v1/ai/insights', {
      method: 'POST',
      body: JSON.stringify(context),
    }, token)
  },

  // ════════════════════════════════════════
  // AI CHAT
  // ════════════════════════════════════════

  askAI(
    message: string,
    vehicleId: string | null,
    token = '',
  ): Promise<{ answer: string }> {
    return apiCall('/api/v1/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message, vehicleId }),
    }, token)
  },

  // ════════════════════════════════════════
  // AI ACTIVITY LOG
  // ════════════════════════════════════════

  getAIActivity(
    vehicleId: string,
    token = '',
  ): Promise<Array<{ action: string; executedAt: string; success: boolean }>> {
    return apiCall(`/api/v1/ai/activity/${vehicleId}`, {}, token)
  },

  // ════════════════════════════════════════
  // AI FEEDBACK
  // ════════════════════════════════════════

  recordAIFeedback(
    body: { vehicleId: string; insightId: string; title: string; severity: string; accepted: boolean },
    token = '',
  ): Promise<{ ok: boolean }> {
    return apiCall('/api/v1/ai/feedback', {
      method: 'POST',
      body: JSON.stringify(body),
    }, token)
  },

  // ════════════════════════════════════════
  // AI PREFERENCES
  // ════════════════════════════════════════

  getAIPreferences(
    token = '',
  ): Promise<{ autoMode: string; maxAutoActionsPerHour: number }> {
    return apiCall('/api/v1/ai/preferences', {}, token)
  },

  setAIPreferences(
    prefs: { autoMode?: string; maxAutoActionsPerHour?: number },
    token = '',
  ): Promise<{ autoMode: string; maxAutoActionsPerHour: number }> {
    return apiCall('/api/v1/ai/preferences', {
      method: 'POST',
      body: JSON.stringify(prefs),
    }, token)
  },

  // ════════════════════════════════════════
  // BILLING
  // ════════════════════════════════════════

  getBillingStatus(token = ''): Promise<{
    plan: string; status: string; pastDue: boolean;
    maxVehicles: number; tripHistoryDays: number; chargingHistoryDays: number;
    analyticsDepthDays: number; liveRefreshSeconds: number;
    aiInsights: boolean; fleetDashboard: boolean; webhooks: boolean;
  }> {
    return apiCall('/api/v1/billing/me', {}, token)
  },

  createCheckoutSession(plan: 'PRO' | 'FLEET', token = ''): Promise<{ url: string }> {
    return apiCall('/api/v1/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan }),
    }, token)
  },

  createPortalSession(token = ''): Promise<{ url: string }> {
    return apiCall('/api/v1/billing/portal', { method: 'POST' }, token)
  },

  // ════════════════════════════════════════
  // COMMAND PRESETS & HISTORY
  // ════════════════════════════════════════

  getCommandPresets(vehicleId?: string, token = ''): Promise<CommandPreset[]> {
    const qs = vehicleId ? `?vehicleId=${vehicleId}` : '';
    return apiCall(`/api/v1/commands/presets${qs}`, {}, token);
  },

  createCommandPreset(data: { vehicleId?: string; name: string; command: string; params?: any; icon?: string; sortOrder?: number }, token = ''): Promise<CommandPreset> {
    return apiCall('/api/v1/commands/presets', { method: 'POST', body: JSON.stringify(data) }, token);
  },

  updateCommandPreset(id: string, data: { name?: string; params?: any; icon?: string; sortOrder?: number }, token = ''): Promise<CommandPreset> {
    return apiCall(`/api/v1/commands/presets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }, token);
  },

  deleteCommandPreset(id: string, token = ''): Promise<{ deleted: boolean }> {
    return apiCall(`/api/v1/commands/presets/${id}`, { method: 'DELETE' }, token);
  },

  getCommandHistory(vehicleId: string, limit = 20, token = ''): Promise<CommandHistoryItem[]> {
    return apiCall(`/api/v1/commands/history?vehicleId=${vehicleId}&limit=${limit}`, {}, token);
  },

  // ════════════════════════════════════════
  // LOGIN HISTORY
  // ════════════════════════════════════════

  getLoginHistory(limit = 20, token = ''): Promise<LoginEvent[]> {
    return apiCall(`/api/v1/auth/login-history?limit=${limit}`, {}, token);
  },
}

export interface CommandPreset {
  id: string;
  userId: string;
  vehicleId: string | null;
  name: string;
  command: string;
  params: any | null;
  icon: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface CommandHistoryItem {
  id: string;
  command: string;
  params: any | null;
  status: 'pending' | 'success' | 'failed';
  error: string | null;
  executedAt: string;
}

export interface LoginEvent {
  id: string;
  ip: string | null;
  userAgent: string | null;
  device: string | null;
  success: boolean;
  failReason: string | null;
  createdAt: string;
}

export default apiClient
