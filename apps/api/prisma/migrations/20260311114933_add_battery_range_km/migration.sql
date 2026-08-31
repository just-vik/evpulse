-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "refreshToken" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'active',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "units" TEXT NOT NULL DEFAULT 'metric',
    "language" TEXT NOT NULL DEFAULT 'en',
    "theme" TEXT NOT NULL DEFAULT 'dark',
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "ip" TEXT,
    "device" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_specs" (
    "id" TEXT NOT NULL,
    "modelCode" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "region" TEXT NOT NULL,
    "batteryNominalKwh" DOUBLE PRECISION NOT NULL,
    "batteryUsableKwh" DOUBLE PRECISION NOT NULL,
    "rangeWltp" DOUBLE PRECISION,
    "rangeEpa" DOUBLE PRECISION,
    "rangeNedcKm" DOUBLE PRECISION,
    "peakChargingKw" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_specs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "teslaId" TEXT,
    "model" TEXT NOT NULL,
    "trim" TEXT,
    "year" INTEGER,
    "vehicleSpecId" TEXT,
    "batteryCapacityNominal" DOUBLE PRECISION NOT NULL DEFAULT 75.0,
    "batteryCapacityUsable" DOUBLE PRECISION NOT NULL DEFAULT 72.0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_settings" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "displayName" TEXT,
    "homeLatitude" DOUBLE PRECISION,
    "homeLongitude" DOUBLE PRECISION,
    "chargingCost" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_states" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'offline',
    "chargingState" TEXT,
    "locked" BOOLEAN NOT NULL DEFAULT true,
    "odometer" DOUBLE PRECISION,
    "lastUpdate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tesla_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tesla_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tesla_vehicle_links" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "teslaAccountId" TEXT NOT NULL,
    "teslaVehicleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tesla_vehicle_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telemetry_points" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "soc" DOUBLE PRECISION,
    "batteryRangeKm" DOUBLE PRECISION,
    "batteryTemp" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "power" DOUBLE PRECISION,
    "current" DOUBLE PRECISION,
    "voltage" DOUBLE PRECISION,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "outsideTemp" DOUBLE PRECISION,
    "insideTemp" DOUBLE PRECISION,
    "odometer" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,

    CONSTRAINT "telemetry_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telemetry_events" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" TEXT NOT NULL,
    "payloadJson" JSONB,

    CONSTRAINT "telemetry_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_locations" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "speed" DOUBLE PRECISION,

    CONSTRAINT "vehicle_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trips" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "startLocation" TEXT,
    "endLocation" TEXT,
    "startSoc" DOUBLE PRECISION NOT NULL,
    "endSoc" DOUBLE PRECISION,
    "distanceKm" DOUBLE PRECISION,
    "energyUsedKwh" DOUBLE PRECISION,
    "efficiencyWhkm" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_points" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "speed" DOUBLE PRECISION,
    "power" DOUBLE PRECISION,
    "soc" DOUBLE PRECISION,

    CONSTRAINT "trip_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_stats" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "avgSpeed" DOUBLE PRECISION,
    "maxSpeed" DOUBLE PRECISION,
    "regenEnergyKwh" DOUBLE PRECISION,
    "elevationGain" DOUBLE PRECISION,
    "drivingStyle" TEXT,

    CONSTRAINT "trip_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charging_sessions" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "startSoc" DOUBLE PRECISION NOT NULL,
    "endSoc" DOUBLE PRECISION,
    "energyAddedKwh" DOUBLE PRECISION,
    "maxPowerKw" DOUBLE PRECISION,
    "chargerType" TEXT,
    "location" TEXT,
    "cost" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charging_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charging_points" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "powerKw" DOUBLE PRECISION NOT NULL,
    "current" DOUBLE PRECISION,
    "voltage" DOUBLE PRECISION,
    "soc" DOUBLE PRECISION,

    CONSTRAINT "charging_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "battery_health" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sohPercent" DOUBLE PRECISION NOT NULL,
    "estimatedCapacityKwh" DOUBLE PRECISION NOT NULL,
    "nominalCapacityKwh" DOUBLE PRECISION NOT NULL DEFAULT 75.0,
    "degradationPercent" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "method" TEXT NOT NULL DEFAULT 'trip',
    "confidenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "sampleCount" INTEGER NOT NULL DEFAULT 1,
    "tripSoh" DOUBLE PRECISION,
    "chargingSoh" DOUBLE PRECISION,
    "ratedRangeSoh" DOUBLE PRECISION,
    "avgBatteryTempC" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "battery_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_cycles" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cycleCount" INTEGER NOT NULL,
    "estimatedCycles" INTEGER,

    CONSTRAINT "charge_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_energy" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "distanceKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "energyUsedKwh" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "energyAddedKwh" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "efficiencyWhkm" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_energy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_energy" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "distanceKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "energyUsedKwh" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "energyAddedKwh" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "efficiencyWhkm" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_energy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_rules" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_email_status_idx" ON "users"("email", "status");

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_userId_key" ON "user_settings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_token_key" ON "user_sessions"("token");

