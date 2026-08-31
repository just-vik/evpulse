import { Provider, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

export const REDIS_CLIENT = 'REDIS_CLIENT';

const logger = new Logger('RedisClient');

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (configService: ConfigService) => {
    const redis = new Redis({
      host: configService.get('REDIS_HOST', 'localhost'),
      port: configService.get<number>('REDIS_PORT', 6379),
      password: configService.get('REDIS_PASSWORD'),
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });

    redis.on('error', (err) => logger.error(`Redis connection error: ${err.message}`));

    return redis;
  },
  inject: [ConfigService],
};
