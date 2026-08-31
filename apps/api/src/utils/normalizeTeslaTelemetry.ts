export function normalizeTeslaPayload(raw: any): {
  timestamp: string;
  speed: number;
  power: number;
  soc: number | null;
  batteryRangeKm?: number | null;
  latitude: number | null;
  longitude: number | null;
  elevationM: number | null;
  charging_state: string;
  current: number | null;
  voltage: number | null;
  odometer: number | null;
  heading: number | null;
  batteryTemp: number | null;
  outsideTemp: number | null;
  insideTemp: number | null;
  fast_charger_type: string | null;
  fast_charger_brand: string | null;
  charge_energy_added: number | null;
  shift_state: string | null;
  /** Cumulative km with FSD/Autopilot active (Tesla SelfDrivingMilesSinceReset, converted from miles). */
  self_driving_km: number | null;
  /** Total km since last factory reset (Tesla MilesSinceReset, converted from miles). */
  odometer_km_since_reset: number | null;
} {
  // Fleet Telemetry webhook format: {"vin": "...", "createdAt": "...", "data": [{"key": "Speed", "value": {"doubleValue": 45}}]}
  if (raw && raw.vin && Array.isArray(raw.data)) {
    const fields: Record<string, any> = {};
    for (const item of raw.data) {
      const val = item.value;
      if (val == null) continue;
      // locationValue is a composite type: expand to Latitude/Longitude
      if (val.locationValue != null) {
        fields['Latitude']  = val.locationValue.latitude  ?? null;
        fields['Longitude'] = val.locationValue.longitude ?? null;
        // altitude is present in newer fleet telemetry Location proto
        if (val.locationValue.altitude != null) fields['Elevation'] = val.locationValue.altitude;
        else if (val.locationValue.elevation != null) fields['Elevation'] = val.locationValue.elevation;
      } else {
        fields[item.key] =
          val.doubleValue ?? val.floatValue ?? val.intValue ?? val.longValue ?? val.stringValue ?? val.boolValue ?? null;
      }
    }

    const num = (v: any): number | null => (v != null && !isNaN(Number(v)) ? Number(v) : null);
    const str = (v: any): string => (v != null ? String(v) : '');

    // Fleet Telemetry sends VehicleSpeed already in km/h (NOT m/s — the original
    // comment was wrong). Applying × 3.6 caused a 3.6× overestimate (e.g. 56 km/h
    // stored as 203 km/h). Use the value directly.
    const speedKmh = +(num(fields['VehicleSpeed']) ?? num(fields['Speed']) ?? 0);

    // Odometer: Fleet Telemetry sends in miles — convert to km.
    const odometerMi = num(fields['Odometer']);
    const odometerKm = odometerMi != null ? +(odometerMi * 1.60934).toFixed(2) : null;

    // Range: Fleet Telemetry sends in miles — convert to km.
    // Tesla fleet telemetry actual field names (not REST API names):
    //   EstBatteryRange = estimated range (driver-visible, same as est_battery_range in REST)
    //   RatedRange      = ideal/rated range
    //   BatteryRange    = ideal range (older field name)
    // Note: REST API uses 'est_battery_range'/'battery_range'; fleet telemetry uses 'EstBatteryRange'/'BatteryRange'.
    const mi2km = (mi: number | null) => mi != null ? +(mi * 1.60934).toFixed(1) : null;
    const batteryRangeKm =
      mi2km(num(fields['EstBatteryRange'])) ??   // Tesla fleet telemetry actual field name
      mi2km(num(fields['RatedRange'])) ??
      mi2km(num(fields['EstimatedRange'])) ??    // legacy alias kept for compatibility
      mi2km(num(fields['BatteryRange'])) ??
      null;

    // Fleet telemetry sends ChargeState as proto enum name, e.g. "ChargeStateCharging".
    // Normalize to REST API equivalents so charging/trip detectors work uniformly.
    const CHARGE_STATE_MAP: Record<string, string> = {
      ChargeStateCharging:     'Charging',
      ChargeStateComplete:     'Complete',
      ChargeStateDisconnected: 'Disconnected',
      ChargeStateNoPower:      'NoPower',
      ChargeStateStopped:      'Stopped',
      ChargeStateStarting:     'Charging',
      ChargeStateIdle:         'Complete',
    };
    const rawChargeState = str(fields['ChargingState'] ?? fields['ChargeState'] ?? '');
    const charging_state: string = CHARGE_STATE_MAP[rawChargeState] ?? rawChargeState;
    const isCharging = charging_state === 'Charging';
    const current = num(fields['ChargeAmps']) ?? num(fields['ChargerActualCurrent']) ?? num(fields['DCChargingCurrent']) ?? null;
    const chargerVoltage = num(fields['ChargerVoltage']) ?? num(fields['DCChargingVoltage']) ?? null;
    // HV pack voltage — sent every 10s via Fleet Telemetry (PackVoltage field, configured in fleet config).
    // Stored when not charging so battery diagnostics can show pack voltage and compute avg cell voltage.
    // When charging: store charger voltage (AC ~230V or DC ~350-500V) for charging session accuracy.
    const packVoltage = num(fields['PackVoltage']) ?? null;
    const isPlugged = isCharging || (current != null && current > 0);

    const timestampMs = raw.createdAt ? new Date(raw.createdAt).getTime() : Date.now();

    return {
      timestamp: new Date(timestampMs).toISOString(),
      speed: speedKmh,
      // Derive driving power from pack data when explicit Power field is absent.
      // Tesla convention: PackCurrent is negative when discharging (driving).
      power: (() => {
        const explicitPower = num(fields['Power']);
        if (explicitPower != null) return explicitPower;
        // DC/AC charging power fields (configured in fleet telemetry)
        const dcPower = num(fields['DCChargingPower']);
        if (dcPower != null && dcPower > 0) return dcPower;
        const acPower = num(fields['ACChargingPower']);
        if (acPower != null && acPower > 0) return acPower;
        // Fallback: derive from pack voltage × current.
        // Tesla convention: PackCurrent is NEGATIVE when discharging (driving),
        // POSITIVE when charging/regen. Negate the product to get the standard
        // convention (positive = driving/discharging, negative = regen/charging).
        const v = num(fields['PackVoltage']);
        const i = num(fields['PackCurrent']);
        if (v != null && i != null) return Math.round((-v * i) / 100) / 10; // kW, 1 dp, signed
        return 0;
      })(),
      // Prefer UsableBatteryLevel (= what the driver sees in the car/app).
      // BatteryLevel is the gross percentage which includes the non-usable buffer.
      soc: num(fields['UsableBatteryLevel']) ?? num(fields['BatteryLevel']),
      batteryRangeKm,
      latitude: num(fields['Latitude']),
      longitude: num(fields['Longitude']),
      elevationM: num(fields['Elevation']) ?? num(fields['Altitude']) ?? null,
      charging_state,
      current: isPlugged ? current : null,
      voltage: isPlugged && (chargerVoltage ?? 0) >= 10 ? chargerVoltage : packVoltage,
      odometer: odometerKm,
      heading: num(fields['Heading']),
      batteryTemp: num(fields['BatteryTemp']) ?? null,
      outsideTemp: num(fields['OutsideTemp']) ?? null,
      insideTemp: num(fields['InsideTemp']) ?? num(fields['CabinTemp']) ?? null,
      fast_charger_type: fields['FastChargerType'] ? String(fields['FastChargerType']) : null,
      fast_charger_brand: fields['FastChargerBrand'] ? String(fields['FastChargerBrand']) : null,
      charge_energy_added: num(fields['ChargeEnergyAdded']) ?? null,
      // Gear/GearPosition/ShiftState from fleet telemetry → REST API shift_state convention.
      // Fleet telemetry config field is "Gear"; binary publishes as "GearPosition" or "ShiftState".
      // Numeric proto enum: 1=P, 3=R, 4=N, 5=D, 6=SNA. String forms vary by firmware.
      shift_state: (() => {
        const gear = fields['Gear'] ?? fields['GearPosition'] ?? fields['ShiftState'];
        if (gear == null) return null;
        const n = Number(gear);
        if (!isNaN(n) && n > 0) {
          if (n === 5) return 'D';
          if (n === 3) return 'R';
          if (n === 4) return 'N';
          if (n === 1) return 'P';
          return null; // SNA (6) or unknown
        }
        const s = String(gear);
        if (s.includes('Drive') || s === 'D')   return 'D';
        if (s.includes('Reverse') || s === 'R') return 'R';
        if (s.includes('Neutral') || s === 'N') return 'N';
        if (s.includes('Park') || s === 'P')    return 'P';
        return null;
      })(),
      // Self-driving statistics (Tesla fleet telemetry December 2025+).
      // Both fields arrive in miles — convert to km.
      self_driving_km: (() => {
        const mi = num(fields['SelfDrivingMilesSinceReset']);
        return mi != null ? +(mi * 1.60934).toFixed(2) : null;
      })(),
      odometer_km_since_reset: (() => {
        const mi = num(fields['MilesSinceReset']);
        return mi != null ? +(mi * 1.60934).toFixed(2) : null;
      })(),
    };
  }

  // vehicle_data style (polling)
  if (raw && (raw.drive_state || raw.charge_state || raw.vehicle_state)) {
    const driveState   = raw.drive_state   || {};
    const chargeState  = raw.charge_state  || {};
    const climateState = raw.climate_state || {};
    const vehicleState = raw.vehicle_state || {};

    const charging_state: string = chargeState.charging_state ?? '';
    const isCharging = charging_state === 'Charging';
    // Tesla considers charger connected when current > 0 (handles 'Charging'/'Complete' states)
    const isPlugged = isCharging || (chargeState.charger_actual_current ?? 0) > 0;

    // Tesla drive_state.power уже в kW (отрицательная при рекуперации).
    // При зарядке используем charger_power (положительная, в kW).
    const power: number = isCharging
      ? (chargeState.charger_power ?? 0)
      : (driveState.power ?? 0);

    // Tesla speed в mph → конвертируем в km/h.
    // Tesla returns null for speed when parked (not 0).
    const speedMph = driveState.speed ?? 0;
    const speedKmh = +(speedMph * 1.60934).toFixed(1);

    // Оценка остаточного пробега: мили → км.
    const batteryRangeKm = (() => {
      const miles =
        chargeState.battery_range ??
        chargeState.est_battery_range ??
        null;

      return miles != null ? +(miles * 1.60934).toFixed(1) : null;
    })();

    // Одометр у Tesla в милях.
    const odometerRaw = vehicleState.odometer ?? null;
    const odometerKm =
      odometerRaw != null ? +(odometerRaw * 1.60934).toFixed(2) : null;

    // GPS: Fleet API can return coords in drive_state or dedicated location_data endpoint.
    // location_data is more reliable when car is parked (drive_state may omit GPS at rest).
    const locationData = raw.location_data ?? {};
    const latitude =
      locationData.latitude ??
      driveState.latitude ??
      driveState.native_latitude ??
      null;

    const longitude =
      locationData.longitude ??
      driveState.longitude ??
      driveState.native_longitude ??
      null;

    const elevationM =
      locationData.elevation_m ??
      driveState.elevation ??
      driveState.elevation_m ??
      null;

    const nowMs = Date.now();
    const gpsTsMs = driveState.gps_as_of
      ? Number(driveState.gps_as_of) * 1000
      : NaN;
    // Tesla sometimes returns stale gps_as_of while charge_state is fresh.
    // If GPS timestamp is too old, use "now" so status freshness reflects
    // actual poll time and UI doesn't stick in offline.
    const timestampMs =
      Number.isFinite(gpsTsMs) && nowMs - gpsTsMs <= 10 * 60_000
        ? gpsTsMs
        : nowMs;

    return {
      timestamp: new Date(timestampMs).toISOString(),
      speed: speedKmh,
      power,
      // usable_battery_level is what Tesla app shows (excludes non-usable buffer).
      // battery_level is the gross percentage — can be ~5–15% higher than usable.
      soc: chargeState.usable_battery_level ?? chargeState.battery_level ?? null,
      batteryRangeKm,
      latitude,
      longitude,
      elevationM,
      charging_state,
      // Tesla returns charger_actual_current=0 and charger_voltage=2 when not plugged in.
      // Filter to null when not charging to avoid storing noise.
      current: isPlugged ? (chargeState.charger_actual_current ?? null) : null,
      voltage: isPlugged && (chargeState.charger_voltage ?? 0) >= 10
        ? chargeState.charger_voltage
        : null,
      odometer: odometerKm,
      heading: driveState.heading ?? null,
      batteryTemp: null,
      outsideTemp: climateState.outside_temp ?? null,
      insideTemp: climateState.inside_temp ?? null,
      // Tesla API: fast_charger_type = "Tesla" for Supercharger, "CCS", "CHAdeMO", "NACS", etc.
      fast_charger_type: chargeState.fast_charger_type ?? null,
      fast_charger_brand: chargeState.fast_charger_brand ?? null,
      // Tesla reports cumulative kWh added from the charger this session (charger-side, ~10% > battery)
      charge_energy_added: chargeState.charge_energy_added ?? null,
      shift_state: driveState.shift_state ?? null,
      // REST API does not expose self-driving counters — null until fleet telemetry populates them
      self_driving_km: null,
      odometer_km_since_reset: null,
    };
  }

  // Flat streaming payload fallback (почти без изменений; при необходимости mph→km/h можно включить ниже).
  const charging_state: string = raw.charging_state ?? '';
  const speedRaw = raw.speed ?? 0;

  const elevationM =
    raw.elevation_m ??
    raw.elevation ??
    null;

  return {
    timestamp: raw.timestamp
      ? new Date(raw.timestamp).toISOString()
      : new Date().toISOString(),
    speed: speedRaw,
    power: raw.power ?? 0,
    soc: raw.usable_battery_level ?? raw.battery_level ?? raw.soc ?? null,
    batteryRangeKm:
      raw.battery_range != null
        ? +(raw.battery_range * 1.60934).toFixed(1)
        : raw.range != null
          ? +raw.range
          : null,
    latitude: raw.latitude ?? raw.lat ?? null,
    longitude: raw.longitude ?? raw.lon ?? null,
    elevationM,
    charging_state,
    current: raw.charger_actual_current ?? raw.current ?? null,
    voltage: raw.charger_voltage ?? raw.voltage ?? null,
    odometer: raw.odometer ?? null,
    heading: raw.heading ?? null,
    batteryTemp: raw.battery_temp ?? null,
    outsideTemp: raw.outside_temp ?? null,
    insideTemp: raw.inside_temp ?? null,
    fast_charger_type: raw.fast_charger_type ?? null,
    fast_charger_brand: raw.fast_charger_brand ?? null,
    charge_energy_added: raw.charge_energy_added ?? null,
    shift_state: raw.shift_state ?? null,
    self_driving_km: null,
    odometer_km_since_reset: null,
  };
}

