import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../infra/redis.provider';

/**
 * DistributedLockService - Redis-based distributed mutual exclusion locks
 *
 * Use case: Prevent concurrent command execution on individual vehicles
 *
 * Lock pattern (SETNX + TTL):
 * - SETNX key token → set only if not exists, atomically
 * - Assigns unique token to ensure only lock holder can release
 * - TTL prevents deadlocks if process crashes
 *
 * Example: Rate limit lock/unlock on specific vehicle
 * - lock: `command-lock:vehicle:ABC123`
 * - TTL: 30s (ensures command completes within timeout)
 * - Retry: exponential backoff if lock held
 */
@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  constructor(@Inject(REDIS_CLIENT) private redis: Redis) {}

  /**
   * Attempt to acquire a lock.
   * Returns unique token if successful, null if lock is held.
   *
   * @param key - Lock key (e.g., "command-lock:vehicle:ABC123")
   * @param ttlSeconds - Lock expiry time (default 30s)
   * @returns Token if acquired, null if locked
   */
  async tryAcquire(key: string, ttlSeconds = 30): Promise<string | null> {
    const token = this.generateToken();
    const result = await this.redis.set(
      key,
      token,
      'EX',  // Set expiry
      ttlSeconds,
      'NX',  // Only set if not exists
    );
    return result === 'OK' ? token : null;
  }

  /**
   * Acquire lock with automatic retry (exponential backoff).
   * Throws error if lock cannot be acquired within timeout.
   *
   * @param key - Lock key
   * @param options - Max retries, initial delay, max delay
   * @returns Token
   */
  async acquireWithRetry(
    key: string,
    options?: {
      maxRetries?: number;
      initialDelayMs?: number;
      maxDelayMs?: number;
      ttlSeconds?: number;
    },
  ): Promise<string> {
    const {
      maxRetries = 5,
      initialDelayMs = 10,
      maxDelayMs = 500,
      ttlSeconds = 30,
    } = options ?? {};

    let delayMs = initialDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const token = await this.tryAcquire(key, ttlSeconds);
      if (token) {
        if (attempt > 0) {
          this.logger.debug(`Lock acquired on attempt ${attempt + 1}: ${key}`);
        }
        return token;
      }

      if (attempt < maxRetries) {
        await this.sleep(delayMs);
        delayMs = Math.min(delayMs * 2, maxDelayMs);
      }
    }

    throw new Error(
      `Failed to acquire lock after ${maxRetries + 1} attempts: ${key}`,
    );
  }

  /**
   * Release a lock if token matches (prevents accidental release by wrong holder).
   *
   * Uses Lua script for atomicity:
   * ```lua
   * if redis.call('GET', key) == token then
   *   return redis.call('DEL', key)
   * else
   *   return 0
   * end
   * ```
   *
   * @param key - Lock key
   * @param token - Lock token (must match to release)
   * @returns true if released, false if token mismatch
   */
  async release(key: string, token: string): Promise<boolean> {
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.redis.eval(script, 1, key, token);
    return (result as number) === 1;
  }

  /**
   * Automatically release lock with token verification.
   * Useful in try-finally blocks for guaranteed cleanup.
   *
   * @param key - Lock key
   * @param token - Lock token
   */
  async releaseIfHeld(key: string, token: string): Promise<void> {
    try {
      const released = await this.release(key, token);
      if (!released) {
        this.logger.warn(
          `Lock token mismatch on release (possible race condition): ${key}`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to release lock ${key}: ${error.message}`);
    }
  }

  /**
   * Check if lock is currently held (for monitoring/debugging).
   *
   * @param key - Lock key
   * @returns true if locked, false if free
   */
  async isLocked(key: string): Promise<boolean> {
    const value = await this.redis.get(key);
    return value !== null;
  }

  /**
   * Get current lock holder token (for debugging).
   * Returns null if lock is not held.
   *
   * ⚠️ Security note: Token is visible in logs/monitoring.
   *    Only use for debugging, not in production logs.
   *
   * @param key - Lock key
   */
  async getLockHolder(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /**
   * Force release a lock (use with caution).
   * Does NOT verify token - bypasses safety check.
   * Should only be used for admin cleanup or recovery.
   *
   * @param key - Lock key
   * @returns true if lock was deleted, false if didn't exist
   */
  async forceRelease(key: string): Promise<boolean> {
    const result = await this.redis.del(key);
    this.logger.warn(`Force released lock: ${key}`);
    return result === 1;
  }

  /**
   * Extension pattern: Extend lock TTL if still held by token holder.
   * Useful for long-running operations.
   *
   * @param key - Lock key
   * @param token - Lock token
   * @param newTtlSeconds - New expiry time
   * @returns true if extended, false if token mismatch
   */
  async extendIfHeld(
    key: string,
    token: string,
    newTtlSeconds = 30,
  ): Promise<boolean> {
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('EXPIRE', KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await this.redis.eval(script, 1, key, token, newTtlSeconds);
    return (result as number) === 1;
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private generateToken(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
