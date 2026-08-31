import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SpanStatusCode } from '@opentelemetry/api';
import { PrismaService } from '../prisma/prisma.service';
import { TeslaFleetService } from './tesla-fleet.service';
import { TeslaOAuthService } from './tesla-oauth.service';
import { MetricsService } from '../metrics/metrics.service';
import { isWorkerRole } from '../runtime/runtime-role';
import { tracer } from '../otel';

/**
 * ChargingSyncService — syncs charging sessions with Tesla billing API.
 *
 * Tesla provides /api/1/dx/charging/history which is the same source
 * the Tesla App uses. It contains:
 *  - Exact energy delivered (kWh)
 *  - Real-time pricing (€/kWh, dynamic tariffs)
 *  - True session start/end times
 *  - Charger type (SUPERCHARGER / HOME_CHARGER / DESTINATION / OTHER)
 *  - Site location name
 *
 * Flow:
 *   1. Cron every 15 min → find sessions from last 48h not yet synced
 *   2. For each session, fetch Tesla history with ±10 min window
 *   3. Match by start time (±10 min tolerance)
 *   4. Update session with real cost / energy / location / charger type
 *
 * Additionally, when a charging session starts (called from TelemetryFetcherService),
 * we attempt backfill to get the real start time in case polling missed the beginning.
 */
@Injectable()
export class ChargingSyncService {
  private readonly logger = new Logger(ChargingSyncService.name);

