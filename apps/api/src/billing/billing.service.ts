import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const ENTITLEMENTS_CACHE_TTL = 60; // seconds

type Plan = 'FREE' | 'PRO' | 'FLEET';
type SubscriptionStatus = 'ACTIVE' | 'INACTIVE';

type Limits = {
  maxVehicles: number;
  tripHistoryDays: number;
  chargingHistoryDays: number;
  analyticsDepthDays: number;
  liveRefreshSeconds: number;
  aiInsights: boolean;
  aiAgent: boolean;
  ragEnabled: boolean;
  fleetDashboard: boolean;
  webhooks: boolean;
};

const PLAN_LIMITS: Record<Plan, Record<SubscriptionStatus, Limits>> = {
  FREE: {
    ACTIVE: {
      maxVehicles: 1, tripHistoryDays: 14, chargingHistoryDays: 30,
      analyticsDepthDays: 7, liveRefreshSeconds: 60,
      aiInsights: false, aiAgent: false, ragEnabled: false,
      fleetDashboard: false, webhooks: false,
    },
    INACTIVE: {
      maxVehicles: 1, tripHistoryDays: 7, chargingHistoryDays: 7,
      analyticsDepthDays: 7, liveRefreshSeconds: 60,
      aiInsights: false, aiAgent: false, ragEnabled: false,
      fleetDashboard: false, webhooks: false,
    },
  },
  PRO: {
    ACTIVE: {
      maxVehicles: 2, tripHistoryDays: 365, chargingHistoryDays: 365,
      analyticsDepthDays: 365, liveRefreshSeconds: 10,
      aiInsights: true, aiAgent: false, ragEnabled: true,
      fleetDashboard: false, webhooks: false,
    },
    INACTIVE: {
      maxVehicles: 1, tripHistoryDays: 7, chargingHistoryDays: 7,
      analyticsDepthDays: 7, liveRefreshSeconds: 60,
      aiInsights: false, aiAgent: false, ragEnabled: false,
      fleetDashboard: false, webhooks: false,
    },
  },
  FLEET: {
    ACTIVE: {
      maxVehicles: 50, tripHistoryDays: 730, chargingHistoryDays: 730,
      analyticsDepthDays: 730, liveRefreshSeconds: 5,
      aiInsights: true, aiAgent: true, ragEnabled: true,
      fleetDashboard: true, webhooks: true,
    },
    INACTIVE: {
      maxVehicles: 1, tripHistoryDays: 7, chargingHistoryDays: 7,
      analyticsDepthDays: 7, liveRefreshSeconds: 60,
      aiInsights: false, aiAgent: false, ragEnabled: false,
      fleetDashboard: false, webhooks: false,
    },
  },
};

const FREE_INACTIVE = PLAN_LIMITS.FREE.INACTIVE;

