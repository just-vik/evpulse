/* ------------------------------------------------ */
/* ENUMS */
/* ------------------------------------------------ */

export type VehicleModel = 'S' | '3' | 'X' | 'Y'

export type VehicleState = 'online' | 'asleep' | 'offline'

export type ChargeState = 'charging' | 'discharging' | 'idle'

export type DrivingState = 'driving' | 'idle' | 'charging'

export type CommandStatus = 'pending' | 'completed' | 'failed'

export type ChargerType =
  | 'wall_connector'
  | 'supercharger'
  | 'mobile_connector'
  | 'third_party'

/* ------------------------------------------------ */
/* VEHICLES */
/* ------------------------------------------------ */

export interface Vehicle {
  id: string
  userId: string

  // From Prisma: String? @unique
  teslaId?: string | null
  vin: string

  // Backend returns model/trim/status + displayName
  model: string
  trim?: string | null
  year?: number | null
  status: string

  displayName: string

  batteryCapacityNominal: number
  batteryCapacityUsable: number

  // latest state snapshot
  vehicleState: VehicleState | 'offline'
  chargingState: string | null
  locked: boolean
  odometer?: number | null
  lastUpdate?: string | null

  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------ */
/* VEHICLE COMMANDS */
/* ------------------------------------------------ */

export type VehicleCommandType =
  | 'lock'
  | 'unlock'
  | 'start_charge'
  | 'stop_charge'
  | 'climate_on'
  | 'climate_off'
  | 'set_temp'

export interface VehicleCommand {

  id: string
  vehicleId: string

  command: VehicleCommandType

  status: CommandStatus

  result?: string | null

  createdAt: string
  completedAt?: string | null
}

/* ------------------------------------------------ */
/* TELEMETRY */
/* ------------------------------------------------ */

export interface TelemetryData {

  id?: string
  vehicleId?: string

  timestamp: string | null

  /* Battery */

  batteryLevel: number | null
  batteryRangeKm: number | null
  batteryHealthPercent?: number | null

  /* Location */

  latitude?: number | null
  longitude?: number | null
  altitude?: number | null

  /* Motion */

  speedKmh: number | null
  heading?: number | null

  // Battery pack temperature (°C) if available
  batteryTemp?: number | null

  /* Power — backend returns power in kW directly */

  power?: number | null
  powerInputW?: number | null
  powerOutputW?: number | null

  /* Climate */

  insideTemp?: number | null
  outsideTemp?: number | null
  autoConditioning?: boolean | null

  /* State */

  chargeState?: ChargeState | null
  vehicleState?: VehicleState | null
  drivingState?: DrivingState | null

  /* Odometer */

  odometerKm: number | null

  /* Doors */

  doorFL?: boolean | null
  doorFR?: boolean | null
  doorRL?: boolean | null
  doorRR?: boolean | null
  trunkOpen?: boolean | null

  locked?: boolean | null

  createdAt?: string
}

/* ------------------------------------------------ */
/* TELEMETRY STATS (match backend getStatistics) */
/* ------------------------------------------------ */

export interface TelemetryStatsPeriod {
  startTime: string
  endTime: string
}

export interface TelemetryStatsRangeField {
  avg: number | null
  min: number | null
  max: number | null
}

export interface TelemetryStats {
  period: TelemetryStatsPeriod
  pointCount: number
  battery: TelemetryStatsRangeField
  speed: TelemetryStatsRangeField
  power: TelemetryStatsRangeField
  temp: TelemetryStatsRangeField
}

/* ------------------------------------------------ */
/* TRIPS */
/* ------------------------------------------------ */

export interface Trip {

  id: string
  vehicleId: string

  startedAt: string
  endedAt: string

  distanceKm: number
  durationMinutes: number

  startBattery: number
  endBattery: number

  energyUsedKwh: number

  efficiencyWhKm: number

  startLatitude: number
  startLongitude: number

  endLatitude: number
  endLongitude: number

  startAddress?: string
  endAddress?: string

  startTemp?: number
  endTemp?: number

  createdAt: string
}

export interface TripPoint {

  id: string
  tripId: string

  latitude: number
  longitude: number
  altitude?: number

  batteryLevel: number
  speedKmh: number

  timestamp: string
}

/* ------------------------------------------------ */
/* CHARGING */
/* ------------------------------------------------ */

export interface ChargingSession {

  id: string
  vehicleId: string

  chargerName: string
  chargerType: ChargerType

  startedAt: string
  endedAt?: string | null

  durationMinutes?: number | null

  startBatteryLevel: number
  endBatteryLevel?: number | null

  energyAddedKwh?: number | null
  energyRateKw?: number | null

  costUsd?: number | null

  latitude?: number
  longitude?: number

  address?: string

  status: 'charging' | 'completed' | 'stopped'

  createdAt: string
}

/* ------------------------------------------------ */
/* BATTERY HEALTH */
/* ------------------------------------------------ */

export interface BatteryHealth {
  vehicleId:            string

