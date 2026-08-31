import { IsString, IsOptional } from 'class-validator';

export class SubscribePushDto {
  @IsString()
  endpoint: string;

  @IsString()
  p256dh: string;

  @IsString()
  auth: string;

  @IsOptional()
  @IsString()
  userAgent?: string;
}
