-- Add cellChemistry to vehicle_specs
-- 'NMC': charge to 80-90% daily; 'LFP': 100% daily is fine
ALTER TABLE "vehicle_specs" ADD COLUMN IF NOT EXISTS "cellChemistry" TEXT;
