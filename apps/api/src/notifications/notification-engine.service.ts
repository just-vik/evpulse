// apps/api/src/notifications/notification-engine.service.ts
import * as https from 'https';
import * as http from 'http';

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../prisma/prisma.service';
import { TriggerType, TriggerContext } from './constants/triggers';
import { isWorkerRole } from '../runtime/runtime-role';
import { getNotificationMessage } from './notification-messages';

interface RuleState {
  lastValue: unknown;
  lastFiredAt: Date | null;
}

interface LatestFields {
  soc: number | null;
  speed: number | null;
  latitude: number | null;
  longitude: number | null;
}

@Injectable()
export class NotificationEngineService {
  private readonly logger = new Logger(NotificationEngineService.name);
  private readonly ruleStates = new Map<string, RuleState>();

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('notifications') private readonly queue: Queue,
  ) { }

  @Cron('*/5 * * * *')
  async evaluate() {
    if (!isWorkerRole()) return;
    this.logger.log(`NotificationEngine: cron tick — checking rules`);
    try {
      await this.runEvaluation();
    } catch (err: any) {
      this.logger.error(`Engine evaluation error: ${err.message}`);
    }
  }

  /**
   * FIX #1: subquery per field — каждый находит последний NON-NULL timestamp.
   * Решает проблему sparse batches (Tesla шлёт поля независимо).
   */
  private async getLatestFields(vehicleId: string): Promise<LatestFields> {
    const rows = await this.prisma.$queryRaw<LatestFields[]>`
      SELECT
        (
          SELECT CAST(soc AS FLOAT)
          FROM telemetry_points
          WHERE "vehicleId" = ${vehicleId}
            AND soc IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT 1
        ) AS soc,
        (
          SELECT CAST(speed AS FLOAT)
          FROM telemetry_points
          WHERE "vehicleId" = ${vehicleId}
            AND speed IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT 1
        ) AS speed,
        (
          SELECT CAST(latitude AS FLOAT)
          FROM telemetry_points
          WHERE "vehicleId" = ${vehicleId}
            AND latitude IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT 1
        ) AS latitude,
        (
          SELECT CAST(longitude AS FLOAT)
          FROM telemetry_points
          WHERE "vehicleId" = ${vehicleId}
            AND longitude IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT 1
        ) AS longitude
    `;

    return rows[0] ?? { soc: null, speed: null, latitude: null, longitude: null };
  }

  private async runEvaluation() {
    const rules = await this.prisma.notificationRule.findMany({
      where: { enabled: true },
    });

    this.logger.log(`NotificationEngine: found ${rules.length} active rules`);
    if (!rules.length) return;

    // Batch-fetch user languages so Telegram messages arrive in the user's language
    const userIds = [...new Set(rules.map((r) => r.userId).filter(Boolean))];
    const langRows = await this.prisma.$queryRaw<Array<{ userId: string; language: string }>>`
      SELECT "userId", language FROM user_settings WHERE "userId" = ANY(${userIds}::text[])
    `.catch(() => [] as Array<{ userId: string; language: string }>);
    const userLangMap = new Map<string, string>(langRows.map((r) => [r.userId, r.language]));

    const vehicleIds: string[] = [];
    const seenVehicles = new Set<string>();
    for (const r of rules) {
      const id = r.vehicleId as unknown;
      if (typeof id === 'string' && id.length > 0 && !seenVehicles.has(id)) {
        seenVehicles.add(id);
        vehicleIds.push(id);
      }
    }

    const telemetryMap = new Map<string, TriggerContext>();

    await Promise.all(
      vehicleIds.map(async (vid) => {
        try {
          const fields = await this.getLatestFields(vid);

          this.logger.debug(
            `Engine: latest fields for ${vid}: soc=${fields.soc} speed=${fields.speed} ` +
            `lat=${fields.latitude} lon=${fields.longitude}`,
          );

          telemetryMap.set(vid, {
            vehicleId: vid,
            // FIX #2: CAST AS FLOAT в SQL + Number() убирают Prisma Decimal → NaN
            soc: fields.soc !== null ? Number(fields.soc) : null,
            speed: fields.speed !== null ? Number(fields.speed) : null,
            chargingState: null, // заполнится из vehicleState ниже
            locked: null,
            latitude: fields.latitude,
            longitude: fields.longitude,
          });
        } catch (err: any) {
          this.logger.error(`Engine: telemetry fetch error for ${vid}: ${err.message}`);
        }
      }),
    );

    this.logger.log(
      `Engine: telemetryMap size=${telemetryMap.size} vehicleIds=${vehicleIds.join(',')}`,
    );

    // chargingState живёт только в vehicleState — единственный источник истины.
    // Если null — checkRule сделает ранний return для CHARGING_* правил
    // и подождёт следующего тика (VehicleStateMachine обновит при следующем событии).
    const states = await this.prisma.vehicleState.findMany({
      where: { vehicleId: { in: vehicleIds } },
      select: { vehicleId: true, chargingState: true, locked: true },
    });

    for (const s of states) {
      const ctx = telemetryMap.get(s.vehicleId);
      if (ctx) {
        ctx.chargingState = s.chargingState;
        ctx.locked = s.locked;
      }
    }

    const activeStateKeys = new Set<string>();

    for (const rule of rules) {
      try {
        const lang = userLangMap.get(rule.userId) ?? 'en';
        const vids = rule.vehicleId
          ? [rule.vehicleId]
          : (
            await this.prisma.vehicle.findMany({
              where: { userId: rule.userId, status: 'active' },
              select: { id: true },
            })
          ).map((v) => v.id);

        for (const vid of vids) {
          activeStateKeys.add(`${rule.id}:${vid}`);
          const ctx = telemetryMap.get(vid);
          if (!ctx) continue;
          await this.checkRule(rule, ctx, lang);
        }
      } catch (err: any) {
        this.logger.warn(`Rule ${rule.id} evaluation error: ${err.message}`);
      }
    }

    // Evict state for rules that were deleted or disabled since the last tick.
    for (const key of this.ruleStates.keys()) {
      if (!activeStateKeys.has(key)) this.ruleStates.delete(key);
    }
  }

  /**
   * Evaluate optional JSONB conditions attached to a rule.
   * Each condition: { field, op, value }
   * Returns true if ALL conditions pass (or no conditions defined).
   */
  private passesConditions(rule: any, ctx: TriggerContext): boolean {
    const conditions = rule.conditions as any[] | null | undefined;
    if (!conditions || !Array.isArray(conditions) || conditions.length === 0) return true;

    const nowHour = new Date().getUTCHours();

    for (const c of conditions) {
      switch (c.field) {
        case 'time_of_day': {
          // value: [startHour, endHour] UTC — inclusive range, handles midnight wrap
          const [start, end] = c.value as [number, number];
          const inRange = start <= end
            ? nowHour >= start && nowHour < end
            : nowHour >= start || nowHour < end; // midnight wrap e.g. [22, 6]
          if (!inRange) return false;
          break;
        }
        case 'vehicle_id': {
          if (c.op === 'is' && ctx.vehicleId !== c.value) return false;
          if (c.op === 'not' && ctx.vehicleId === c.value) return false;
          break;
        }
        case 'location': {
          // value: { lat, lng, radiusM }
          if (ctx.latitude == null || ctx.longitude == null) return false;
          const dist = haversineMeters(ctx.latitude, ctx.longitude, c.value.lat, c.value.lng);
          if (c.op === 'near' && dist > c.value.radiusM) return false;
          if (c.op === 'away' && dist <= c.value.radiusM) return false;
          break;
        }
        default:
          break;
      }
    }
    return true;
  }

  /**
   * Dispatch webhook-type actions defined in rule.actions JSONB.
   * Fires and forgets — errors are logged but never block notification delivery.
   */
  private dispatchWebhooks(rule: any, payload: { title: string; body: string; vehicleId: string }): void {
    const actions = rule.actions as any[] | null | undefined;
    if (!actions || !Array.isArray(actions)) return;

    for (const action of actions) {
      if (action.type !== 'webhook') continue;
      const { url, method = 'POST', headers = {} } = action.config ?? {};
      if (!url) continue;

      const data = JSON.stringify({ ...payload, ruleId: rule.id, firedAt: new Date().toISOString() });
      try {
        const parsed = new URL(url);
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.request(url, {
          method,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
        });
        req.on('error', (e) => this.logger.warn(`Webhook ${url} error: ${e.message}`));
        req.write(data);
        req.end();
      } catch (e: any) {
        this.logger.warn(`Webhook dispatch error: ${e.message}`);
      }
    }
  }

  private async checkRule(rule: any, ctx: TriggerContext, lang = 'en'): Promise<void> {
    const triggerType = (rule.triggerType || rule.ruleType) as TriggerType;
    const tv = (rule.triggerValue as Record<string, unknown>) ?? {};
    const threshold =
      typeof tv['value'] === 'number' ? tv['value'] : (rule.threshold ?? 0);

    const stateKey = `${rule.id}:${ctx.vehicleId}`;
    const prevState = this.ruleStates.get(stateKey) ?? {
      lastValue: null,
      lastFiredAt: rule.lastFiredAt,
    };

    this.logger.debug(
      `checkRule: type=${triggerType} threshold=${threshold} ` +
      `soc=${ctx.soc} chargingState=${ctx.chargingState} prevValue=${prevState.lastValue}`,
    );

    let shouldFire = false;
    let currentValue: unknown = null;

    switch (triggerType) {
      case TriggerType.SOC_BELOW: {
        if (ctx.soc === null) return;
        currentValue = ctx.soc;
        shouldFire =
          ctx.soc < threshold &&
          (prevState.lastValue === null || (prevState.lastValue as number) >= threshold);
        break;
      }
      case TriggerType.SOC_ABOVE: {
        if (ctx.soc === null) return;
        currentValue = ctx.soc;
        shouldFire =
          ctx.soc >= threshold &&
          (prevState.lastValue === null || (prevState.lastValue as number) < threshold);
        break;
      }
      case TriggerType.CHARGING_STARTED: {
        if (ctx.chargingState === null) return;
        const charging = ctx.chargingState === 'Charging';
        currentValue = charging;
        shouldFire = charging && prevState.lastValue !== true;
        break;
      }
      case TriggerType.CHARGING_COMPLETE: {
        if (ctx.chargingState === null || ctx.soc === null) return;
        currentValue = ctx.chargingState;
        const wasCharging = prevState.lastValue === 'Charging';
        shouldFire = wasCharging && ctx.chargingState !== 'Charging' && ctx.soc >= 98;
        break;
      }
      case TriggerType.VEHICLE_UNLOCKED: {
        if (ctx.locked === null) return;
        currentValue = ctx.locked;
        shouldFire = !ctx.locked && prevState.lastValue !== false;
        break;
      }
      case TriggerType.SPEED_ABOVE: {
        if (ctx.speed === null) return;
        currentValue = ctx.speed;
        shouldFire =
          ctx.speed > threshold &&
          (prevState.lastValue === null || (prevState.lastValue as number) <= threshold);
        break;
      }
      case TriggerType.NOT_CHARGING_AT_HOME: {
        if (ctx.soc === null || ctx.latitude === null || ctx.longitude === null) return;
        // Fetch home coordinates from vehicle settings
        const vs = await this.prisma.vehicleSettings.findUnique({
          where: { vehicleId: ctx.vehicleId },
          select: { homeLatitude: true, homeLongitude: true },
        });
        if (!vs?.homeLatitude || !vs?.homeLongitude) return;
        const distM = haversineMeters(ctx.latitude, ctx.longitude, vs.homeLatitude, vs.homeLongitude);
        const atHome = distM < 200;
        const notChargingLowSoc = atHome && ctx.chargingState !== 'Charging' && ctx.soc < threshold;
        currentValue = notChargingLowSoc;
        shouldFire = notChargingLowSoc && prevState.lastValue !== true;
        break;
      }
      case TriggerType.DEGRADATION_ABOVE: {
        const bh = await this.prisma.batteryHealth.findFirst({
          where: { vehicleId: ctx.vehicleId },
          orderBy: { timestamp: 'desc' },
          select: { degradationPercent: true },
        });
        if (!bh) return;
        currentValue = bh.degradationPercent;
        shouldFire =
          bh.degradationPercent > threshold &&
          (prevState.lastValue === null || (prevState.lastValue as number) <= threshold);
        break;
      }
      case TriggerType.VAMPIRE_DRAIN_ABOVE: {
        // Average drain over last 7 days of logs
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const logs = await this.prisma.vampireDrainLog.findMany({
          where: { vehicleId: ctx.vehicleId, parkedAt: { gte: since } },
          select: { drainPerHr: true, durationHrs: true },
        });
        if (!logs.length) return;
        const totalHrs = logs.reduce((s, l) => s + l.durationHrs, 0);
        const avgDrain = logs.reduce((s, l) => s + l.drainPerHr * l.durationHrs, 0) / totalHrs;
        currentValue = avgDrain;
        shouldFire =
          avgDrain > threshold &&
          (prevState.lastValue === null || (prevState.lastValue as number) <= threshold);
        break;
      }
      default:
        return;
    }

    const { title, body } = getNotificationMessage(triggerType, lang, {
      soc:       ctx.soc,
      speed:     ctx.speed,
      threshold,
      value:     typeof currentValue === 'number' ? currentValue : undefined,
    });

    // Обновляем lastValue до проверки shouldFire — состояние машины всегда актуально
    this.ruleStates.set(stateKey, {
      lastValue: currentValue,
      lastFiredAt: prevState.lastFiredAt,
    });

    if (!shouldFire) return;

    if (!this.passesConditions(rule, ctx)) {
      this.logger.debug(`Rule ${rule.id}: conditions not met, skipping`);
      return;
    }

    const cooldownMs = (rule.cooldownSec ?? 3600) * 1000;
    const now = Date.now();
    const lastFired = prevState.lastFiredAt
      ? new Date(prevState.lastFiredAt).getTime()
      : 0;

    if (now - lastFired < cooldownMs) {
      this.logger.debug(
        `Rule ${rule.id}: cooldown active, ${Math.round((cooldownMs - (now - lastFired)) / 1000)}s remaining`,
      );
      return;
    }

    await this.queue.add('deliver', {
      ruleId: rule.id,
      userId: rule.userId,
      vehicleId: ctx.vehicleId,
      title,
      body,
      channels: rule.channels?.length ? rule.channels : ['in_app'],
    });

    this.dispatchWebhooks(rule, { title, body, vehicleId: ctx.vehicleId });

    const firedAt = new Date();
    await this.prisma.notificationRule.update({
      where: { id: rule.id },
      data: { lastFiredAt: firedAt },
    });

    this.ruleStates.set(stateKey, { lastValue: currentValue, lastFiredAt: firedAt });

    this.logger.log(
      `Rule ${rule.id} fired: ${title} for vehicle ${ctx.vehicleId}`,
    );
  }
}