-- AlterTable: distinguish raw Tesla Fleet Telemetry events from legacy
-- normalized-DTO rows in telemetry_raw.payload.
--
-- DEFAULT 'normalized_v1' backfills every existing row for free — no data
-- migration needed. Only new Fleet Telemetry rows written after the app
-- deploy that follows this migration will carry 'tesla_fleet_telemetry_v1'.
ALTER TABLE "telemetry_raw" ADD COLUMN "payloadKind" TEXT NOT NULL DEFAULT 'normalized_v1';
