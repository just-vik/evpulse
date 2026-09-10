import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  Inject,
} from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../infra/redis.provider';

/**
 * VehicleCommandThrottleGuard - Per-vehicle rate limiting
 *
 * Limits to 10 commands per 60 seconds per vehicle+user combination.
 * Uses the shared injected Redis client (no per-request connections).
 *
 * Rate limit key: `command-rate:${vehicleId}:${userId}:count`
 */
@Injectable()
export class VehicleCommandThrottleGuard implements CanActivate {
  private readonly logger = new Logger(VehicleCommandThrottleGuard.name);

  private readonly COMMAND_LIMIT = 10;
  private readonly WINDOW_SECONDS = 60;
  private readonly KEY_PREFIX = 'command-rate';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const vehicleId = request.params.id;
    const userId = request.user?.id;

    if (!vehicleId || !userId) {
      throw new HttpException(
        'Cannot rate limit: missing vehicle or user ID',
        HttpStatus.BAD_REQUEST,
      );
    }

    const countKey = `${this.KEY_PREFIX}:${vehicleId}:${userId}:count`;

    try {
      const current = await this.redis.get(countKey);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= this.COMMAND_LIMIT) {
        this.logger.debug(
          `Rate limited: vehicle=${vehicleId} user=${userId} count=${count}/${this.COMMAND_LIMIT}`,
        );
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `Rate limit exceeded (${this.COMMAND_LIMIT} commands per ${this.WINDOW_SECONDS}s)`,
            retryAfter: this.WINDOW_SECONDS,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (count === 0) {
        await this.redis.setex(countKey, this.WINDOW_SECONDS, '1');
      } else {
        await this.redis.incr(countKey);
      }

      this.logger.debug(
        `Rate limit: vehicle=${vehicleId} ${count + 1}/${this.COMMAND_LIMIT}`,
      );
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Rate limit check failed for vehicle ${vehicleId}: ${error.message}`);
      // Fail closed: if we can't verify the rate limit, don't let the
      // command through unchecked — an unavailable Redis must not become
      // an unlimited-command bypass (this guard is what stands between a
      // client bug/retry storm and Tesla's pay-per-use command billing).
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Cannot verify command rate limit right now — try again shortly',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
