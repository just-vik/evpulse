/**
 * SyncController — offline-first delta sync for mobile clients.
 *
 * Single endpoint:  GET /api/v1/sync/delta
 *
 * The mobile app calls this endpoint with a `since` cursor (ISO-8601 or epoch
 * ms) after reconnecting.  The response contains ALL changes that happened
 * after that cursor so the client can merge them into its local SQLite database
 * and update the UI without a full reload.
 *
 * Client usage pattern (offline-first):
 *   1. App wakes up / regains connectivity.
 *   2. Read last cursor from local storage.
 *   3. GET /sync/delta?vehicleId=X&since=<cursor>
 *   4. Upsert returned entities into local DB.
 *   5. Save the new cursor for the next call.
 */

import {
  Controller,
  Get,
  Query,
  Request,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { EventStoreService, EventType } from '../events/event-store.service';

const MAX_ITEMS_PER_ENTITY = 200; // safety cap per entity type

@ApiTags('Sync')
@UseGuards(JwtAuthGuard)
@Controller('sync')
export class SyncController {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly vehicles:  VehiclesService,
    private readonly eventStore: EventStoreService,
  ) {}

  @Get('delta')
  @ApiOperation({
    summary: 'Offline-first delta sync for mobile clients',
    description:
      'Returns all entities modified after `since`. Use the returned `cursor` ' +
      'as the `since` value on the next call to get only new changes.',
  })
  @ApiQuery({ name: 'vehicleId', required: true })
  @ApiQuery({ name: 'since', required: false, description: 'ISO-8601 or epoch ms. Omit for full sync.' })
  async delta(
    @Query('vehicleId') vehicleId: string,
    @Query('since')     sinceRaw:  string | undefined,
    @Request()          req:       any,
  ) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');

    // Ownership check
    await this.vehicles.findOne(vehicleId, req.user.id);

    // Parse since cursor — default to 30 days ago for a full-ish initial sync
    const sinceMs = sinceRaw
      ? (isNaN(Number(sinceRaw)) ? new Date(sinceRaw).getTime() : Number(sinceRaw))
      : Date.now() - 30 * 24 * 3600 * 1000;

    if (isNaN(sinceMs)) throw new BadRequestException('Invalid `since` value');
    const since = new Date(sinceMs);

    // ── Parallel fetch of all changed entities ─────────────────────────────
    const [trips, chargingSessions, vehicle, events] = await Promise.all([
      // Trips created or updated since cursor
      this.prisma.trip.findMany({
        where: {
          vehicleId,
          updatedAt: { gte: since },
        },
        orderBy: { updatedAt: 'asc' },
        take: MAX_ITEMS_PER_ENTITY,
        select: {
          id:             true,
          startTime:      true,
          endTime:        true,
          distanceKm:     true,
          energyUsedKwh:  true,
          efficiencyWhkm: true,
          startSoc:       true,
          endSoc:         true,
          startLocation:  true,
          endLocation:    true,
          qualityScore:   true,
          reliability:    true,
          repairReason:   true,
          drivingScore:   true,
          costTotal:      true,
          polyline:       true,
          updatedAt:      true,
          // repairTags is JSONB — included via raw select if Prisma client is up to date
        } as any,
      }),

      // Charging sessions
      this.prisma.chargingSession.findMany({
        where: {
          vehicleId,
          updatedAt: { gte: since },
        },
        orderBy: { updatedAt: 'asc' },
        take: MAX_ITEMS_PER_ENTITY,
        select: {
          id:             true,
          startTime:      true,
          endTime:        true,
          startSoc:       true,
          endSoc:         true,
          energyAddedKwh: true,
          maxPowerKw:     true,
          chargerType:    true,
          location:       true,
          costTotal:      true,
          currency:       true,
          updatedAt:      true,
        },
      }),

      // Latest vehicle snapshot (always returned so app can update live tile)
      this.prisma.vehicle.findUnique({
        where:  { id: vehicleId },
        select: {
          id:                        true,
          batteryCapacityDetected:   true,
          batteryCapacityUsable:     true,
          vehicleState: {
            select: {
              state:         true,
              chargingState: true,
              odometer:      true,
              lastUpdate:    true,
            },
          },
          // displayName included via any — field exists in DB but type may lag
        } as any,
      }),

      // Billing-ready events since cursor
      this.eventStore.getBillingEventsSince(vehicleId, since),
    ]);

    // New cursor = now (or latest updatedAt across all entities to avoid drift)
    const allUpdatedAts: number[] = [
      ...(trips as any[]).map((t: any) => (t.updatedAt as Date).getTime()),
      ...(chargingSessions as any[]).map((s: any) => (s.updatedAt as Date).getTime()),
    ];
    const latestEntityMs = allUpdatedAts.length ? Math.max(...allUpdatedAts) : Date.now();
    const cursor = new Date(Math.max(latestEntityMs, Date.now())).toISOString();

    return {
      cursor,
      trips,
      chargingSessions,
      vehicle,
      events: events.map(e => ({
        id:        e.id,
        eventType: e.eventType,
        timestamp: e.timestamp,
        payload:   e.payloadJson,
      })),
      meta: {
        tripsCount:            trips.length,
        chargingSessionsCount: chargingSessions.length,
        eventsCount:           events.length,
        since:                 since.toISOString(),
        truncated:             trips.length === MAX_ITEMS_PER_ENTITY ||
                               chargingSessions.length === MAX_ITEMS_PER_ENTITY,
      },
    };
  }
}
