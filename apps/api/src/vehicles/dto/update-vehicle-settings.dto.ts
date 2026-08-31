import { IsNumber, IsOptional, Min, Max } from 'class-validator';

export class UpdateVehicleSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  homeChargingRate?: number; // €/kWh домашняя зарядка

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  superchargerRate?: number; // €/kWh Supercharger

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  thirdPartyRate?: number; // €/kWh сторонние зарядки

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  defaultChargeLimit?: number; // % — лимит зарядки по умолчанию

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  lowBatteryThreshold?: number; // % — порог уведомления
}