/** Unix timestamp (seconds) → JS Date */
function fromUnix(ts: number): Date {
  return new Date(ts * 1000);
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private stripe: Stripe | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    const key = this.config.get<string>('billing.stripeSecretKey');
    if (key && key !== 'dummy' && key.startsWith('sk_')) {
      // Use 'as any' for API version so the strict string literal check
      // doesn't fail when the installed Stripe SDK version differs.
      this.stripe = new Stripe(key, { apiVersion: '2023-10-16' as any });
    }
  }

  // ── Stripe webhook helpers ───────────────────────────────────────────────

  constructEvent(rawBody: Buffer, sig: string): Stripe.Event {
    return this.stripe!.webhooks.constructEvent(
      rawBody,
      sig,
      this.config.get<string>('billing.stripeWebhookSecret')!,
    );
  }

  async isEventProcessed(stripeEventId: string): Promise<boolean> {
    return !!(await this.prisma.subscriptionEvent.findUnique({ where: { stripeEventId } }));
  }

  async handleEvent(event: Stripe.Event): Promise<void> {
    await this.prisma.subscriptionEvent.create({
      data: { stripeEventId: event.id, type: event.type, rawPayload: event as any },
    });

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.syncSubscription(event.data.object as any);
        break;
      case 'invoice.paid':
        await this.handleInvoicePaid(event.data.object as any);
        break;
      case 'invoice.payment_failed':
        await this.handlePaymentFailed(event.data.object as any);
        break;
    }
  }

  private async syncSubscription(sub: any): Promise<void> {
    const stripeCustomerId = sub.customer as string;
    const rawStatus: string = sub.status;

    const user = await this.prisma.user.findFirst({ where: { stripeCustomerId } });
    if (!user) {
      this.logger.warn(`No user for Stripe customer ${stripeCustomerId}`);
      return;
    }

    const plan   = this.mapPriceToPlan(sub.items?.data?.[0]?.price?.id ?? '');
    const status: SubscriptionStatus =
      rawStatus === 'active' || rawStatus === 'past_due' ? 'ACTIVE' : 'INACTIVE';

    await this.prisma.subscription.upsert({
      where:  { userId: user.id },
      update: {
        plan, status,
        currentPeriodStart:   fromUnix(sub.current_period_start),
        currentPeriodEnd:     fromUnix(sub.current_period_end),
        cancelAtPeriodEnd:    sub.cancel_at_period_end ?? false,
        stripeCustomerId,
        stripeSubscriptionId: sub.id,
      },
      create: {
        userId: user.id, plan, status,
        currentPeriodStart:   fromUnix(sub.current_period_start),
        currentPeriodEnd:     fromUnix(sub.current_period_end),
        cancelAtPeriodEnd:    sub.cancel_at_period_end ?? false,
        stripeCustomerId,
        stripeSubscriptionId: sub.id,
      },
    });

    await this.updateEntitlements(user.id, plan, status);
  }

  private async handleInvoicePaid(invoice: any): Promise<void> {
    const stripeSubId = invoice.subscription as string;
    const dbSub = await this.prisma.subscription.findFirst({
      where: { stripeSubscriptionId: stripeSubId },
    });
    if (!dbSub) return;

    await this.prisma.subscription.update({ where: { id: dbSub.id }, data: { status: 'ACTIVE' } });
    await this.updateEntitlements(dbSub.userId, dbSub.plan, 'ACTIVE');
  }

  private async handlePaymentFailed(invoice: any): Promise<void> {
    const stripeSubId = invoice.subscription as string;
    const dbSub = await this.prisma.subscription.findFirst({
      where: { stripeSubscriptionId: stripeSubId },
    });
    if (!dbSub) return;
    // Grace period: keep ACTIVE, show banner. Stripe retries automatically.
    this.logger.warn(`Payment failed for sub ${stripeSubId} — grace period active`);
  }

  // ── Entitlements ─────────────────────────────────────────────────────────

  private async updateEntitlements(userId: string, plan: Plan, status: SubscriptionStatus) {
    const limits = PLAN_LIMITS[plan][status];
    await this.prisma.userEntitlements.upsert({
      where:  { userId },
      update: { plan, status, ...limits, updatedAt: new Date() },
      create: { userId, plan, status, ...limits },
    });
    // Invalidate cache so next request reflects the new plan immediately
    await this.redis.del(`ent:${userId}`);
  }

  isStripeConfigured(): boolean {
    return this.stripe !== null;
  }

  /** Lightweight entitlements fetch with 60s Redis cache — no Stripe call. */
  async getEntitlements(userId: string): Promise<{ aiInsights: boolean; aiAgent: boolean; ragEnabled: boolean }> {
    const cacheKey = `ent:${userId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const ent = await this.prisma.userEntitlements.findUnique({
      where: { userId },
      select: { aiInsights: true, aiAgent: true, ragEnabled: true },
    });
    const result = {
      aiInsights: ent?.aiInsights ?? FREE_INACTIVE.aiInsights,
      aiAgent:    ent?.aiAgent    ?? false,
      ragEnabled: ent?.ragEnabled ?? false,
    };
    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', ENTITLEMENTS_CACHE_TTL);
    return result;
  }

  async getCurrent(userId: string) {
    const ent = await this.prisma.userEntitlements.findUnique({ where: { userId } });
    const sub = await this.prisma.subscription.findUnique({ where: { userId } });

    const pastDue = sub?.stripeSubscriptionId
      ? await this.isStripePastDue(sub.stripeSubscriptionId)
      : false;

    if (!ent) {
      return { plan: 'FREE', status: 'INACTIVE', pastDue, billingAvailable: this.isStripeConfigured(), ...FREE_INACTIVE };
    }

    return { ...ent, pastDue, billingAvailable: this.isStripeConfigured() };
  }

  private async isStripePastDue(stripeSubId: string): Promise<boolean> {
    if (!this.stripe) return false;
    try {
      const sub = await this.stripe.subscriptions.retrieve(stripeSubId);
      return (sub as any).status === 'past_due';
    } catch {
      return false;
    }
  }

  // ── Checkout / Portal ────────────────────────────────────────────────────

  async createCheckoutSession(userId: string, plan: 'PRO' | 'FLEET'): Promise<{ url: string }> {
    if (!this.stripe) throw new Error('Stripe not configured');

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await this.stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await this.prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    }

    const priceId = plan === 'PRO'
      ? this.config.get<string>('billing.pricePro')!
      : this.config.get<string>('billing.priceFleet')!;

    const frontendUrl = this.config.get<string>('billing.frontendUrl');
    const session = await this.stripe.checkout.sessions.create({
      mode:                'subscription',
      customer:            customerId,
      line_items:          [{ price: priceId, quantity: 1 }],
      success_url:         `${frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:          `${frontendUrl}/billing/cancel`,
      client_reference_id: userId,
    });

    return { url: session.url! };
  }

  async createPortalSession(userId: string): Promise<{ url: string }> {
    if (!this.stripe) throw new Error('Stripe not configured');

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.stripeCustomerId) throw new Error('No Stripe customer found');

    const session = await this.stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${this.config.get<string>('billing.frontendUrl')}/settings`,
    });

    return { url: session.url };
  }

  private mapPriceToPlan(priceId: string): Plan {
    if (priceId === this.config.get<string>('billing.pricePro'))   return 'PRO';
    if (priceId === this.config.get<string>('billing.priceFleet')) return 'FLEET';
    return 'FREE';
  }
}
