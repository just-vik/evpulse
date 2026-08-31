import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';

const TTL_SECONDS = 93 * 24 * 3600; // keep 3 months of history

function monthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface VehicleUsage {
  vehicleId: string;
  month: string;
  signals: number;
  wakes: number;
  commands: number;
  /** Rough cost estimate in USD */
  estimatedUsd: number;
}

@Injectable()
export class ApiUsageService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Increment fleet-telemetry signal counter (called per processed batch). */
  async trackSignals(vehicleId: string, count: number = 1): Promise<void> {
    const key = `api:usage:signals:${vehicleId}:${monthKey()}`;
    await this.redis.incrby(key, count);
    await this.redis.expire(key, TTL_SECONDS);
  }

  /** Increment REST wake/vehicle_data counter (called per actual Tesla API call). */
  async trackWake(vehicleId: string): Promise<void> {
    const key = `api:usage:wakes:${vehicleId}:${monthKey()}`;
    await this.redis.incr(key);
    await this.redis.expire(key, TTL_SECONDS);
  }

  /** Increment command counter (called per executed vehicle command). */
  async trackCommand(vehicleId: string): Promise<void> {
    const key = `api:usage:commands:${vehicleId}:${monthKey()}`;
    await this.redis.incr(key);
    await this.redis.expire(key, TTL_SECONDS);
  }

  /** Get current-month usage stats for a single vehicle. */
  async getVehicleUsage(vehicleId: string, month?: string): Promise<VehicleUsage> {
    const m = month ?? monthKey();
    const [signals, wakes, commands] = await Promise.all([
      this.redis.get(`api:usage:signals:${vehicleId}:${m}`),
      this.redis.get(`api:usage:wakes:${vehicleId}:${m}`),
      this.redis.get(`api:usage:commands:${vehicleId}:${m}`),
    ]);
    const s = parseInt(signals ?? '0', 10);
    const w = parseInt(wakes ?? '0', 10);
    const c = parseInt(commands ?? '0', 10);
    // Tesla API pricing: fleet telemetry ~$0.000006/signal, REST calls ~$0.002/call
    const estimatedUsd = s * 0.000006 + w * 0.002 + c * 0.001;
    return { vehicleId, month: m, signals: s, wakes: w, commands: c, estimatedUsd };
  }

  /** Aggregate usage for a list of vehicleIds (user-level summary). */
  async getUserUsage(vehicleIds: string[], month?: string): Promise<{
    month: string;
    vehicles: VehicleUsage[];
    totals: Omit<VehicleUsage, 'vehicleId' | 'month'>;
  }> {
    const m = month ?? monthKey();
    const vehicles = await Promise.all(vehicleIds.map((id) => this.getVehicleUsage(id, m)));
    const totals = vehicles.reduce(
      (acc, v) => ({
        signals: acc.signals + v.signals,
        wakes: acc.wakes + v.wakes,
        commands: acc.commands + v.commands,
        estimatedUsd: acc.estimatedUsd + v.estimatedUsd,
      }),
      { signals: 0, wakes: 0, commands: 0, estimatedUsd: 0 },
    );
    return { month: m, vehicles, totals };
  }
}
