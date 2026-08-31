import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTelemetryPointDto } from './dto/telemetry.dto';

/**
 * TelemetryService - Production-level telemetry data management
 * 
 * Responsibility: 
 * - Store raw and aggregated telemetry
 * - Query telemetry by time range
 * - Manage telemetry events
 * - Support temporal queries efficiently
 */
@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ============================================================================
  // RAW TELEMETRY POINTS
  // ============================================================================

  /**
   * Create a new telemetry point.
   * Protects against duplicates and out-of-order events.
   */
  async createTelemetryPoint(vehicleId: string, dto: CreateTelemetryPointDto) {
    const timestamp = dto.timestamp || new Date();

    // Guard against out-of-order events (older or equal timestamp than latest)
    const last = await this.getLatestPoint(vehicleId);
    if (last && timestamp <= last.timestamp) {
      return last;
    }

    this.logger.debug(`Upserting telemetry point for vehicle ${vehicleId} @ ${timestamp.toISOString()}`);

    return this.prisma.telemetryPoint.upsert({
      where: {
        vehicleId_timestamp: {
          vehicleId,
          timestamp,
        },
      },
      create: {
        vehicleId,
        timestamp,
        soc: dto.soc,
        batteryRangeKm: dto.batteryRangeKm,
        speed: dto.speed,
        power: dto.power,
        current: dto.current,
        voltage: dto.voltage,
        latitude: dto.latitude,
        longitude: dto.longitude,
        elevationM: dto.elevationM,
        batteryTemp: dto.batteryTemp,
        outsideTemp: dto.outsideTemp,
        insideTemp: dto.insideTemp,
        odometer: dto.odometer,
        heading: dto.heading,
        shiftState: (dto as any).shift_state ?? (dto as any).shiftState ?? null,
      },
      // Duplicate events with same (vehicleId, timestamp) are ignored (no-op update)
      update: {},
    });
  }

  /**
   * Bulk-insert multiple telemetry points for a vehicle.
   * Uses createMany for up to 30× faster bulk imports vs individual inserts.
   *
   * Idempotent w.r.t. (vehicleId, timestamp): table has UNIQUE(vehicleId, timestamp)
   * and Prisma uses skipDuplicates → INSERT … ON CONFLICT DO NOTHING. Pipeline replay
   * and duplicate batches therefore do not create extra rows (unlike N× upsert).
   */
  async createManyTelemetryPoints(vehicleId: string, dtos: CreateTelemetryPointDto[]) {
    if (!dtos.length) return { count: 0 };
    this.logger.debug(`Bulk inserting ${dtos.length} points for vehicle ${vehicleId}`);

    return this.prisma.telemetryPoint.createMany({
      data: dtos.map((dto: any) => ({
        vehicleId,
        timestamp: dto.timestamp || new Date(),
        soc: dto.soc ?? null,
        batteryRangeKm: dto.batteryRangeKm ?? null,
        speed: dto.speed ?? null,
        power: dto.power ?? null,
        current: dto.current ?? null,
        voltage: dto.voltage ?? null,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        elevationM: dto.elevationM ?? null,
        batteryTemp: dto.batteryTemp ?? null,
        outsideTemp: dto.outsideTemp ?? null,
        insideTemp: dto.insideTemp ?? null,
        odometer: dto.odometer ?? null,
        heading: dto.heading ?? null,
        shiftState: (dto as any).shift_state ?? (dto as any).shiftState ?? null,
        // Charging fields — critical for watchdog and detector reconciliation
        chargingState:     dto.charging_state     ?? dto.chargingState     ?? null,
        chargeEnergyAdded: dto.charge_energy_added ?? dto.chargeEnergyAdded ?? null,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * Get latest telemetry point for a vehicle
   */
  async getLatestPoint(vehicleId: string) {
    return this.prisma.telemetryPoint.findFirst({
      where: { vehicleId },
      orderBy: { timestamp: 'desc' },
    });
  }

  /**
   * Get telemetry points within time range
   * Optimized for time-series queries
   */
  async getPointsInRange(
    vehicleId: string,
    startTime: Date,
    endTime: Date,
    limit = 2000,
    skip = 0,
  ) {
    return this.prisma.telemetryPoint.findMany({
      where: {
        vehicleId,
        timestamp: {
          gte: startTime,
          lte: endTime,
        },
      },
      orderBy: { timestamp: 'asc' },
      take: limit,
      skip,
    });
  }

  /**
   * Get downsampled telemetry (every 10 seconds to reduce data)
   * Production optimization for dashboard
   */
  async getDownsampledPoints(
    vehicleId: string,
    startTime: Date,
    endTime: Date,
    intervalSeconds = 10,
  ) {
    const allPoints = await this.getPointsInRange(vehicleId, startTime, endTime);
    
    const downsampled = [];
    let lastTimestamp = 0;

    for (const point of allPoints) {
      const pointTime = point.timestamp.getTime();
      if (pointTime - lastTimestamp >= intervalSeconds * 1000) {
        downsampled.push(point);
        lastTimestamp = pointTime;
      }
    }

    return downsampled;
  }

  // ============================================================================
  // TELEMETRY EVENTS
  // ============================================================================

  /**
   * Create telemetry event (charge_started, vehicle_wake, etc)
   */
  async createEvent(vehicleId: string, eventType: string, payload?: any) {
    this.logger.debug(`Event: ${eventType} for vehicle ${vehicleId}`);

    return this.prisma.telemetryEvent.create({
      data: {
        vehicleId,
        eventType,
        payloadJson: payload || {},
        timestamp: new Date(),
      },
    });
  }

  /**
   * Get events for a specific time period
   */
  async getEvents(vehicleId: string, startTime: Date, endTime: Date) {
    return this.prisma.telemetryEvent.findMany({
      where: {
        vehicleId,
        timestamp: {
          gte: startTime,
          lte: endTime,
        },
      },
      orderBy: { timestamp: 'asc' },
    });
  }

  // ============================================================================
  // STATISTICS & AGGREGATION
  // ============================================================================

  /**
   * Calculate statistics for a time period.
   * Uses DB-level aggregation (no full table scan in JS).
   */
  async getStatistics(vehicleId: string, startTime: Date, endTime: Date) {
    const where = { vehicleId, timestamp: { gte: startTime, lte: endTime } };

    const [count, agg] = await Promise.all([
      this.prisma.telemetryPoint.count({ where }),
      this.prisma.telemetryPoint.aggregate({
        where,
        _avg: { soc: true, speed: true, power: true, batteryTemp: true },
        _min: { soc: true, speed: true, power: true, batteryTemp: true },
        _max: { soc: true, speed: true, power: true, batteryTemp: true },
      }),
    ]);

    if (count === 0) return null;

    return {
      period:     { startTime, endTime },
      pointCount: count,
      battery:    { avg: agg._avg.soc,         min: agg._min.soc,         max: agg._max.soc },
      speed:      { avg: agg._avg.speed,        min: agg._min.speed,       max: agg._max.speed },
      power:      { avg: agg._avg.power,        min: agg._min.power,       max: agg._max.power },
      temp:       { avg: agg._avg.batteryTemp,  min: agg._min.batteryTemp, max: agg._max.batteryTemp },
    };
  }

  // ============================================================================
  // CLEANUP & MAINTENANCE
  // ============================================================================

  /**
   * Prune old telemetry data.
   * Uses TimescaleDB drop_chunks for instant chunk removal (no row-by-row scan).
   * Falls back to Prisma deleteMany if not a hypertable.
   */
  async pruneOldTelemetry(daysToKeep = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    try {
      // TimescaleDB: drop entire compressed chunks — instantaneous vs row scan
      await this.prisma.$executeRawUnsafe(
        `SELECT drop_chunks('telemetry_points', NOW() - INTERVAL '${daysToKeep} days')`,
      );
      this.logger.log(`Pruned telemetry chunks older than ${daysToKeep} days (TimescaleDB drop_chunks)`);
      return { count: -1 }; // exact count not available from drop_chunks
    } catch {
      // Fallback for non-Timescale or if hypertable not set up
      const result = await this.prisma.telemetryPoint.deleteMany({
        where: { timestamp: { lt: cutoffDate } },
      });
      this.logger.log(`Pruned ${result.count} old telemetry points (fallback deleteMany)`);
      return result;
    }
  }
}
