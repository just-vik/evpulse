import { Global, Module } from '@nestjs/common';
import { TimescaleSetupService } from './timescale/timescale-setup.service';
import { redisProvider } from './redis.provider';

/**
 * @Global() — exports REDIS_CLIENT as a single shared ioredis instance
 * across the entire application.  No other module should declare `redisProvider`
 * in its own `providers` array; inject via @Inject(REDIS_CLIENT) directly.
 */
@Global()
@Module({
  providers: [TimescaleSetupService, redisProvider],
  exports: [redisProvider],
})
export class InfraModule {}
