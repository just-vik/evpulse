import type { VehicleState } from '@/types/api'

// Mirrors the backend VehicleState enum (apps/api/src/tesla-fleet/vehicle-state-machine.service.ts).
// The web must not invent states: anything not produced by the backend is not a VehicleState.
export const VEHICLE_STATES: readonly VehicleState[] = [
  'driving',
  'stopped',
  'parked',
  'charging',
  'sleeping',
  'waking',
  'offline',
]

// Awake = the car is reachable and responding to telemetry, regardless of motion.
const AWAKE_STATES: ReadonlySet<string> = new Set(['driving', 'stopped', 'parked', 'charging'])

export function isVehicleAwake(state: string | null | undefined): boolean {
  return state != null && AWAKE_STATES.has(state)
}
