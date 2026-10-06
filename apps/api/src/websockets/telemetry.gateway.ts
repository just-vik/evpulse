import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { VehiclesService } from '../vehicles/vehicles.service';
import { getDataQuality, toFreshness, type DataQuality, type Freshness } from '../analytics/vehicle-analytics.service';

/** Envelope of the `telemetry` WS event — `data` carries the raw sensor
 *  fields (unchanged, whatever the caller passed); `lastUpdate`/
 *  `dataQuality`/`dataFreshnessSec` are the freshness signal that used to
 *  exist only in the REST `/vehicles/:id/status` response. */
export interface TelemetryUpdatePayload {
  type: 'telemetry';
  vehicleId: string;
  data: Record<string, unknown>;
  lastUpdate: string | null;
  dataQuality: DataQuality;
  dataFreshnessSec: number | null;
  // VehicleStateContract v1 parity with REST getVehicleStatus(): same freshness
  // value under the public spelling, and lastTelemetryAt = the real telemetry
  // timestamp (same value as lastUpdate here — both come from sourceTimestamp).
  freshness: Freshness;
  lastTelemetryAt: string | null;
  timestamp: string;
}

// ── Rate-limit constants ───────────────────────────────────────────────────
/** Max simultaneous WS connections from a single IP address */
const MAX_CONNECTIONS_PER_IP   = 10;
/** Max simultaneous WS connections for a single authenticated user */
const MAX_CONNECTIONS_PER_USER = 5;
/** Minimum ms between subscribe:vehicle events from the same socket */
const SUBSCRIBE_RATE_LIMIT_MS  = 1_000;

const TELEMETRY_NAMESPACE = '/telemetry';

