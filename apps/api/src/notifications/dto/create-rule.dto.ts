import { IsString, IsOptional, IsBoolean, IsNumber, IsArray, IsObject, Min } from 'class-validator';
import { TriggerType } from '../constants/triggers';

export class CreateRuleDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  @IsString()
  triggerType: TriggerType;

  @IsOptional()
  @IsObject()
  triggerValue?: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  @Min(60)
  cooldownSec?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channels?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
