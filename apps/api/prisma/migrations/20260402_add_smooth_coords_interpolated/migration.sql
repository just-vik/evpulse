-- AlterTable: add Kalman-smoothed GPS and interpolated flag to trip_points
ALTER TABLE "trip_points" ADD COLUMN IF NOT EXISTS "smooth_lat" DOUBLE PRECISION;
ALTER TABLE "trip_points" ADD COLUMN IF NOT EXISTS "smooth_lng" DOUBLE PRECISION;
ALTER TABLE "trip_points" ADD COLUMN IF NOT EXISTS "interpolated" BOOLEAN NOT NULL DEFAULT false;
