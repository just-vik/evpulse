-- AlterTable: add aiAgent and ragEnabled feature flags to user_entitlements
ALTER TABLE "user_entitlements" ADD COLUMN "aiAgent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_entitlements" ADD COLUMN "ragEnabled" BOOLEAN NOT NULL DEFAULT false;