-- CreateIndex
CREATE INDEX "user_sessions_userId_expiresAt_idx" ON "user_sessions"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_specs_modelCode_year_region_key" ON "vehicle_specs"("modelCode", "year", "region");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vin_key" ON "vehicles"("vin");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_teslaId_key" ON "vehicles"("teslaId");

-- CreateIndex
CREATE INDEX "vehicles_userId_status_idx" ON "vehicles"("userId", "status");

-- CreateIndex
CREATE INDEX "vehicles_vin_idx" ON "vehicles"("vin");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_settings_vehicleId_key" ON "vehicle_settings"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_states_vehicleId_key" ON "vehicle_states"("vehicleId");

-- CreateIndex
CREATE INDEX "vehicle_states_vehicleId_idx" ON "vehicle_states"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "tesla_accounts_userId_key" ON "tesla_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tesla_vehicle_links_vehicleId_key" ON "tesla_vehicle_links"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "tesla_vehicle_links_teslaVehicleId_key" ON "tesla_vehicle_links"("teslaVehicleId");

-- CreateIndex
CREATE INDEX "tesla_vehicle_links_teslaAccountId_idx" ON "tesla_vehicle_links"("teslaAccountId");

-- CreateIndex
CREATE INDEX "telemetry_points_vehicleId_timestamp_idx" ON "telemetry_points"("vehicleId", "timestamp");

-- CreateIndex
CREATE INDEX "telemetry_points_timestamp_idx" ON "telemetry_points"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_points_vehicleId_timestamp_key" ON "telemetry_points"("vehicleId", "timestamp");

-- CreateIndex
CREATE INDEX "telemetry_events_vehicleId_timestamp_idx" ON "telemetry_events"("vehicleId", "timestamp");

-- CreateIndex
CREATE INDEX "telemetry_events_eventType_idx" ON "telemetry_events"("eventType");

-- CreateIndex
CREATE INDEX "vehicle_locations_vehicleId_timestamp_idx" ON "vehicle_locations"("vehicleId", "timestamp");

-- CreateIndex
CREATE INDEX "trips_vehicleId_startTime_idx" ON "trips"("vehicleId", "startTime");

-- CreateIndex
CREATE INDEX "trips_startTime_idx" ON "trips"("startTime");

-- CreateIndex
CREATE INDEX "trip_points_tripId_idx" ON "trip_points"("tripId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_stats_tripId_key" ON "trip_stats"("tripId");

-- CreateIndex
CREATE INDEX "charging_sessions_vehicleId_startTime_idx" ON "charging_sessions"("vehicleId", "startTime");

-- CreateIndex
CREATE INDEX "charging_sessions_startTime_idx" ON "charging_sessions"("startTime");

-- CreateIndex
CREATE INDEX "charging_points_sessionId_idx" ON "charging_points"("sessionId");

-- CreateIndex
CREATE INDEX "battery_health_vehicleId_timestamp_idx" ON "battery_health"("vehicleId", "timestamp");

-- CreateIndex
CREATE INDEX "charge_cycles_vehicleId_timestamp_idx" ON "charge_cycles"("vehicleId", "timestamp");

-- CreateIndex
CREATE INDEX "daily_energy_vehicleId_idx" ON "daily_energy"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "daily_energy_vehicleId_date_key" ON "daily_energy"("vehicleId", "date");

-- CreateIndex
CREATE INDEX "monthly_energy_vehicleId_idx" ON "monthly_energy"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_energy_vehicleId_month_key" ON "monthly_energy"("vehicleId", "month");

-- CreateIndex
CREATE INDEX "notifications_userId_read_idx" ON "notifications"("userId", "read");

-- CreateIndex
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- CreateIndex
CREATE INDEX "notification_rules_userId_idx" ON "notification_rules"("userId");

-- CreateIndex
CREATE INDEX "automations_userId_enabled_idx" ON "automations"("userId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_userId_key" ON "subscriptions"("userId");

-- CreateIndex
CREATE INDEX "invoices_userId_date_idx" ON "invoices"("userId", "date");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_vehicleSpecId_fkey" FOREIGN KEY ("vehicleSpecId") REFERENCES "vehicle_specs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_settings" ADD CONSTRAINT "vehicle_settings_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_states" ADD CONSTRAINT "vehicle_states_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tesla_accounts" ADD CONSTRAINT "tesla_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tesla_vehicle_links" ADD CONSTRAINT "tesla_vehicle_links_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tesla_vehicle_links" ADD CONSTRAINT "tesla_vehicle_links_teslaAccountId_fkey" FOREIGN KEY ("teslaAccountId") REFERENCES "tesla_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_points" ADD CONSTRAINT "telemetry_points_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_events" ADD CONSTRAINT "telemetry_events_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_locations" ADD CONSTRAINT "vehicle_locations_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_points" ADD CONSTRAINT "trip_points_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_stats" ADD CONSTRAINT "trip_stats_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charging_points" ADD CONSTRAINT "charging_points_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "charging_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battery_health" ADD CONSTRAINT "battery_health_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_cycles" ADD CONSTRAINT "charge_cycles_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_energy" ADD CONSTRAINT "daily_energy_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_energy" ADD CONSTRAINT "monthly_energy_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