@WebSocketGateway({
  cors: {
    origin: (process.env.FRONTEND_URL || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim()),
    credentials: true,
  },
  namespace: TELEMETRY_NAMESPACE,
})
export class TelemetryGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TelemetryGateway.name);

  /** IP address → active connection count */
  private readonly connectionsByIp   = new Map<string, number>();
  /** userId → set of active socket IDs */
  private readonly connectionsByUser = new Map<string, Set<string>>();
  /** socketId → timestamp of last subscribe:vehicle event */
  private readonly lastSubscribeAt   = new Map<string, number>();

  // Worker processes have no socket server. They publish through this emitter and
  // the api process's Redis adapter delivers to the browsers in each room.
  private readonly emitter?: Emitter;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly vehiclesService: VehiclesService,
    @Optional() @Inject(REDIS_CLIENT) redis?: Redis,
  ) {
    // Publish failures are logged, not left as unhandled rejections (Node would
    // terminate the worker). A lost event is covered by the REST snapshot refetch.
    const publisher = redis && {
      publish: (channel: string, message: Buffer) =>
        redis.publish(channel, message).catch((err: Error) =>
          this.logger.warn(`Realtime publish failed: ${err.message}`),
        ),
    };
    this.emitter = publisher ? new Emitter(publisher).of(TELEMETRY_NAMESPACE) : undefined;
    if (!redis) {
      this.logger.warn('Redis client not injected — realtime events from this process will not be delivered');
    }
  }

  private deliver(room: string, event: string, payload: object): void {
    if (this.server) {
      this.server.to(room).emit(event, payload);
      return;
    }
    this.emitter?.to(room).emit(event, payload);
  }

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket) {
    const ip = client.handshake.address;

    // ── IP-level connection cap (pre-auth, prevents connection-flood DDoS) ──
    const ipCount = (this.connectionsByIp.get(ip) ?? 0) + 1;
    if (ipCount > MAX_CONNECTIONS_PER_IP) {
      this.logger.warn(`WS: IP ${ip} exceeded ${MAX_CONNECTIONS_PER_IP} concurrent connections — dropping`);
      client.disconnect();
      return;
    }
    this.connectionsByIp.set(ip, ipCount);

    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn(`Client ${client.id} connected without token, disconnecting`);
        client.disconnect();
        return;
      }

      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get<string>('app.jwt.secret'),
      });

      // ── Per-user connection cap (prevents single-token abuse post-auth) ───
      const userId = String(payload.sub);
      const userSockets = this.connectionsByUser.get(userId) ?? new Set<string>();
      if (userSockets.size >= MAX_CONNECTIONS_PER_USER) {
        this.logger.warn(`WS: User ${userId} exceeded ${MAX_CONNECTIONS_PER_USER} concurrent connections — dropping`);
        client.disconnect();
        return;
      }
      userSockets.add(client.id);
      this.connectionsByUser.set(userId, userSockets);

      client.data.userId = payload.sub;
      client.data.email = payload.email;

      this.logger.log(`Client connected: ${client.id} (user: ${payload.email}, ip: ${ip})`);
    } catch (error) {
      this.logger.warn(`Client ${client.id} authentication failed, disconnecting`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // ── Clean up rate-limit counters ─────────────────────────────────────────
    const ip = client.handshake.address;
    const ipCount = this.connectionsByIp.get(ip) ?? 1;
    if (ipCount <= 1) this.connectionsByIp.delete(ip);
    else this.connectionsByIp.set(ip, ipCount - 1);

    const userId = String(client.data.userId ?? '');
    if (userId) {
      const userSockets = this.connectionsByUser.get(userId);
      if (userSockets) {
        userSockets.delete(client.id);
        if (userSockets.size === 0) this.connectionsByUser.delete(userId);
      }
    }

    this.lastSubscribeAt.delete(client.id);
  }

  @SubscribeMessage('subscribe:vehicle')
  async handleSubscribeVehicle(
    @MessageBody() data: { vehicleId: string },
    @ConnectedSocket() client: Socket,
  ) {
    // ── Message-level rate limit: max 1 subscribe per second per socket ──────
    const now = Date.now();
    const lastSub = this.lastSubscribeAt.get(client.id) ?? 0;
    if (now - lastSub < SUBSCRIBE_RATE_LIMIT_MS) {
      client.emit('error', { message: 'Too many requests' });
      return { event: 'error', message: 'Too many requests' };
    }
    this.lastSubscribeAt.set(client.id, now);

    try {
      const userId = String(client.data.userId ?? '');
      if (!data?.vehicleId || !userId) {
        client.emit('error', { message: 'Invalid subscription request' });
        return { event: 'error', message: 'Invalid subscription request' };
      }
      await this.vehiclesService.assertOwnership(data.vehicleId, userId);
    } catch {
      this.logger.warn(`Client ${client.id} denied subscribe to vehicle:${data?.vehicleId}`);
      client.emit('error', { message: 'Access denied' });
      return { event: 'error', message: 'Access denied' };
    }

    const room = `vehicle:${data.vehicleId}`;
    client.join(room);
    this.logger.log(`Client ${client.id} subscribed to ${room}`);
    return { event: 'subscribed', room };
  }

  @SubscribeMessage('unsubscribe:vehicle')
  handleUnsubscribeVehicle(
    @MessageBody() data: { vehicleId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = `vehicle:${data.vehicleId}`;
    client.leave(room);
    this.logger.log(`Client ${client.id} unsubscribed from ${room}`);
    return { event: 'unsubscribed', room };
  }

  /**
   * Emit a telemetry update to all subscribers of a vehicle.
   *
   * `lastUpdate`/`dataQuality`/`dataFreshnessSec` are computed here, from
   * `sourceTimestamp` (defaults to "now"). Every current caller
   * (telemetry-pipeline.service.ts, telemetry.processor.ts — verified, none
   * replay historical data through this method) emits synchronously with
   * newly-received data, so the default is correct as-is. `sourceTimestamp`
   * is accepted explicitly (not just assumed) so this stays correct if that
   * ever changes, and so freshness is unit-testable at every tier without
   * faking the system clock.
   *
   * This closes the gap where mobile's dataQuality badge was readable only
   * from the periodically-stale REST cache, never from the live feed.
   */
  emitTelemetryUpdate(
    vehicleId: string,
    data: Record<string, unknown>,
    sourceTimestamp?: string | Date | null,
  ) {
    // Distinguish "not passed" (undefined → assume now, matches every real
    // caller today) from an explicit `null` ("caller knows there's no valid
    // timestamp" → unknown freshness → OFFLINE, same semantics as
    // getVehicleStatus's own `lastUpdate: string | null`).
    let lastUpdate: string | null;
    let dataFreshnessSec: number | null;
    if (sourceTimestamp === undefined) {
      lastUpdate = new Date().toISOString();
      dataFreshnessSec = 0;
    } else if (sourceTimestamp === null) {
      lastUpdate = null;
      dataFreshnessSec = null;
    } else {
      const dataTs = new Date(sourceTimestamp);
      const isValid = !Number.isNaN(dataTs.getTime());
      lastUpdate = isValid ? dataTs.toISOString() : null;
      dataFreshnessSec = isValid
        ? Math.max(0, Math.floor((Date.now() - dataTs.getTime()) / 1000))
        : null;
    }

    const dataQuality = getDataQuality(dataFreshnessSec);
    const payload: TelemetryUpdatePayload = {
      type: 'telemetry',
      vehicleId,
      data,
      lastUpdate,
      dataQuality,
      dataFreshnessSec,
      freshness: toFreshness(dataQuality),
      lastTelemetryAt: lastUpdate,
      timestamp: new Date().toISOString(),
    };

    // Основное событие, которое слушает фронтенд
    this.deliver(`vehicle:${vehicleId}`, 'telemetry', payload);
  }

  // Emit trip started — frontend shows live "In progress" card immediately
  emitTripStarted(vehicleId: string, trip: any) {
    this.deliver(`vehicle:${vehicleId}`, 'trip:started', { vehicleId, trip });
  }

  // Emit trip ended — frontend finalises the card with real metrics
  emitTripEnded(vehicleId: string, trip: any) {
    this.deliver(`vehicle:${vehicleId}`, 'trip:ended', { vehicleId, trip });
  }

  // Emit live trip stats during an active trip — delivered directly in api, via Redis in worker
  emitLiveTripUpdate(vehicleId: string, payload: {
    tripId:    string;
    tripState: string;
    speed:     number;
    soc:       number | null;
    lat:       number | null;
    lng:       number | null;
    liveStats: {
      distanceKm:     number;
      durationMin:    number;
      energyKwh:      number;
      efficiencyWhkm: number | null;
      avgSpeedKmh:    number | null;
    };
    prediction: {
      estimatedRangeKm: number | null;
      socUsedPct:       number | null;
    };
    quality: {
      score:        number;
      gaps:         number;
      signalLossSec: number;
      interpolated: number;
    };
  }) {
    this.deliver(`vehicle:${vehicleId}`, 'trip:live', { vehicleId, ...payload });
  }

  // Emit a single GPS point during an active trip for real-time polyline building.
  // Lightweight: only lat/lng/speed/ts — no recalculated stats.
  emitTripPoint(vehicleId: string, tripId: string, lat: number, lng: number, speed: number) {
    this.deliver(`vehicle:${vehicleId}`, 'trip:point', {
      vehicleId, tripId, lat, lng, speed, ts: Date.now(),
    });
  }

  // Emit vehicle back-online after OFFLINE period — frontend can show "reconnected" toast
  emitVehicleOnline(vehicleId: string, dataQuality: string) {
    this.deliver(`vehicle:${vehicleId}`, 'vehicle:online', {
      vehicleId,
      dataQuality,
      timestamp: new Date().toISOString(),
    });
  }

  // Emit vehicle state change
  emitVehicleStateChange(vehicleId: string, state: string) {
    const payload = {
      type: 'vehicle-update',
      vehicleId,
      data: { state },
      timestamp: new Date().toISOString(),
    };

    this.deliver(`vehicle:${vehicleId}`, 'vehicle:update', payload);
  }
}
