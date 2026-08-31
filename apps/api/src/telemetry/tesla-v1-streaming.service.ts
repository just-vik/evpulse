import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryBufferService } from './telemetry-buffer.service';
import { TeslaOAuthService } from '../tesla-fleet/tesla-oauth.service';
import { RedisService } from '../redis/redis.service';
import * as WebSocket from 'ws';

/**
 * TeslaV1StreamingService
 *
 * Connects YOUR server → Tesla Streaming API (wss://streaming.vn.cloud.tesla.com/)
 * Does NOT require a public endpoint — outbound WebSocket only.
 *
 * Data arrives while car is AWAKE (driving/charging/user present).
 * Falls back to adaptive polling (TelemetryFetcherService) when car sleeps.
 *
 * Stream fields: speed, odometer, soc, elevation, est_heading,
 *                est_lat, est_lng, power, shift_state, range, est_range, heading
 *
 * Enabled by: TESLA_V1_STREAMING_ENABLED=true in .env
 */
@Injectable()
export class TeslaV1StreamingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TeslaV1StreamingService.name);

  // Per-vehicle state
  private sessions = new Map<string, {
    ws: WebSocket | null;
    reconnectTimer: NodeJS.Timeout | null;
    reconnectDelay: number;
    vehicleId: string;   // our DB id
    teslaId: string;     // Tesla numeric id
    userId: string;
    pingTimer: NodeJS.Timeout | null;
    stopped: boolean;
  }>();

  private readonly STREAM_HOST  = 'wss://streaming.vn.cloud.tesla.com';
  private readonly STREAM_FIELDS = 'speed,odometer,soc,elevation,est_heading,est_lat,est_lng,power,shift_state,range,est_range,heading';

  constructor(
    private readonly prisma:    PrismaService,
    private readonly buffer:    TelemetryBufferService,
    private readonly oauth:     TeslaOAuthService,
    private readonly redis:     RedisService,
  ) {}

  async onModuleInit() {
    if (process.env.TESLA_V1_STREAMING_ENABLED !== 'true') return;

    // Small delay to let other services initialize
    setTimeout(() => this.startAll(), 5_000);
  }

  onModuleDestroy() {
    for (const [, session] of this.sessions) {
      session.stopped = true;
      session.ws?.terminate();
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      if (session.pingTimer)      clearInterval(session.pingTimer);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  private async startAll() {
    try {
      const accounts = await this.prisma.teslaAccount.findMany({
        include: { vehicleLinks: { include: { vehicle: true } } },
      });

      for (const account of accounts) {
        for (const link of account.vehicleLinks) {
          const { vehicle } = link;
          if (!vehicle.teslaId) continue;

          this.startSession(vehicle.id, vehicle.teslaId.toString(), account.userId);
        }
      }
    } catch (e: any) {
      this.logger.error('startAll failed', e.message);
    }
  }

  startSession(vehicleId: string, teslaId: string, userId: string) {
    if (this.sessions.has(vehicleId)) return;

    const session = {
      ws: null as WebSocket | null,
      reconnectTimer: null as NodeJS.Timeout | null,
      reconnectDelay: 10_000,
      vehicleId,
      teslaId,
      userId,
      pingTimer: null as NodeJS.Timeout | null,
      stopped: false,
    };
    this.sessions.set(vehicleId, session);
    this.connect(session);
    this.logger.log(`V1 Streaming started for vehicle ${vehicleId} (Tesla ID: ${teslaId})`);
  }

  // ─────────────────────────────────────────────────────────────────────────

  private async connect(session: ReturnType<typeof this.sessions.get> & {}) {
    if (session.stopped) return;

    let token: string;
    try {
      token = await this.oauth.getValidAccessToken(session.userId);
    } catch (e: any) {
      this.logger.warn(`Cannot get token for ${session.vehicleId}: ${e.message} — retry in 60s`);
      session.reconnectTimer = setTimeout(() => this.connect(session), 60_000);
      return;
    }

    const url = `${this.STREAM_HOST}/connect/${session.teslaId}`;

    try {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: 15_000,
      });
      session.ws = ws;

      ws.on('open', () => {
        this.logger.log(`[${session.vehicleId}] WebSocket open`);
        session.reconnectDelay = 10_000;

        // Subscribe to telemetry fields
        ws.send(JSON.stringify({
          msg_type: 'data:subscribe_oauth',
          token,
          value:    this.STREAM_FIELDS,
          tag:      session.teslaId,
        }));

        // Keepalive
        session.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ msg_type: 'data:heartbeat', tag: session.teslaId }));
          }
        }, 30_000);
      });

      ws.on('message', (raw) => this.handleMessage(session, raw.toString()));

      ws.on('close', (code, reason) => {
        this.logger.debug(`[${session.vehicleId}] Closed [${code}]: ${reason}`);
        this.clearSessionTimers(session);
        if (!session.stopped) {
          const delay = this.reconnectDelay(code, session);
          session.reconnectTimer = setTimeout(() => this.connect(session), delay);
        }
      });

      ws.on('error', (err) => {
        this.logger.warn(`[${session.vehicleId}] WS error: ${err.message}`);
        ws.terminate();
      });
    } catch (e: any) {
      this.logger.error(`[${session.vehicleId}] connect() failed: ${e.message}`);
      this.scheduleReconnect(session);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  private async handleMessage(session: any, raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.msg_type) {
      case 'control:hello':
        this.logger.log(`[${session.vehicleId}] Stream registered ✅`);
        // Mark in Redis so watchdog knows streaming is active
        await this.redis.set(`stream:last:${session.vehicleId}`, Date.now().toString(), 'EX', 600);
        break;

      case 'data:update':
        await this.processPoint(session, msg);
        break;

      case 'data:error':
        this.logger.debug(`[${session.vehicleId}] Stream error: ${msg.value} (${msg.error_type})`);
        if (msg.error_type === 'vehicle_disconnected' || msg.error_type === 'client_error') {
          // Car went to sleep — close and reconnect in 5 min
          session.reconnectDelay = 300_000;
          session.ws?.close();
        }
        break;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  private async processPoint(session: any, msg: any) {
    // Format: "timestamp,speed,odometer,soc,elevation,est_heading,est_lat,est_lng,power,shift_state,range,est_range,heading"
    const csv: string = msg.value ?? '';
    const parts = csv.split(',');
    if (parts.length < 8) return;

    const [ts, speed, odometer, soc, , , lat, lng, power, shiftState, range, , heading] = parts;

    const num = (v: string) => { const n = parseFloat(v); return isNaN(n) ? null : n; };

    const point = {
      timestamp:      new Date(Number(ts)),
      speed:          num(speed),
      odometer:       num(odometer),
      soc:            num(soc),
      power:          num(power),
      batteryRangeKm: num(range),
      latitude:       num(lat),
      longitude:      num(lng),
      heading:        num(heading),
      chargingState:  (num(power) ?? 0) > 1 ? 'Charging' : null,
      shiftState:     shiftState || null,
    };

    // Mark streaming as active (suppresses watchdog polling fallback)
    await this.redis.set(`stream:last:${session.vehicleId}`, Date.now().toString(), 'EX', 600);

    // Feed into the same buffer → pipeline → trip/charging detectors
    await this.buffer.addPoint(session.vehicleId, {
      ...point,
      timestamp: point.timestamp,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────

  private reconnectDelay(closeCode: number, session: any): number {
    // Token expired → reconnect immediately (will refresh token)
    if (closeCode === 4001) return 1_000;
    // Normal close or vehicle disconnected — use backoff
    const delay = session.reconnectDelay;
    session.reconnectDelay = Math.min(delay * 2, 300_000); // max 5 min
    return delay;
  }

  private scheduleReconnect(session: any) {
    const delay = session.reconnectDelay;
    session.reconnectDelay = Math.min(delay * 2, 300_000);
    session.reconnectTimer = setTimeout(() => this.connect(session), delay);
  }

  private clearSessionTimers(session: any) {
    if (session.pingTimer)      { clearInterval(session.pingTimer); session.pingTimer = null; }
    if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }
  }
}
