import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { MqttService } from '../mqtt/mqtt.service';
import { FleetTelemetryService } from './fleet-telemetry.service';
import { isWorkerRole } from '../runtime/runtime-role';

/**
 * Subscribes to MQTT topics published by the tesla-fleet-telemetry sidecar container.
 *
 * New format (fleet-telemetry ≥ 2024): individual field topics
 *   tesla/fleet/{vin}/v/{FieldName}  → plain numeric/string payload
 *
 * Legacy format: batch JSON on a single topic
 *   tesla/fleet/{vin}/V  → {"vin":"...","createdAt":"...","data":[{"key":"Speed","value":{"doubleValue":25.5}},...]}
 *
 * Both formats are supported. New-format messages are buffered per VIN
 * and flushed into a batch payload matching the legacy JSON structure.
 *
 * Last-known-value carry-forward:
 *   Each field's last-known value (with timestamp) is cached per VIN.
 *   When a batch is flushed, stale-but-recent values are merged in for
 *   fields that are critical to detectors (speed, location, charging_state, etc.)
 *   but not present in the current 800ms window. This prevents false speed=0
 *   readings from batches that arrive between VehicleSpeed updates.
 */
@Injectable()
export class FleetTelemetryMqttSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetTelemetryMqttSubscriber.name);
  private readonly TOPIC_PREFIX = 'tesla/fleet';

  // Per-VIN accumulator for new-format individual field messages
  private readonly buffers = new Map<string, {
    fields: Map<string, any>;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // Per-VIN last-known values with timestamps — used to fill gaps in sparse batches
  private readonly lastKnown = new Map<string, Map<string, { value: any; ts: number }>>();

  // Fields carried forward when missing from current batch (max age = 2 full update intervals)
  private readonly CARRY_FORWARD_FIELDS = new Set([
    'VehicleSpeed', 'Speed',
    'Location',
    'ChargingState', 'ChargeState',
    'Gear', 'GearPosition', 'ShiftState',
    'Odometer',
    'BatteryLevel',
    'UsableBatteryLevel',      // user-visible SOC (excludes non-usable buffer) — prefer over BatteryLevel
    'Power',
    'PackCurrent', 'PackVoltage',
    'ChargeAmps', 'ChargerActualCurrent', 'ChargerVoltage',
    'DCChargingCurrent', 'DCChargingVoltage',
    'DCChargingPower', 'ACChargingPower',
    'ChargeEnergyAdded', 'DCChargingEnergyIn', 'ACChargingEnergyIn',
    'FastChargerType', 'FastChargerBrand',
    'Heading',
    'EstBatteryRange',         // Tesla fleet telemetry actual field name for estimated range
    'RatedRange',              // WLTP rated range (miles)
    'BatteryRange',            // ideal range (miles, older field name)
    'SelfDrivingMilesSinceReset', // cumulative Autopilot/FSD miles (Tesla Dec 2025+)
    'MilesSinceReset',            // total odometer since factory reset
  ]);

  // Maximum age for a carried-forward value.
  // 120s: AC home chargers can take 60-120s from plug-in to first ACChargingPower batch.
  // ChargingState='Charging' arrives first; power arrives later. Both must overlap in the
  // carry-forward window so isActiveState fires with both signals in the same batch.
  private readonly CARRY_MAX_AGE_MS = 120_000;

  // How long to wait after the first field before flushing (ms)
  private readonly FLUSH_DELAY_MS = 800;

  constructor(
    private readonly mqtt: MqttService,
    private readonly fleetTelemetry: FleetTelemetryService,
  ) {}

  async onModuleInit() {
    if (!isWorkerRole()) {
      this.logger.log('Skipping MQTT fleet subscriber init (APP_ROLE=api)');
      return;
    }
    // New format: individual field per topic
    await this.mqtt.subscribe(`${this.TOPIC_PREFIX}/+/v/+`, (topic, msg) =>
      this.handleFieldMessage(topic, msg),
    );

    // Legacy format: batch JSON payload
    await this.mqtt.subscribe(`${this.TOPIC_PREFIX}/+/V`, (topic, msg) =>
      this.handleBatchMessage(topic, msg),
    );
    await this.mqtt.subscribe(`${this.TOPIC_PREFIX}/+/alerts`, (topic, msg) =>
      this.handleBatchMessage(topic, msg),
    );
    await this.mqtt.subscribe(`${this.TOPIC_PREFIX}/+/errors`, (topic, msg) =>
      this.handleBatchMessage(topic, msg),
    );

    this.logger.log(
      `Subscribed to ${this.TOPIC_PREFIX}/+/v/+ (new) and ${this.TOPIC_PREFIX}/+/{V,alerts,errors} (legacy)`,
    );
  }

  onModuleDestroy() {
    for (const { timer } of this.buffers.values()) clearTimeout(timer);
    this.buffers.clear();
  }

  /** New format: tesla/fleet/{vin}/v/{FieldName} → raw scalar value */
  private handleFieldMessage(topic: string, msg: Buffer): void {
    // topic parts: [0]=tesla [1]=fleet [2]=vin [3]=v [4]=FieldName
    const parts = topic.split('/');
    if (parts.length < 5) return;
    const vin = parts[2];
    const fieldName = parts[4];
    const raw = msg.toString().trim();

    let value: any;
    try {
      value = JSON.parse(raw); // handles numbers, booleans, quoted strings
    } catch {
      value = raw; // plain string
    }

    // Update last-known cache
    if (!this.lastKnown.has(vin)) this.lastKnown.set(vin, new Map());
    this.lastKnown.get(vin)!.set(fieldName, { value, ts: Date.now() });

    let buf = this.buffers.get(vin);
    if (!buf) {
      buf = { fields: new Map(), timer: null as any };
      this.buffers.set(vin, buf);
    }

    buf.fields.set(fieldName, value);

    // Leading-edge timer: set once on the first field, don't reset on subsequent fields.
    // This ensures we flush after FLUSH_DELAY_MS regardless of how frequently fields arrive.
    if (!buf.timer) {
      buf.timer = setTimeout(() => this.flush(vin), this.FLUSH_DELAY_MS);
    }
  }

  /** Wrap a parsed field value into the envelope that normalizeTeslaPayload expects */
  private wrapValue(val: any): Record<string, any> {
    if (val == null) return { stringValue: '' };
    if (typeof val === 'number')  return { doubleValue: val };
    if (typeof val === 'boolean') return { boolValue: val };
    // Compound types (e.g. Location = { latitude, longitude, altitude }) arrive as objects.
    // Wrap as locationValue so normalizeTeslaPayload's lat/lon extraction works.
    if (typeof val === 'object' && !Array.isArray(val)) {
      if ('latitude' in val || 'longitude' in val) return { locationValue: val };
      return { stringValue: JSON.stringify(val) };
    }
    return { stringValue: String(val) };
  }

  private async flush(vin: string): Promise<void> {
    const buf = this.buffers.get(vin);
    if (!buf) return;
    // Snapshot and clear — keep the buffer entry so subsequent messages accumulate a new batch
    const fields = new Map(buf.fields);
    buf.fields.clear();
    buf.timer = null as any;

    // Carry forward recent known values for fields missing from this batch
    const known = this.lastKnown.get(vin);
    if (known) {
      const now = Date.now();
      for (const fieldName of this.CARRY_FORWARD_FIELDS) {
        if (!fields.has(fieldName)) {
          const entry = known.get(fieldName);
          if (entry && now - entry.ts <= this.CARRY_MAX_AGE_MS) {
            fields.set(fieldName, entry.value);
          }
        }
      }
    }

    const data = Array.from(fields.entries()).map(([key, val]) => ({
      key,
      value: this.wrapValue(val),
    }));

    const fieldNames = Array.from(fields.keys()).join(', ');
    this.logger.debug(`Flushed ${data.length} fields for VIN ${vin}: [${fieldNames}]`);

    const payload = { vin, createdAt: new Date().toISOString(), data };
    try {
      await this.fleetTelemetry.markVehicleLive(vin);
      await this.fleetTelemetry.handleIncomingPayload(payload);
    } catch (err: any) {
      this.logger.error(`Failed to flush fleet telemetry for ${vin}: ${err.message}`);
    }
  }

  /** Legacy format: single topic with full JSON payload */
  private async handleBatchMessage(topic: string, msg: Buffer): Promise<void> {
    try {
      const payload = JSON.parse(msg.toString());

      if (!payload.vin) {
        const parts = topic.split('/');
        if (parts.length >= 3) payload.vin = parts[2];
      }

      if (!payload.vin) {
        this.logger.warn(`Fleet-telemetry MQTT message without VIN on topic ${topic}`);
        return;
      }

      await this.fleetTelemetry.handleIncomingPayload(payload);
    } catch (err: any) {
      this.logger.error(`Failed to handle MQTT message on ${topic}: ${err.message}`);
    }
  }
}
