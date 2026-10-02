import { FleetTelemetryMqttSubscriber } from '../src/tesla-fleet/fleet-telemetry-mqtt.subscriber';

/**
 * Regression tests for the carry-forward timestamp fix (telemetry audit, Oct 2026).
 *
 * Before the fix: Power, PackCurrent, PackVoltage, DCChargingPower and ACChargingPower
 * were in CARRY_FORWARD_FIELDS, so a value seen up to 120s ago could be re-emitted in a
 * *later* 800ms batch stamped with that batch's own `createdAt`. Downstream, that fabricates
 * an energy sample the car never actually reported at that instant — corrupting
 * E = Σ P × Δt. These signals must now be entirely absent from a batch whenever Tesla
 * didn't actually send them in that window, while true state fields (VehicleSpeed,
 * ChargingState, ...) should keep carrying forward exactly as before.
 */
describe('FleetTelemetryMqttSubscriber carry-forward', () => {
  const VIN = '5YJSA1E26HF000000';

  function buildSubscriber() {
    const handleIncomingPayload = jest.fn().mockResolvedValue(undefined);
    const markVehicleLive = jest.fn().mockResolvedValue(undefined);
    const mqtt = { subscribe: jest.fn() };
    const fleetTelemetry = { handleIncomingPayload, markVehicleLive };
    const subscriber = new FleetTelemetryMqttSubscriber(mqtt as any, fleetTelemetry as any);
    return { subscriber, handleIncomingPayload, markVehicleLive };
  }

  /** Simulates an MQTT message on tesla/fleet/{vin}/v/{field}. */
  function sendField(subscriber: FleetTelemetryMqttSubscriber, vin: string, field: string, value: unknown) {
    (subscriber as any).handleFieldMessage(
      `tesla/fleet/${vin}/v/${field}`,
      Buffer.from(JSON.stringify(value)),
    );
  }

  /** Extracts a flat { FieldName: value } map from a handleIncomingPayload call's payload. */
  function fieldsOf(call: any[]): Record<string, unknown> {
    const payload = call[0];
    const out: Record<string, unknown> = {};
    for (const { key, value } of payload.data) {
      out[key] = value.doubleValue ?? value.stringValue ?? value.boolValue ?? value.locationValue;
    }
    return out;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('никогда не переносит Power в последующий batch, даже если значение ещё "свежее" (<120s)', async () => {
    const { subscriber, handleIncomingPayload } = buildSubscriber();

    // Cycle 1: VehicleSpeed + Power both arrive together.
    sendField(subscriber, VIN, 'VehicleSpeed', 50);
    sendField(subscriber, VIN, 'Power', 25);
    await jest.advanceTimersByTimeAsync(800);

    expect(handleIncomingPayload).toHaveBeenCalledTimes(1);
    expect(fieldsOf(handleIncomingPayload.mock.calls[0])).toMatchObject({ VehicleSpeed: 50, Power: 25 });

    // Cycle 2 (well within the 120s carry-forward window): only Odometer arrives,
    // Power is NOT retransmitted by Tesla this time.
    sendField(subscriber, VIN, 'Odometer', 100);
    await jest.advanceTimersByTimeAsync(800);

    expect(handleIncomingPayload).toHaveBeenCalledTimes(2);
    const cycle2 = fieldsOf(handleIncomingPayload.mock.calls[1]);
    // VehicleSpeed is a true state field — it's still correctly carried forward (no regression).
    expect(cycle2).toMatchObject({ Odometer: 100, VehicleSpeed: 50 });
    // Power must be absent, not a stale re-stamped "25".
    expect(cycle2).not.toHaveProperty('Power');
  });

  it('никогда не переносит DCChargingPower/ACChargingPower, но ChargingState переносится как раньше', async () => {
    const { subscriber, handleIncomingPayload } = buildSubscriber();

    sendField(subscriber, VIN, 'ChargingState', 'ChargeStateCharging');
    sendField(subscriber, VIN, 'DCChargingPower', 50);
    sendField(subscriber, VIN, 'ACChargingPower', 7.4);
    await jest.advanceTimersByTimeAsync(800);
    expect(fieldsOf(handleIncomingPayload.mock.calls[0])).toMatchObject({
      ChargingState: 'ChargeStateCharging',
      DCChargingPower: 50,
      ACChargingPower: 7.4,
    });

    // Next window: charger power briefly dips out of the sample (e.g. BMS balancing pause)
    // while the session is still logically "Charging".
    sendField(subscriber, VIN, 'Soc', 61);
    await jest.advanceTimersByTimeAsync(800);

    const cycle2 = fieldsOf(handleIncomingPayload.mock.calls[1]);
    expect(cycle2).toMatchObject({ ChargingState: 'ChargeStateCharging' }); // state carried forward
    expect(cycle2).not.toHaveProperty('DCChargingPower');
    expect(cycle2).not.toHaveProperty('ACChargingPower');
  });

  it('никогда не переносит PackCurrent/PackVoltage', async () => {
    const { subscriber, handleIncomingPayload } = buildSubscriber();

    sendField(subscriber, VIN, 'PackCurrent', -120);
    sendField(subscriber, VIN, 'PackVoltage', 380);
    sendField(subscriber, VIN, 'Gear', 'Drive');
    await jest.advanceTimersByTimeAsync(800);
    expect(fieldsOf(handleIncomingPayload.mock.calls[0])).toMatchObject({
      PackCurrent: -120,
      PackVoltage: 380,
      Gear: 'Drive',
    });

    sendField(subscriber, VIN, 'Heading', 180);
    await jest.advanceTimersByTimeAsync(800);

    const cycle2 = fieldsOf(handleIncomingPayload.mock.calls[1]);
    expect(cycle2).toMatchObject({ Gear: 'Drive', Heading: 180 }); // state carried forward
    expect(cycle2).not.toHaveProperty('PackCurrent');
    expect(cycle2).not.toHaveProperty('PackVoltage');
  });
});