  // State of Health
  sohPercent:           number   // display value — capped at 100% before baseline is locked
  sohRaw?:              number   // raw calculated value (may exceed 100% before baseline lock)
  isEstimate?:          boolean  // true when no baseline locked yet (any unconfirmed state)
  degradationPercent:   number

  // Capacity
  estimatedCapacityKwh: number
  nominalCapacityKwh:   number

  // Confidence
  confidenceScore:      number   // 0–1; < 0.6 means insufficient data
  lowData?:             boolean  // true when confidenceScore < 0.6
  method:               string

  // Calibration state — dual-tier baseline
  baselineLocked:       boolean                       // true if either HIGH or MEDIUM tier is locked
  baselineConfidence?:  'HIGH' | 'MEDIUM' | 'NONE'   // which tier is active
  baselineKwh?:         number | null                 // effective baseline (HIGH ?? MEDIUM)
  baselineHighKwh?:     number | null                 // from ≥10 full charges (endSoc≥90%)
  baselineMediumKwh?:   number | null                 // from ≥15 partial charges (endSoc 70–90%)
  baselineLockedAt?:    string | null

  // Cycles
  cycles?:              number | null

  // Per-method breakdown
  tripSoh?:             number | null
  chargingSoh?:         number | null
  ratedRangeSoh?:       number | null

  avgBatteryTempC?:     number | null
  updatedAt?:           string | null

  vehicle?: {
    model: string
    year?:  number | null
    spec?:  { batteryNominalKwh: number; batteryUsableKwh: number; rangeWltp?: number } | null
  }

  // Legacy fields kept for backwards compat with older API versions
  healthPercent?:       number
  cycleCount?:          number
  maxCapacityKwh?:      number
}

/* ------------------------------------------------ */
/* AUTOMATIONS */
/* ------------------------------------------------ */

export interface Automation {

  id: string

  userId: string
  vehicleId?: string | null

  name: string
  description?: string

  enabled: boolean

  conditions: AutomationCondition[]
  actions: AutomationAction[]

  schedule: {

    type: 'always' | 'time-based' | 'location-based'

    cronExpression?: string
    weekDays?: number[]

    locations?: {
      latitude: number
      longitude: number
      radiusM: number
    }[]
  }

  createdAt: string
  updatedAt: string
}

export interface AutomationCondition {

  field:
  | 'batteryLevel'
  | 'speed'
  | 'temperature'
  | 'chargingState'
  | 'timeOfDay'
  | 'location'

  operator:
  | '='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'in'
  | 'not-in'

  value: string | number | string[]
}

export interface AutomationAction {

  type:
  | 'charging'
  | 'climate'
  | 'notification'
  | 'command'

  target:
  | 'start-charge'
  | 'stop-charge'
  | 'climate-on'
  | 'climate-off'
  | 'lock'
  | 'unlock'
  | 'email'
  | 'push'
  | 'telegram'

  parameters: Record<string, unknown>
}

export interface AutomationExecution {

  id: string
  automationId: string
  vehicleId: string

  status: 'pending' | 'success' | 'failed'

  error?: string | null

  executedAt: string
}

/* ------------------------------------------------ */
/* NOTIFICATIONS */
/* ------------------------------------------------ */

export interface Notification {

  id: string

  userId: string
  vehicleId?: string | null

  type: 'info' | 'warning' | 'critical'

  title: string
  message: string

  channels: ('email' | 'push' | 'telegram' | 'in-app')[]

  trigger:
  | 'low-battery'
  | 'charging-complete'
  | 'vehicle-unlocked'
  | 'location-alert'
  | 'automation'
  | 'system'

  read: boolean
  readAt?: string | null

  createdAt: string

  actionUrl?: string
}

/* ------------------------------------------------ */
/* USERS */
/* ------------------------------------------------ */

export interface User {

  id: string
  email: string

  firstName?: string
  lastName?: string

  role?: string

  preferences?: {

    theme?: 'light' | 'dark' | 'auto'
    timezone?: string
    units?: 'imperial' | 'metric'
    language?: string
  }

  createdAt?: string
  updatedAt?: string
}

/* ------------------------------------------------ */
/* AUTH */
/* ------------------------------------------------ */

export interface LoginResponse {

  accessToken: string
  refreshToken: string

  user: User
}

export interface AuthSession {

  user: {
    id: string
    email: string
    name: string
    image?: string | null
  }

  expires: string
}

/* ------------------------------------------------ */
/* API */
/* ------------------------------------------------ */

export interface ApiResponse<T> {

  success: boolean
  data?: T
  error?: string
  message?: string
}

export interface PaginatedResponse<T> {

  data: T[]

  total: number

  page: number
  pageSize: number

  hasMore: boolean
}

/* ------------------------------------------------ */
/* WEBSOCKET */
/* ------------------------------------------------ */

export interface WebSocketMessage {

  type:
  | 'telemetry'
  | 'charging'
  | 'trip'
  | 'notification'
  | 'vehicle-update'
  | 'error'

  vehicleId?: string

  data: unknown

  timestamp: string
}