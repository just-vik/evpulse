import { Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * RedisModule — re-exports RedisService backed by the global REDIS_CLIENT.
 * InfraModule (@Global) provides REDIS_CLIENT everywhere, so no additional
 * imports are needed here. RedisService no longer opens a second connection.
 */
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
