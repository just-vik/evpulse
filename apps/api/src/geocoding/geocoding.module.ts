import { Module } from '@nestjs/common';
import { GeocodingService } from './geocoding.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [GeocodingService],
  exports: [GeocodingService],
})
export class GeocodingModule {}
