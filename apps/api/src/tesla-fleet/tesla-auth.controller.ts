import { Controller, Get, Delete, Headers, Post, Query, UnauthorizedException, UseGuards, Req, Res, Logger, Inject, HttpCode, HttpStatus } from '@nestjs/common';
import { OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { TeslaOAuthService } from './tesla-oauth.service';
import { TeslaFleetService } from './tesla-fleet.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { TelemetryQueueService } from '../queues/telemetry-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryFetcherService } from './telemetry-fetcher.service';
import { UsersService } from '../users/users.service';
import { VampireDrainService } from '../telemetry/vampire-drain.service';
import { ChargingSyncService } from './charging-sync.service';

/**
 * Tesla OAuth Controller
 *
 * Cross-domain safe flow (no cookies required):
 * 1. POST /auth/tesla/link  (requires JWT Bearer) → returns { url }
 * 2. Frontend redirects browser to that URL (Tesla OAuth)
 * 3. Tesla redirects to GET /auth/tesla/callback?code=...&state=...
 * 4. Callback looks up userId from server-side Redis state store — no JWT needed
 */
@Controller('auth/tesla')
export class TeslaAuthController implements OnApplicationBootstrap {
  private readonly logger = new Logger(TeslaAuthController.name);
  private readonly frontendUrl: string;
  private readonly redisKeyPrefix = 'tesla:oauth:';
  private readonly redisKeyTtl = 600; // 10 minutes

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly teslaOAuth:  TeslaOAuthService,
    private readonly teslaFleet:  TeslaFleetService,
    private readonly telemetryQueue: TelemetryQueueService,
    private readonly telemetryFetcher: TelemetryFetcherService,
    private readonly config:      ConfigService,
    private readonly prisma:      PrismaService,
    private readonly usersService: UsersService,
    private readonly vampireDrain: VampireDrainService,
    private readonly chargingSync: ChargingSyncService,
  ) {
    this.frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'https://evpulse.app';
  }

  /**
   * Auto-configure fleet telemetry disabled: Tesla subscription persists server-side
   * indefinitely and the EU API rejects some of our field names, causing 400 errors on
   * every restart. Reconfigure manually via POST /api/v1/auth/tesla/configure-telemetry.
   */
  onApplicationBootstrap() {
    // auto-configure intentionally disabled — see comment above
  }

  private async autoConfigureTelemetry(): Promise<void> {
    const hostname = (
      this.config.get<string>('FLEET_TELEMETRY_HOSTNAME') ?? 'api.evpulse.app'
    ).replace(/^https?:\/\//, '').replace(/\/$/, '');

    const accounts = await this.prisma.teslaAccount.findMany({
      include: { vehicleLinks: { include: { vehicle: true } } },
    }).catch(() => []);

    if (!accounts.length) return;

    let configured = 0;
    for (const account of accounts) {
      try {
        const accessToken = await this.teslaOAuth.getValidAccessToken(account.userId);
        const vins = account.vehicleLinks
          .map((l: any) => l.vehicle?.vin)
          .filter(Boolean) as string[];
        if (!vins.length) continue;
        await this.teslaFleet.configureTelemetry(accessToken, { vins, hostname });
        configured++;
      } catch (e: any) {
        this.logger.warn(`Auto-configure telemetry failed for account ${account.id}: ${e.message}`);
      }
    }

    if (configured > 0) {
      this.logger.log(`Auto-configured fleet telemetry for ${configured} account(s) on startup`);
    }
  }

  /**
   * Initiate Tesla OAuth.
   * Requires JWT Bearer so we know which user is linking.
   * Returns JSON { url } — frontend performs the redirect itself.
   * State is stored in Redis with 10-minute expiry.
   */
  @Post('link')
  @UseGuards(JwtAuthGuard)
  async initiateLink(@Req() req: any): Promise<{ url: string }> {
    const state = crypto.randomBytes(32).toString('hex');
    const stateData = {
      userId: req.user.id,
      email: req.user.email ?? '',
    };

    await this.redis.setex(
      `${this.redisKeyPrefix}${state}`,
      this.redisKeyTtl,
      JSON.stringify(stateData),
    );

    return { url: this.teslaFleet.getAuthorizationUrl(state) };
  }

  /**
   * Handle Tesla OAuth callback.
   * No JWT guard — user identity recovered from server-side Redis state store.
   * 
   * Vehicle sync is enqueued (async) so callback returns immediately.
   * This prevents timeout if Tesla API is slow.
   */
  @Get('callback')
  async callback(
    @Query('code')  code:  string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      if (!code)  throw new Error('Authorization code missing');
      if (!state) throw new Error('State parameter missing');

      const stateDataStr = await this.redis.get(`${this.redisKeyPrefix}${state}`);
      if (!stateDataStr) throw new Error('Invalid or expired state');

      await this.redis.del(`${this.redisKeyPrefix}${state}`);

      const pending = JSON.parse(stateDataStr) as { userId: string; email: string };

      const tokens = await this.teslaFleet.exchangeCodeForTokens(code);
      await this.teslaOAuth.storeTokens(pending.userId, pending.email, tokens);
      // Clear any previous auth-expired flag
      await this.teslaOAuth.clearAuthExpired(pending.userId);
      this.logger.log(`Tesla OAuth successful for user ${pending.userId}`);

      // Enqueue vehicle sync. The Bull processor configures Fleet Telemetry AFTER
      // vehicles are written to DB, fixing the race where telemetry was configured
      // before the sync job completed and VINs were available.
      await this.telemetryQueue.enqueueVehicleSync(pending.userId);

      res.redirect(`${this.frontendUrl}/settings?tab=vehicles&tesla=connected`);
    } catch (error) {
      this.logger.error(`OAuth callback failed: ${error.message}`);
      res.redirect(`${this.frontendUrl}/settings?error=tesla_callback_failed`);
    }
  }

  /**
   * Disconnect Tesla account (keep app account, only revoke Tesla access).
   */
  @Post('disconnect')
  @UseGuards(JwtAuthGuard)
  async disconnect(@Req() req: any): Promise<{ success: boolean }> {
    await this.teslaOAuth.revokeTokens(req.user.id);
    this.logger.log(`Tesla disconnected for user ${req.user.id}`);
    return { success: true };
  }

  /**
   * GDPR Art.17 + Apple App Store requirement (mandatory since 2023):
   * Full account deletion — revokes Tesla OAuth, clears session, cascades all data.
   * DELETE /api/v1/auth/tesla/account
   *
   * This is the canonical "Delete my account" endpoint:
   * - Revokes Tesla OAuth tokens (calls Tesla API)
   * - Cascade-deletes all user data (vehicles, trips, telemetry, charging, etc.)
   * - Clears session cookie
   */
  @Delete('account')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async deleteAccount(
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ deleted: true }> {
    const userId = req.user.id as string;
    const result = await this.usersService.deleteAccount(
      userId,
      (uid) => this.teslaOAuth.revokeTokens(uid),
    );
    this.logger.log(`Account deleted for user ${userId}`);
    const cookieDomain = this.config.get<string>('COOKIE_DOMAIN', 'evpulse.app');
    res.clearCookie('access_token', {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      domain: cookieDomain,
      path: '/',
    });
    return result;
  }

  /**
   * Configure Tesla Fleet Telemetry streaming to our webhook.
   * Requires JWT (per-user) and a valid linked Tesla account.
   */
  @Post('configure-telemetry')
  @UseGuards(JwtAuthGuard)
  async configureTelemetry(@Req() req: any): Promise<{ ok: boolean }> {
    const userId = req.user.id as string;
    const accessToken = await this.teslaOAuth.getValidAccessToken(userId);

    // Get all VINs for this user from DB
    const account = await this.prisma.teslaAccount.findUnique({ where: { userId } });
    if (!account) throw new Error('No Tesla account linked');

    const links = await this.prisma.teslaVehicleLink.findMany({
      where: { teslaAccountId: account.id },
      include: { vehicle: true },
    });
    const vins = links.map((l) => l.vehicle.vin).filter(Boolean) as string[];
    if (!vins.length) throw new Error('No vehicles with VIN found');

    const hostname =
      (this.config.get<string>('FLEET_TELEMETRY_HOSTNAME') ??
       this.config.get<string>('API_PUBLIC_URL') ??
       'https://api.evpulse.app')
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '');

    await this.teslaFleet.configureTelemetry(accessToken, { vins, hostname });

    return { ok: true };
  }

  /**
   * Admin: configure fleet telemetry for ALL linked Tesla accounts.
   * Protected by METRICS_SECRET header (no user JWT required — for scripts/cron).
   * Usage: curl -X POST http://localhost:3000/api/v1/auth/tesla/admin-configure-telemetry \
   *          -H "x-metrics-secret: <METRICS_SECRET>"
   */
  @Post('admin-configure-telemetry')
  async adminConfigureTelemetry(
    @Headers('x-metrics-secret') secret?: string,
  ): Promise<{ ok: boolean; configured: number; errors: string[] }> {
    const expected = this.config.get<string>('METRICS_SECRET') || process.env.METRICS_SECRET;
    if (!expected || secret !== expected) {
      throw new UnauthorizedException('Invalid metrics secret');
    }

    const hostname = (
      this.config.get<string>('FLEET_TELEMETRY_HOSTNAME') ??
      'api.evpulse.app'
    ).replace(/^https?:\/\//, '').replace(/\/$/, '');

    const accounts = await this.prisma.teslaAccount.findMany({
      include: {
        vehicleLinks: { include: { vehicle: true } },
      },
    });

    let configured = 0;
    const errors: string[] = [];

    for (const account of accounts) {
      try {
        const accessToken = await this.teslaOAuth.getValidAccessToken(account.userId);
        const vins = account.vehicleLinks
          .map((l: any) => l.vehicle?.vin)
          .filter(Boolean) as string[];

        if (!vins.length) continue;

        await this.teslaFleet.configureTelemetry(accessToken, { vins, hostname });
        configured++;
        this.logger.log(`Fleet telemetry configured for ${vins.join(',')} → ${hostname}`);
      } catch (e: any) {
        errors.push(`account ${account.id}: ${e.message}`);
        this.logger.error(`Failed to configure fleet telemetry for account ${account.id}: ${e.message}`);
      }
    }

    return { ok: errors.length === 0, configured, errors };
  }

  /**
   * Check Fleet Telemetry config status per vehicle.
   * Returns key_paired + synced from Tesla API (cached 5 min in Redis).
   */
  @Get('fleet-telemetry-status')
  @UseGuards(JwtAuthGuard)
  async getFleetTelemetryStatus(@Req() req: any): Promise<{
    vehicles: Array<{
      vehicleId: string;
      vin: string | null;
      keyPaired: boolean | null;
      synced: boolean | null;
      configured: boolean;
    }>;
  }> {
    const userId = req.user.id as string;
    const cacheKey = `fleet:telemetry:status:${userId}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch {}
    }

    try {
      const accessToken = await this.teslaOAuth.getValidAccessToken(userId);
      const account = await this.prisma.teslaAccount.findUnique({
        where: { userId },
        include: {
          vehicleLinks: {
            include: { vehicle: { select: { id: true, vin: true } } },
          },
        },
      });

      if (!account) return { vehicles: [] };

      const settled = await Promise.allSettled(
        account.vehicleLinks.map(async (link: any) => {
          const vin: string | null = link.vehicle.vin ?? null;
          if (!vin) {
            return { vehicleId: link.vehicle.id, vin: null, keyPaired: null, synced: null, configured: false };
          }
          try {
            const cfg = await this.teslaFleet.getFleetTelemetryConfig(vin, accessToken);
            return {
              vehicleId: link.vehicle.id,
              vin,
              keyPaired: cfg?.key_paired ?? null,
              synced: cfg?.synced ?? null,
              configured: cfg != null,
            };
          } catch {
            return { vehicleId: link.vehicle.id, vin, keyPaired: null, synced: null, configured: false };
          }
        }),
      );

      const vehicles = settled.map((r) =>
        r.status === 'fulfilled'
          ? r.value
          : { vehicleId: '', vin: null, keyPaired: null, synced: null, configured: false },
      );

      const result = { vehicles };
      await this.redis.setex(cacheKey, 300, JSON.stringify(result));
      return result;
    } catch {
      return { vehicles: [] };
    }
  }

  /**
   * Check Tesla connection status.
   */
  @Get('status')
  @UseGuards(JwtAuthGuard)
  async getStatus(@Req() req: any): Promise<{
    connected: boolean;
    authExpired: boolean;
    expiresAt?: Date;
    dataBlockedReason?: 'telemetry_stale' | null;
    guardrail?: {
      monthlyBudgetEur: number;
      softLimitEur: number;
      estimatedMonthSpendEur: number;
    };
    vehicles?: Array<{
      vehicleId: string;
      vin: string | null;
      lastRawAt: Date | null;
      rawLagMin: number | null;
      lastFailureReason: string | null;
      lastFailureAt: string | null;
    }>;
  }> {
    try {
      const tokens = await this.teslaOAuth.getTokens(req.user.id);
      if (!tokens) return { connected: false, authExpired: false };
      const authExpired = await this.teslaOAuth.isAuthExpired(req.user.id);

      const account = await this.prisma.teslaAccount.findUnique({
        where: { userId: req.user.id },
        include: {
          vehicleLinks: {
            include: {
              vehicle: { select: { id: true, vin: true } },
            },
          },
        },
      });

      const vehicles = account?.vehicleLinks ?? [];
      const vehicleStatuses: Array<{
        vehicleId: string;
        vin: string | null;
        lastRawAt: Date | null;
        rawLagMin: number | null;
        lastFailureReason: string | null;
        lastFailureAt: string | null;
      }> = [];

      let estimatedMonthSpendEur = 0;
      let monthlyBudgetEur = 0;
      let softLimitEur = 0;
      let staleVehicles = 0;

      for (const link of vehicles) {
        const vehicleId = link.vehicle.id;
        const rawMax = await this.prisma.$queryRaw<Array<{ ts: Date | null }>>`
          SELECT max("receivedAt") as ts
          FROM telemetry_raw
          WHERE "vehicleId" = ${vehicleId}
        `;
        const lastRawAt = rawMax[0]?.ts ?? null;
        const rawLagMin = lastRawAt
          ? Math.round((Date.now() - new Date(lastRawAt).getTime()) / 60000)
          : null;

        const failureRaw = await this.redis.get(`tesla:last-failure:${vehicleId}`);
        let lastFailureReason: string | null = null;
        let lastFailureAt: string | null = null;
        if (failureRaw) {
          try {
            const parsed = JSON.parse(failureRaw) as { reason?: string; at?: string };
            lastFailureReason = parsed.reason ?? null;
            lastFailureAt = parsed.at ?? null;
          } catch {
            // ignore malformed cache payload
          }
        }

        const budget = await this.telemetryFetcher.getBudgetStatusForVehicle(vehicleId);
        estimatedMonthSpendEur += budget.estimatedMonthSpendEur;
        monthlyBudgetEur = budget.monthlyBudgetEur;
        softLimitEur = budget.softLimitEur;

        // 'billing_scope_403' is Tesla Developer Portal enforcing its own billing limit —
        // the user is aware of this and it's not an app-level error to surface.
        // 'no_vehicle_data' means 408 / car is sleeping — expected behaviour.
        const carIsSleeping = lastFailureReason === 'no_vehicle_data'
          || lastFailureReason === 'vehicle_sleeping';
        if ((rawLagMin ?? 9_999) > 30 && !carIsSleeping) staleVehicles++;

        vehicleStatuses.push({
          vehicleId,
          vin: link.vehicle.vin ?? null,
          lastRawAt,
          rawLagMin,
          lastFailureReason,
          lastFailureAt,
        });
      }

      let dataBlockedReason: 'telemetry_stale' | null = null;
      if (vehicleStatuses.length > 0 && staleVehicles === vehicleStatuses.length) {
        dataBlockedReason = 'telemetry_stale';
      }

      return {
        connected: true,
        authExpired,
        expiresAt: tokens.expires_at,
        dataBlockedReason,
        guardrail: {
          monthlyBudgetEur,
          softLimitEur,
          estimatedMonthSpendEur: Math.round(estimatedMonthSpendEur * 100) / 100,
        },
        vehicles: vehicleStatuses,
      };
    } catch {
      return { connected: false, authExpired: false };
    }
  }

  /**
   * Admin: backfill vampire drain for all active vehicles.
   * Protected by METRICS_SECRET header.
   * Usage: curl -X POST http://localhost:3000/api/v1/auth/tesla/admin-vampire-backfill \
   *          -H "x-metrics-secret: <METRICS_SECRET>" [-G --data-urlencode "days=60"]
   */
  @Post('admin-vampire-backfill')
  async adminVampireBackfill(
    @Headers('x-metrics-secret') secret?: string,
    @Query('days') days = '60',
  ): Promise<{ ok: boolean; results: Array<{ vehicleId: string; recorded: number }> }> {
    const expected = this.config.get<string>('METRICS_SECRET') || process.env.METRICS_SECRET;
    if (!expected || secret !== expected) throw new UnauthorizedException('Invalid metrics secret');

    const vehicles = await this.prisma.vehicle.findMany({
      where: { status: 'active' },
      select: { id: true },
    });

    const results: Array<{ vehicleId: string; recorded: number }> = [];
    for (const v of vehicles) {
      try {
        const recorded = await this.vampireDrain.analyzeVehicle(v.id, +days);
        results.push({ vehicleId: v.id, recorded });
      } catch (e: any) {
        results.push({ vehicleId: v.id, recorded: -1 });
        this.logger.warn(`admin-vampire-backfill ${v.id}: ${e.message}`);
      }
    }
    return { ok: true, results };
  }

  /**
   * Admin: force-sync charging billing for recent SC/DC sessions (last N days).
   * Protected by METRICS_SECRET header.
   * Usage: curl -X POST http://localhost:3000/api/v1/auth/tesla/admin-sync-charging \
   *          -H "x-metrics-secret: <METRICS_SECRET>" [-G --data-urlencode "days=7"]
   */
  @Post('admin-sync-charging')
  async adminSyncCharging(
    @Headers('x-metrics-secret') secret?: string,
    @Query('days') days = '7',
  ): Promise<{ ok: boolean; synced: number; errors: string[] }> {
    const expected = this.config.get<string>('METRICS_SECRET') || process.env.METRICS_SECRET;
    if (!expected || secret !== expected) throw new UnauthorizedException('Invalid metrics secret');
    const result = await this.chargingSync.adminSyncRecent(+days);
    this.logger.log(`admin-sync-charging: ${result.synced} synced, ${result.errors.length} errors`);
    return { ok: result.errors.length === 0, ...result };
  }
}
