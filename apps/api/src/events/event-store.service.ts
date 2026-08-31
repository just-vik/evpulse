/**
 * EventStoreService — immutable append-only event log built on top of the
 * existing `telemetry_events` table.
 *
 * Design goals:
 *  1. Replay-safe: every event is idempotent (same externalId → upsert, not
 *     duplicate insert).
 *  2. Billing-ready: TRIP_ENDED / CHARGING_ENDED payloads include all fields
 *     needed to generate an invoice line item without an extra DB round-trip.
 *  3. Non-blocking: emit() is fire-and-forget — never throws on the hot path.
 *  4. Observable: event_type and vehicleId are indexed for fast fan-out queries.
 *
 * Scale note — partitioning:
 *  At < 10 M rows the composite index (vehicleId, timestamp) is sufficient.
 *  When the table grows beyond ~50 M rows consider:
 *    a) TimescaleDB hypertable on `timestamp` (consistent with telemetry_points),
 *       which auto-partitions by time and supports efficient range scans.
 *    b) PostgreSQL declarative partitioning PARTITION BY HASH(vehicleId)
 *       if per-vehicle isolation matters more than time-range queries.
 *  Both require recreating the table; migrate with pg_partman or a blue-green swap.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

// ---------------------------------------------------------------------------
// Event type catalogue
// ---------------------------------------------------------------------------
export const EventType = {
  // Trip lifecycle
  TRIP_STARTED:              'TRIP_STARTED',
  TRIP_ENDED:                'TRIP_ENDED',
  TRIP_FORCE_CLOSED:         'TRIP_FORCE_CLOSED',

  // Charging lifecycle
  CHARGING_STARTED:          'CHARGING_STARTED',
  CHARGING_ENDED:            'CHARGING_ENDED',
  CHARGING_PAUSED:           'CHARGING_PAUSED',
  CHARGING_RESUMED:          'CHARGING_RESUMED',

  // Vehicle lifecycle
  VEHICLE_WOKE:              'VEHICLE_WOKE',
  VEHICLE_SLEPT:             'VEHICLE_SLEPT',
  VEHICLE_ONLINE:            'VEHICLE_ONLINE',
  VEHICLE_OFFLINE:           'VEHICLE_OFFLINE',

  // Data quality
  TRIP_REPAIRED:             'TRIP_REPAIRED',
  GAP_DETECTED:              'GAP_DETECTED',
} as const;

export type EventType = typeof EventType[keyof typeof EventType];

// ---------------------------------------------------------------------------
// Typed payloads for billing-critical events
// ---------------------------------------------------------------------------
export interface TripStartedPayload {
  tripId:    string;
  startTime: string;
  startSoc:  number;
  startLat?: number | null;
  startLon?: number | null;
}

export interface TripEndedPayload {
  tripId:        string;
  startTime:     string;
  endTime:       string;
  distanceKm?:   number | null;
  energyUsedKwh?: number | null;
  efficiencyWhkm?: number | null;
  startSoc:      number;
  endSoc?:       number | null;
  durationMin?:  number;
  repairReason?: string | null;
  qualityScore?: number | null;
}

export interface ChargingStartedPayload {
  sessionId:   string;
  startTime:   string;
  startSoc:    number;
  chargerType?: string | null;
  startLat?:   number | null;
  startLng?:   number | null;
}

export interface ChargingEndedPayload {
  sessionId:      string;
  startTime:      string;
  endTime:        string;
  energyAddedKwh?: number | null;
  maxPowerKw?:    number | null;
  startSoc:       number;
  endSoc?:        number | null;
  chargerType?:   string | null;
  costTotal?:     number | null;
  currency?:      string | null;
  durationMin?:   number;
}

export interface EventEmitOptions {
  /**
   * Stable dedup key — same externalId → upsert, not duplicate insert.
   * Convention: `${eventType}:${entityId}` (e.g. "TRIP_ENDED:abc123")
   */
  externalId?: string;
}

@Injectable()
export class EventStoreService {
  private readonly logger = new Logger(EventStoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fire-and-forget event emit.
   * Never throws — failures are logged but do not propagate to callers.
   */
  emit(
    vehicleId:  string,
    eventType:  EventType,
    payload:    Record<string, unknown>,
    opts:       EventEmitOptions = {},
  ): void {
    this._persist(vehicleId, eventType, payload, opts).catch((err) =>
      this.logger.warn(`EventStore emit failed [${eventType}] for ${vehicleId}: ${err?.message}`),
    );
  }

  /**
   * Awaitable version — use when you need to guarantee the event is persisted
   * before proceeding (e.g. billing critical path).
   */
  async emitAsync(
    vehicleId:  string,
    eventType:  EventType,
    payload:    Record<string, unknown>,
    opts:       EventEmitOptions = {},
  ): Promise<void> {
    await this._persist(vehicleId, eventType, payload, opts);
  }

  // -------------------------------------------------------------------------
  // Typed convenience helpers (billing-ready)
  // -------------------------------------------------------------------------

  emitTripStarted(vehicleId: string, p: TripStartedPayload): void {
    this.emit(vehicleId, EventType.TRIP_STARTED, p as any, {
      externalId: `TRIP_STARTED:${p.tripId}`,
    });
  }

  emitTripEnded(vehicleId: string, p: TripEndedPayload): void {
    this.emit(vehicleId, EventType.TRIP_ENDED, p as any, {
      externalId: `TRIP_ENDED:${p.tripId}`,
    });
  }

  emitChargingStarted(vehicleId: string, p: ChargingStartedPayload): void {
    this.emit(vehicleId, EventType.CHARGING_STARTED, p as any, {
      externalId: `CHARGING_STARTED:${p.sessionId}`,
    });
  }

  emitChargingEnded(vehicleId: string, p: ChargingEndedPayload): void {
    this.emit(vehicleId, EventType.CHARGING_ENDED, p as any, {
      externalId: `CHARGING_ENDED:${p.sessionId}`,
    });
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  /**
   * Cursor-based pagination for events — safe to use with millions of rows.
   *
   * `cursor` is an opaque Base64 string encoding `{ id, timestamp }` of the
   * last item returned by the previous page.  Pass it as `?cursor=` on the
   * next request to get the following page.  Omit to start from the newest.
   *
   * Response shape:
   *   { items: TelemetryEvent[], nextCursor: string | null }
   *
   * nextCursor is null when the caller has reached the end of the stream.
   */
  async getForVehicle(
    vehicleId: string,
    limit     = 50,
    eventType?: EventType,
    cursor?:    string,
  ) {
    const pageSize = Math.min(limit, 200); // hard cap per page

    // Decode cursor
    let cursorWhere: Record<string, unknown> | undefined;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
          id:        string;
          timestamp: string;
        };
        // Keyset pagination: (timestamp < cursorTs) OR (timestamp = cursorTs AND id < cursorId)
        cursorWhere = {
          OR: [
            { timestamp: { lt: new Date(decoded.timestamp) } },
            { timestamp: { equals: new Date(decoded.timestamp) }, id: { lt: decoded.id } },
          ],
        };
      } catch {
        // Malformed cursor — ignore and start from the beginning
      }
    }

