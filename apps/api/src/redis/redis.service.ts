import { Injectable, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';

/**
 * RedisService — thin typed wrapper around the shared REDIS_CLIENT.
 *
 * Uses the single global ioredis instance from InfraModule instead of
 * creating its own TCP connection. All modules that previously depended
 * on RedisModule continue to work unchanged.
 */
@Injectable()
export class RedisService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
  ) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(
    key: string,
    value: string,
    mode?: 'EX',
    durationSeconds?: number,
  ): Promise<'OK' | null> {
    if (mode === 'EX' && durationSeconds) {
      return this.client.set(key, value, 'EX', durationSeconds);
    }
    return this.client.set(key, value);
  }

  /**
   * SET key 1 EX ttl NX — returns true if key was newly set, false if it already existed.
   * Useful as a distributed lock / rate-limiter token bucket.
   */
  async setIfNotExists(key: string, ttlSeconds: number): Promise<boolean> {
    const res = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async getNumber(key: string): Promise<number | null> {
    const val = await this.get(key);
    if (val == null) return null;
    const num = Number(val);
    return Number.isFinite(num) ? num : null;
  }
}