  // Tracks in-flight sync attempts to avoid double processing
  private readonly inFlightSyncs = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly teslaFleet: TeslaFleetService,
    private readonly teslaOAuth: TeslaOAuthService,
    private readonly metrics: MetricsService,
  ) {}

  // ─────────────────────── Periodic cron sync ───────────────────────────────

  /**
   * Every 15 minutes: sync completed sessions from the last 48h
   * that haven't been updated from Tesla billing API yet.
   */
  @Cron('*/15 * * * *')
  async syncRecentSessions(): Promise<void> {
    if (!isWorkerRole()) return;
    try {
      const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const now   = new Date();

      const sessions = await this.prisma.chargingSession.findMany({
        where: {
          AND: [
            {
              OR: [
                // Explicit Tesla SC — full retry budget until billing finalizes.
                { chargerType: { in: ['tesla_sc', 'supercharger'] } },
                // High-power DC logged as third-party: short probe for Tesla history match (real SC
                // before brand/GPS) without hammering Ionity-class sessions for days.
                {
                  AND: [
                    { chargerType: { in: ['dc_third', 'dc_fast'] } },
                    { maxPowerKw: { gt: 50 } },
                  ],
                },
              ],
            },
            // Prisma 5: `notIn` on a nullable field excludes NULL rows (SQL semantics).
            // Explicitly include NULL so new sessions with no costSource are picked up.
            // Also include 'tesla_api_estimate' so sessions with a derived (not confirmed) total
            // are re-queued until Tesla publishes the authoritative totalDue.
            {
              OR: [
                { costSource: null },
                { costSource: { notIn: ['tesla_api', 'manual', 'scope_missing'] } },
              ],
            },
            { endTime: { not: null, gte: since } },
            {
              OR: [
                { billingNextSyncAt: null },
                { billingNextSyncAt: { lte: now } },
              ],
            },
          ],
        },
        include: {
          vehicle: {
            select: { id: true, vin: true, userId: true },
          },
        },
        orderBy: [
          { billingNextSyncAt: { sort: 'asc', nulls: 'first' } },
          { startTime: 'desc' },
        ],
        take: 30,
      });

      if (!sessions.length) return;

      this.logger.debug(`ChargingSync: ${sessions.length} session(s) pending Tesla API sync`);

      for (const session of sessions) {
        if (!session.vehicle?.vin || !session.vehicle?.userId) continue;
        await this.syncOneSession(session.id).catch((e: Error) =>
          this.logger.warn(`Sync failed for session ${session.id}: ${e.message}`),
        );
      }
    } catch (err: any) {
      this.logger.error(`ChargingSync cron error: ${err.message}`);
    }
  }

  // ─────────────────────── Called after session end ─────────────────────────

  /**
   * Triggered by TelemetryFetcherService when a charging session ends.
   * Waits 5 minutes for Tesla to publish billing data, then syncs.
   */
  syncSessionAfterEnd(sessionId: string): void {
    // Tesla updates billing history with a 5–10 minute delay
    const delayMs = 5 * 60 * 1000;
    setTimeout(async () => {
      try {
        await this.syncOneSession(sessionId);
      } catch (err: any) {
        this.logger.warn(`Delayed sync failed for session ${sessionId}: ${err.message}`);
      }
    }, delayMs);
  }

  // ─────────────────────── Backfill session start ───────────────────────────

  /**
   * Called when TelemetryFetcherService detects charging has started.
   * Looks up Tesla's history for an active session and corrects startTime / startSoc
   * in case polling missed the beginning (e.g. parked interval = 15 min gap).
   */
  async backfillSessionStart(vehicleId: string, vin: string, userId: string): Promise<void> {
    const span = tracer.startSpan('charging.backfill_session', {
      attributes: { 'vehicle.id': vehicleId },
    });
    try {
      // Find the active (open) session for this vehicle
      const session = await (this.prisma as any).chargingSession.findFirst({
        where: { vehicleId, endTime: null },
        orderBy: { startTime: 'desc' },
      });
      if (!session) { span.end(); return; }
      span.setAttribute('session.id', session.id);

      // Only backfill if session started less than 30 min ago (recently opened)
      const ageMs = Date.now() - new Date(session.startTime).getTime();
      if (ageMs > 30 * 60 * 1000) { span.end(); return; }

      const accessToken = await this.teslaOAuth.getValidAccessToken(userId);

      // Look in Tesla history for the last hour
      const history = await this.teslaFleet.getChargingHistory(accessToken, {
        vin,
        startTime: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        endTime: new Date().toISOString(),
      });

      if (!history.length) { span.end(); return; }

      // Find an active or very recent session (no stopDateTime or ended within 5 min)
      const now = Date.now();
      const match = history.find((h: any) => {
        if (h.chargeStopDateTime) {
          // Allow recently ended sessions too
          const stoppedAt = new Date(h.chargeStopDateTime).getTime();
          if (now - stoppedAt > 5 * 60 * 1000) return false;
        }
        const histStart = new Date(h.chargeStartDateTime).getTime();
        const ourStart = new Date(session.startTime).getTime();
        // Within 30 minute window (our polling might have been 15 min late)
        return Math.abs(histStart - ourStart) < 30 * 60 * 1000;
      });

      if (!match) { span.end(); return; }

      const realStart = new Date(match.chargeStartDateTime);
      const realStartMs = realStart.getTime();
      const ourStartMs = new Date(session.startTime).getTime();

      // Only update if Tesla's start is meaningfully earlier (>2 min)
      if (ourStartMs - realStartMs > 2 * 60 * 1000) {
        const startingSoc = match.startingSoc != null ? parseFloat(match.startingSoc) : null;

        // Record SoC lag before overwriting: positive = we detected charging N% late.
        // After reducing parked interval to 5 min this should drop to <5%.
        if (session.startSoc != null && startingSoc != null) {
          const lagPct = session.startSoc - startingSoc;
          span.setAttribute('charging.start_soc_original',  session.startSoc);
          span.setAttribute('charging.start_soc_corrected', startingSoc);
          span.setAttribute('charging.lag_pct',             lagPct);
          if (lagPct > 0) {
            this.metrics.chargingStartLagPct.observe(lagPct);
          }
        }

        await (this.prisma as any).chargingSession.update({
          where: { id: session.id },
          data: {
            startTime: realStart,
            ...(startingSoc != null ? { startSoc: startingSoc } : {}),
          },
        });

        this.logger.log(
          `[Backfill] Session ${session.id}: corrected start from ${session.startTime.toISOString()} → ${realStart.toISOString()} ` +
          `(gap: ${Math.round((ourStartMs - realStartMs) / 60000)} min)` +
          (startingSoc != null ? `, SOC: ${startingSoc}%` : ''),
        );
      }
      span.end();
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.end();
      this.logger.debug(`Backfill skipped for vehicle ${vehicleId}: ${err.message}`);
    }
  }

  // ─────────────────────── Core sync logic ──────────────────────────────────

  private async syncOneSession(sessionId: string): Promise<void> {

    // Avoid concurrent sync for same session
    if (this.inFlightSyncs.has(sessionId)) return;
    this.inFlightSyncs.add(sessionId);

    try {
      const row = await this.prisma.chargingSession.findUnique({
        where: { id: sessionId },
        include: {
          vehicle: { select: { id: true, vin: true, userId: true } },
        },
      });
      if (!row || !row.vehicle?.vin || !row.vehicle?.userId) return;
      if (row.costSource === 'tesla_api' || row.costSource === 'manual' || row.costSource === 'scope_missing') {
        return;
      }

      const attempts = row.billingSyncAttempts ?? 0;
      const maxAttempts = this.maxBillingAttemptsFor(row);
      if (attempts >= maxAttempts) {
        this.logger.debug(`Billing retry cap reached for session ${sessionId} (${maxAttempts} max)`);
        return;
      }

      const { vin, userId } = row.vehicle;

      let accessToken: string;
      try {
        accessToken = await this.teslaOAuth.getValidAccessToken(userId);
      } catch (e: any) {
        this.logger.debug(`No access token for billing sync ${sessionId}: ${e?.message ?? e}`);
        await this.scheduleBillingRetry(sessionId, attempts, maxAttempts);
        return;
      }

      // Fetch history with ±15 min buffer around session
      const startTime = new Date(new Date(row.startTime).getTime() - 15 * 60 * 1000).toISOString();
      const endTime = row.endTime
        ? new Date(new Date(row.endTime).getTime() + 20 * 60 * 1000).toISOString()
        : new Date().toISOString();

      let history: any[];
      try {
        history = await this.teslaFleet.getChargingHistory(accessToken, {
          vin,
          startTime,
          endTime,
        });
      } catch (err: any) {
        if (err.message === 'BILLING_SCOPE_MISSING') {
          // Tesla billing API requires additional OAuth scope (billing / energy_device_data).
          // Mark all pending sessions to stop retrying until scope is granted.
          this.logger.warn(
            `Tesla billing API returned 403 — charging history requires additional OAuth scope. ` +
            `Marking sessions as 'scope_missing'. ` +
            `To enable: re-authorize with scope including 'energy_device_data'.`,
          );
          // Only mark sessions that have no cost calculation at all — don't overwrite tariff/supercharger costs
          await this.prisma.chargingSession.updateMany({
            where: { costSource: null, endTime: { not: null } },
            data: { costSource: 'scope_missing' },
          });
          return;
        }
        this.logger.warn(`Charging history request failed for ${sessionId}: ${err?.message ?? err}`);
        await this.scheduleBillingRetry(sessionId, attempts, maxAttempts);
        return;
      }

      if (!history.length) {
        this.logger.debug(`No Tesla history for session ${sessionId} (API may not be enabled)`);
        await this.scheduleBillingRetry(sessionId, attempts, maxAttempts);
        return;
      }

      const match = this.findMatchingHistory(history, row);
      if (!match) {
        this.logger.debug(`No Tesla history match for session ${sessionId}`);
        await this.scheduleBillingRetry(sessionId, attempts, maxAttempts);
        return;
      }

      // Extract billing data from matched session
      const billingData = this.extractBillingData(match, row);
      if (!billingData) {
        await this.scheduleBillingRetry(sessionId, attempts, maxAttempts);
        return;
      }

      // For estimates: schedule a re-sync in 1 hour to get the confirmed totalDue.
      const isEstimate = billingData.costSource === 'tesla_api_estimate';
      await this.prisma.chargingSession.update({
        where: { id: sessionId },
        data: {
          ...billingData,
          billingNextSyncAt:   isEstimate ? new Date(Date.now() + 60 * 60 * 1000) : null,
          billingSyncAttempts: isEstimate ? (attempts + 1) : 0,
        },
      });
    } finally {
      this.inFlightSyncs.delete(sessionId);
    }
  }

  /** Fewer retries for high-power dc_third probes (likely non-Tesla DC) vs explicit Tesla SC. */
  private maxBillingAttemptsFor(row: { chargerType?: string | null; maxPowerKw?: unknown }): number {
    const explicitSc =
      row.chargerType === 'tesla_sc' || row.chargerType === 'supercharger';
    const hp = Number(row.maxPowerKw) > 50;
    const probeDc =
      (row.chargerType === 'dc_third' || row.chargerType === 'dc_fast') && hp;
    if (probeDc && !explicitSc) return 8;
    return 48;
  }

  /** Exponential backoff (5 min × 2^n, cap 24 h) until Tesla billing finalizes */
  private async scheduleBillingRetry(
    sessionId: string,
    attempts: number,
    maxAttempts = 48,
  ): Promise<void> {
    if (attempts >= maxAttempts) return;
    const nextMs = Math.min(
      Math.pow(2, attempts) * 5 * 60 * 1000,
      24 * 60 * 60 * 1000,
    );
    const billingNextSyncAt = new Date(Date.now() + nextMs);
    await this.prisma.chargingSession.update({
      where: { id: sessionId },
      data: {
        billingSyncAttempts: attempts + 1,
        billingNextSyncAt,
      },
    });
    this.logger.debug(
      `Charging billing retry scheduled for ${sessionId} in ${Math.round(nextMs / 60000)} min (attempt ${attempts + 1})`,
    );
  }

  // ─────────────────────── Matching & extraction helpers ────────────────────

  private findMatchingHistory(history: any[], session: any): any | null {
    const sessionStart = new Date(session.startTime).getTime();

    // Try to match by start time (±10 min tolerance)
    const byTime = history.find((h: any) => {
      const histStart = new Date(h.chargeStartDateTime).getTime();
      return Math.abs(histStart - sessionStart) < 10 * 60 * 1000;
    });
    if (byTime) return byTime;

    // Fallback: match by energy amount (within 2 kWh) if session energy is known
    if (session.energyAddedKwh && session.energyAddedKwh > 2) {
      return history.find((h: any) => {
        const chargingFee = this.getChargingFee(h);
        if (!chargingFee) return false;
        return Math.abs((chargingFee.usageBase ?? 0) - session.energyAddedKwh) < 2;
      }) ?? null;
    }

    return null;
  }

  private getChargingFee(histItem: any): any | null {
    if (!Array.isArray(histItem.fees)) return null;
    // Primary: CHARGING fee in kWh
    return histItem.fees.find((f: any) =>
      f.feeType === 'CHARGING' && (f.uom === 'kwh' || f.uom === 'KWH'),
    ) ?? null;
  }

  private extractBillingData(
    match: any,
    session: any,
  ): Record<string, any> | null {
    const chargingFee = this.getChargingFee(match);

    // Tesla can have different fee structures:
    // - Supercharger: CHARGING fee in kWh
    // - Some markets: per-minute billing (uom = 'min')
    // Total cost is match.totalDue (includes all fees: energy + idle + parking).
    //
    // totalDue may be null/undefined when Tesla billing is still processing (< 5 min after end).
    // In that case return null so the cron retries rather than writing €0.
    const totalDue = match.totalDue != null ? Number(match.totalDue) : null;

    const energyKwh = chargingFee?.usageBase
      ?? chargingFee?.usageTotal
      ?? session.energyAddedKwh
      ?? 0;

    // costPerKwh: derive from totalDue/energy when available, else use Tesla's rateBase field.
    // Do NOT fall back to a hardcoded default — better to leave null than write a wrong rate.
    let costPerKwh: number | null = null;
    if (totalDue != null && energyKwh > 0) {
      costPerKwh = Math.round((totalDue / energyKwh) * 10000) / 10000;
    } else if (chargingFee?.rateBase != null) {
      costPerKwh = chargingFee.rateBase;
    } else if (chargingFee?.rate != null) {
      costPerKwh = chargingFee.rate;
    }

    // If Tesla hasn't finalized billing yet (both cost and rate unknown), skip — retry later.
    if (totalDue === null && costPerKwh === null) {
      this.logger.debug(`[Sync] Tesla billing not finalized yet for session ${session.id} — will retry`);
      return null;
    }

    // If totalDue is null but rate is known, derive costTotal from rate × energy.
    // Tesla sometimes provides the tariff rate before the final invoice is issued.
    // Mark source as 'tesla_api_estimate' so this session will be re-queued for a final sync
    // once Tesla publishes the authoritative totalDue (which may include idle/parking fees).
    const derivedTotal =
      totalDue === null && costPerKwh != null && energyKwh > 0
        ? Math.round(costPerKwh * energyKwh * 100) / 100
        : null;
    const finalTotal   = totalDue !== null ? Math.round(totalDue * 100) / 100 : derivedTotal;
    // Use 'tesla_api' only when totalDue is confirmed; otherwise mark for re-sync after ~1 h.
    const costSourceVal = totalDue !== null ? 'tesla_api' : 'tesla_api_estimate';

    const chargerType = this.mapTeslaChargerType(match.chargerType ?? '');
    const location = match.siteLocationName || match.siteName || session.location || null;

    // Real start/end times from Tesla billing (only update if Tesla's value is earlier / fills gap)
    const realStart = match.chargeStartDateTime ? new Date(match.chargeStartDateTime) : null;
    const realEnd   = match.chargeStopDateTime  ? new Date(match.chargeStopDateTime)  : null;

    this.logger.log(
      `[Sync] session=${session.id} ` +
      `${energyKwh.toFixed(3)} kWh @ €${costPerKwh?.toFixed(3)}/kWh = €${finalTotal?.toFixed(2)} ` +
      `(${costSourceVal}) ` +
      (location ? `@ ${location}` : ''),
    );

    return {
      costTotal:      finalTotal ?? undefined,
      costPerKwh:     costPerKwh ?? undefined,
      costSource:     costSourceVal,
      currency:       match.fees?.[0]?.currencyCode ?? 'EUR',
      energyAddedKwh: energyKwh > 0 ? Math.round(energyKwh * 1000) / 1000 : undefined,
      location:       location ?? undefined,
      // Only update chargerType when Tesla confirms it (don't overwrite with 'unknown')
      ...(chargerType !== 'unknown' ? { chargerType } : {}),
      // Correct start time only if Tesla shows it started earlier than we detected
      ...(realStart && realStart < new Date(session.startTime) ? { startTime: realStart } : {}),
      // Fill end time only if session was force-closed without an endTime
      ...(realEnd && !session.endTime ? { endTime: realEnd } : {}),
    };
  }

  /** Admin: force-sync all unsynced SC/DC sessions from the last N days. */
  async adminSyncRecent(days = 7): Promise<{ synced: number; errors: string[] }> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const sessions = await this.prisma.chargingSession.findMany({
      where: {
        AND: [
          { chargerType: { in: ['tesla_sc', 'supercharger', 'dc_third', 'dc_fast'] } },
          {
            OR: [
              { costSource: null },
              { costSource: { notIn: ['tesla_api', 'manual', 'scope_missing'] } },
            ],
          },
          { endTime: { not: null, gte: since } },
        ],
      },
      select: { id: true },
      orderBy: { startTime: 'desc' },
      take: 100,
    });

    let synced = 0;
    const errors: string[] = [];
    for (const s of sessions) {
      try {
        await this.syncOneSession(s.id);
        synced++;
      } catch (e: any) {
        errors.push(`${s.id}: ${e.message}`);
      }
    }
    return { synced, errors };
  }

  private mapTeslaChargerType(teslaType: string): string {
    const t = teslaType.toUpperCase();
    if (t.includes('SUPER'))       return 'tesla_sc';   // canonical SC type
    if (t.includes('HOME'))        return 'home_wall';  // Tesla Wall Connector
    if (t.includes('DESTINATION')) return 'ac_city';    // destination AC charger
    if (t.includes('DC'))          return 'dc_third';   // 3rd-party DC fast
    return 'unknown';
  }
}
