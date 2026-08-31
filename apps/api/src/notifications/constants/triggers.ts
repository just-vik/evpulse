export enum TriggerType {
  SOC_BELOW = 'SOC_BELOW',
  SOC_ABOVE = 'SOC_ABOVE',
  CHARGING_STARTED = 'CHARGING_STARTED',
  CHARGING_COMPLETE = 'CHARGING_COMPLETE',
  VEHICLE_UNLOCKED = 'VEHICLE_UNLOCKED',
  SPEED_ABOVE = 'SPEED_ABOVE',
  GEOFENCE_EXIT = 'GEOFENCE_EXIT',
  NOT_CHARGING_AT_HOME = 'NOT_CHARGING_AT_HOME',
  DEGRADATION_ABOVE = 'DEGRADATION_ABOVE',
  VAMPIRE_DRAIN_ABOVE = 'VAMPIRE_DRAIN_ABOVE',
}

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  [TriggerType.SOC_BELOW]: 'Battery below %',
  [TriggerType.SOC_ABOVE]: 'Battery above %',
  [TriggerType.CHARGING_STARTED]: 'Charging started',
  [TriggerType.CHARGING_COMPLETE]: 'Charging complete',
  [TriggerType.VEHICLE_UNLOCKED]: 'Vehicle unlocked',
  [TriggerType.SPEED_ABOVE]: 'Speed above km/h',
  [TriggerType.GEOFENCE_EXIT]: 'Geofence exit',
  [TriggerType.NOT_CHARGING_AT_HOME]: 'Not charging at home (SOC below %)',
  [TriggerType.DEGRADATION_ABOVE]: 'Battery degradation above %',
  [TriggerType.VAMPIRE_DRAIN_ABOVE]: 'Vampire drain above %/hr',
};

export interface TriggerContext {
  vehicleId: string;
  soc?: number | null;
  speed?: number | null;
  chargingState?: string | null;
  locked?: boolean | null;
  latitude?: number | null;
  longitude?: number | null;
}
