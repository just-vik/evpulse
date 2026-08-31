import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BillingService } from '../billing/billing.service';
import { AI_ENTITLEMENT_KEY } from './ai-entitlement.decorator';

/**
 * AiEntitlementGuard — checks plan entitlements for AI endpoints.
 *
 * Used with @RequireEntitlement('aiInsights' | 'aiAgent') decorator.
 * Entitlements are fetched via BillingService.getEntitlements() which
 * caches results in Redis (60s TTL) to avoid per-request DB queries.
 *
 * ragEnabled is NOT a hard block — it's a conditional in the controller
 * (chat works without RAG, just with less context).
 */
@Injectable()
export class AiEntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billing: BillingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.get<string>(AI_ENTITLEMENT_KEY, context.getHandler());
    if (!required) return true;

    const request = context.switchToHttp().getRequest();
    const userId = request.user?.id;
    if (!userId) return false;

    const ent = await this.billing.getEntitlements(userId);
    if (!ent[required as keyof typeof ent]) {
      const planLabel = required === 'aiAgent' ? 'FLEET' : 'PRO or FLEET';
      throw new ForbiddenException(`${required} requires a ${planLabel} plan`);
    }
    return true;
  }
}