    const items = await this.prisma.telemetryEvent.findMany({
      where: {
        vehicleId,
        ...(eventType ? { eventType } : {}),
        ...(cursorWhere ?? {}),
      },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take:    pageSize + 1, // fetch one extra to detect "has next page"
    });

    const hasNext  = items.length > pageSize;
    const page     = hasNext ? items.slice(0, pageSize) : items;
    const last     = page[page.length - 1];
    const nextCursor = (hasNext && last)
      ? Buffer.from(JSON.stringify({ id: last.id, timestamp: last.timestamp.toISOString() })).toString('base64url')
      : null;

    return { items: page, nextCursor };
  }

  /** Returns all billing events since a given timestamp */
  async getBillingEventsSince(vehicleId: string, since: Date) {
    return this.prisma.telemetryEvent.findMany({
      where: {
        vehicleId,
        eventType: { in: [EventType.TRIP_ENDED, EventType.CHARGING_ENDED] },
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'asc' },
    });
  }

  // -------------------------------------------------------------------------
  // Retention — nightly cleanup keeps the table from growing unbounded.
  //
  // Default: 90 days.  Override via env TELEMETRY_EVENT_RETENTION_DAYS.
  // Billing-critical events (TRIP_ENDED, CHARGING_ENDED) are exempt from
  // purge — they're retained indefinitely for audit / invoice replay.
  //
  // Uses batched deletes (same pattern as SnapshotService.purgeOld) to avoid
  // long-running transactions.
  // -------------------------------------------------------------------------

  private static readonly RETENTION_DAYS =
    Number(process.env.TELEMETRY_EVENT_RETENTION_DAYS ?? '90') || 90;
  private static readonly BILLING_EVENTS = new Set([
    'TRIP_ENDED',
    'CHARGING_ENDED',
  ]);
  private static readonly PURGE_BATCH    = 5_000;
  private static readonly PURGE_MAX_ITER = 500;

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeOldEvents(): Promise<void> {
    const cutoff = new Date(
      Date.now() - EventStoreService.RETENTION_DAYS * 24 * 3600 * 1000,
    );
    let total = 0;
    let iter  = 0;

    while (iter++ < EventStoreService.PURGE_MAX_ITER) {
      const rows = await this.prisma.telemetryEvent.findMany({
        where: {
          timestamp: { lt: cutoff },
          eventType: { notIn: [...EventStoreService.BILLING_EVENTS] },
        },
        select: { id: true },
        take:   EventStoreService.PURGE_BATCH,
      });

      if (!rows.length) break;

      const { count } = await this.prisma.telemetryEvent.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      total += count;

      if (rows.length < EventStoreService.PURGE_BATCH) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    if (iter >= EventStoreService.PURGE_MAX_ITER) {
      this.logger.warn(`Event purge hit MAX_ITER=${EventStoreService.PURGE_MAX_ITER}; total deleted: ${total}`);
    } else if (total > 0) {
      this.logger.log(`Purged ${total} telemetry events older than ${EventStoreService.RETENTION_DAYS} days`);
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async _persist(
    vehicleId:  string,
    eventType:  EventType,
    payload:    Record<string, unknown>,
    opts:       EventEmitOptions,
  ): Promise<void> {
    if (opts.externalId) {
      // Upsert by externalId stored in payloadJson — prevents duplicate billing
      // events if e.g. the trip finalizer is called twice (DLQ replay + live).
      const existing = await this.prisma.telemetryEvent.findFirst({
        where: {
          vehicleId,
          eventType,
          payloadJson: { path: ['externalId'], equals: opts.externalId },
        },
        select: { id: true },
      });
      if (existing) return; // idempotent — already recorded
    }

    await this.prisma.telemetryEvent.create({
      data: {
        vehicleId,
        eventType,
        payloadJson: {
          ...payload,
          ...(opts.externalId ? { externalId: opts.externalId } : {}),
        },
        timestamp: new Date(),
      },
    });
  }
}
