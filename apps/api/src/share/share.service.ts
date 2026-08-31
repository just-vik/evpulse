import { Injectable, Inject, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../infra/redis.provider';
import Redis from 'ioredis';
import { randomBytes } from 'crypto';

const TRIP_TTL_SEC   = 7 * 24 * 60 * 60; // 7 days
const KEY_PREFIX_TRIP = 'share:trip:';

export interface ShareTripPayload {
  tripId: string;
  vehicleId: string;
  userId: string;
  createdAt: string;
}

export interface PublicTripData {
  tripId: string;
  startTime: string;
  endTime: string | null;
  startLocation: string | null;
  endLocation: string | null;
  distanceKm: number | null;
  energyUsedKwh: number | null;
  efficiencyWhkm: number | null;
  startSoc: number;
  endSoc: number | null;
  drivingScore: number | null;
  costTotal: number | null;
  vehicleModel: string | null;
  polyline: string | null;
  points: { lat: number; lng: number; spd: number | null; pwr: number | null; soc: number | null }[];
}

@Injectable()
export class ShareService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async createTripShare(tripId: string, userId: string): Promise<{ token: string; expiresAt: string }> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { vehicleId: true },
    });
    if (!trip) throw new NotFoundException('Trip not found');

    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: trip.vehicleId, userId },
      select: { id: true },
    });
    if (!vehicle) throw new ForbiddenException('Not your trip');

    // Check if a share already exists for this trip+user → reuse
    const existing = await this.findExistingToken(tripId, userId);
    if (existing) {
      const ttl = await this.redis.ttl(`${KEY_PREFIX_TRIP}${existing}`);
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      return { token: existing, expiresAt };
    }

    const token = randomBytes(24).toString('base64url');
    const payload: ShareTripPayload = {
      tripId,
      vehicleId: trip.vehicleId,
      userId,
      createdAt: new Date().toISOString(),
    };
    await this.redis.setex(`${KEY_PREFIX_TRIP}${token}`, TRIP_TTL_SEC, JSON.stringify(payload));

    // Index: userId → [tokens] so we can list/revoke per user
    await this.redis.sadd(`share:user:${userId}:trips`, token);

    const expiresAt = new Date(Date.now() + TRIP_TTL_SEC * 1000).toISOString();
    return { token, expiresAt };
  }

  async revokeTripShare(tripId: string, userId: string): Promise<void> {
    const token = await this.findExistingToken(tripId, userId);
    if (!token) return;
    await this.redis.del(`${KEY_PREFIX_TRIP}${token}`);
    await this.redis.srem(`share:user:${userId}:trips`, token);
  }

  async getPublicTrip(token: string): Promise<PublicTripData> {
    const raw = await this.redis.get(`${KEY_PREFIX_TRIP}${token}`);
    if (!raw) throw new NotFoundException('Share link not found or expired');

    const payload: ShareTripPayload = JSON.parse(raw);

    const [trip, vehicle] = await Promise.all([
      this.prisma.trip.findUnique({
        where: { id: payload.tripId },
        select: {
          id: true, startTime: true, endTime: true,
          startLocation: true, endLocation: true,
          distanceKm: true, energyUsedKwh: true, efficiencyWhkm: true,
          startSoc: true, endSoc: true, drivingScore: true,
          costTotal: true, polyline: true,
        },
      }),
      this.prisma.vehicle.findUnique({
        where: { id: payload.vehicleId },
        select: { model: true, trim: true },
      }),
    ]);

    if (!trip) throw new NotFoundException('Trip no longer exists');

    const rawPoints = await this.prisma.tripPoint.findMany({
      where: { tripId: payload.tripId, latitude: { not: null }, longitude: { not: null } },
      orderBy: { timestamp: 'asc' },
      take: 500,
      select: { latitude: true, longitude: true, speed: true, power: true, soc: true },
    });

    return {
      tripId: trip.id,
      startTime: trip.startTime.toISOString(),
      endTime: trip.endTime?.toISOString() ?? null,
      startLocation: trip.startLocation,
      endLocation: trip.endLocation,
      distanceKm: trip.distanceKm,
      energyUsedKwh: trip.energyUsedKwh,
      efficiencyWhkm: trip.efficiencyWhkm,
      startSoc: trip.startSoc,
      endSoc: trip.endSoc ?? null,
      drivingScore: trip.drivingScore ?? null,
      costTotal: trip.costTotal ?? null,
      vehicleModel: vehicle ? `${vehicle.model} ${vehicle.trim ?? ''}`.trim() : null,
      polyline: trip.polyline,
      points: rawPoints.map(p => ({
        lat: p.latitude!,
        lng: p.longitude!,
        spd: p.speed ?? null,
        pwr: p.power ?? null,
        soc: p.soc ?? null,
      })),
    };
  }

  private async findExistingToken(tripId: string, userId: string): Promise<string | null> {
    const tokens = await this.redis.smembers(`share:user:${userId}:trips`);
    for (const t of tokens) {
      const raw = await this.redis.get(`${KEY_PREFIX_TRIP}${t}`);
      if (!raw) {
        await this.redis.srem(`share:user:${userId}:trips`, t);
        continue;
      }
      const p: ShareTripPayload = JSON.parse(raw);
      if (p.tripId === tripId && p.userId === userId) return t;
    }
    return null;
  }
}
