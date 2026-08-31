import { SetMetadata } from '@nestjs/common';

export const AI_ENTITLEMENT_KEY = 'ai_entitlement';

/**
 * Declares which entitlement flag is required for an AI endpoint.
 * Used together with AiEntitlementGuard.
 *
 * @example
 *   @RequireEntitlement('aiInsights') — blocks if user plan lacks aiInsights
 *   @RequireEntitlement('aiAgent')    — blocks if user plan lacks aiAgent
 */
export const RequireEntitlement = (key: 'aiInsights' | 'aiAgent') =>
  SetMetadata(AI_ENTITLEMENT_KEY, key);
