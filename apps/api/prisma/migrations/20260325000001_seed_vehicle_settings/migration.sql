-- Seed VehicleSettings for all vehicles that don't have a settings record yet.
-- Without this record: home location detection fails, cost calculation falls back to
-- hardcoded defaults, and charging type can't distinguish home_wall vs public AC.
--
-- Users must manually set homeLatitude/homeLongitude via the settings UI.
-- Tariff defaults: DE residential ~0.35 €/kWh, Supercharger ~0.49, 3rd-party ~0.55.

INSERT INTO vehicle_settings (
  id,
  "vehicleId",
  "homeChargingRate",
  "superchargerRate",
  "thirdPartyRate",
  "defaultChargeLimit",
  "lowBatteryThreshold",
  timezone,
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  v.id,
  0.35,   -- homeChargingRate €/kWh
  0.49,   -- superchargerRate €/kWh
  0.55,   -- thirdPartyRate €/kWh
  80,     -- defaultChargeLimit %
  20,     -- lowBatteryThreshold %
  'Europe/Berlin',
  NOW(),
  NOW()
FROM vehicles v
LEFT JOIN vehicle_settings vs ON vs."vehicleId" = v.id
WHERE vs.id IS NULL;
