import { IsNumber, IsOptional, IsString, IsDate, IsJSON } from 'class-validator';

export class CreateTelemetryPointDto {
  @IsNumber()
  @IsOptional()
  soc?: number; // State of Charge (%)

  @IsNumber()
  @IsOptional()
  batteryRangeKm?: number; // Estimated remaining range (km)

  @IsNumber()
  @IsOptional()
  speed?: number; // km/h

  @IsNumber()
  @IsOptional()
  power?: number; // kW

  @IsNumber()
  @IsOptional()
  current?: number; // A

  @IsNumber()
  @IsOptional()
  voltage?: number; // V

  @IsNumber()
  @IsOptional()
  latitude?: number;

  @IsNumber()
  @IsOptional()
  longitude?: number;

  @IsNumber()
  @IsOptional()
  elevationM?: number;

  @IsNumber()
  @IsOptional()
  batteryTemp?: number; // °C

  @IsNumber()
  @IsOptional()
  outsideTemp?: number; // °C

  @IsNumber()
  @IsOptional()
  insideTemp?: number; // °C

  @IsNumber()
  @IsOptional()
  odometer?: number; // km

  @IsNumber()
  @IsOptional()
  heading?: number; // °

  @IsString()
  @IsOptional()
  shift_state?: string; // 'P' | 'D' | 'R' | 'N'

  @IsString()
  @IsOptional()
  charging_state?: string; // 'Charging' | 'Complete' | 'Disconnected' | etc.

  @IsDate()
  @IsOptional()
  timestamp?: Date;
}

export class CreateTelemetryEventDto {
  @IsString()
  eventType: string;

  @IsJSON()
  @IsOptional()
  payloadJson?: any;

  @IsDate()
  @IsOptional()
  timestamp?: Date;
}

export class TelemetryDto {
  id: string;
  vehicleId: string;
  timestamp: Date;
  soc?: number;
  speed?: number;
  power?: number;
  latitude?: number;
  longitude?: number;
  elevationM?: number;
  batteryTemp?: number;
  outsideTemp?: number;
  odometer?: number;
}
