// P1.6a — pure, dependency-free command-safety policy, extracted out of
// useVehicleCommands.ts so it can be tested without a DOM/React harness (no
// test runner exists for apps/web yet). No React Query / toast / API calls
// here — only decisions.

/** How long to wait before re-checking EVPulse's own (DB/Redis-only, never
 *  Tesla-calling) vehicle-status endpoint after a command was *sent*. */
export function reconciliationDelayMs(command: string): number {
  if (command === 'wake') return 8_000;
  if (command === 'climate' || command === 'start-charging' || command === 'stop-charging') return 4_000;
  return 3_000; // lock, unlock, honk
}

export type CommandErrorCategory =
  | 'rateLimit'
  | 'unavailable'
  | 'circuitOpen'
  | 'unconfirmed'
  | 'networkError'
  | 'duplicate'
  | 'failed';

export interface CommandErrorClassification {
  category: CommandErrorCategory;
  messageKey: string;
  /** Whether a delayed local status refresh should run after this error
   *  (only when the command's actual outcome is genuinely unknown). */
  refresh: 'none' | 'immediate' | 'delayed';
}

/** Maps a failed command's error into a user message + reconciliation
 *  action. Pure function of (status, message) — no side effects. */
export function classifyCommandError(err: { status?: number; message?: string }): CommandErrorClassification {
  const status = Number(err?.status ?? 0);
  const msg = String(err?.message ?? '').toLowerCase();

  if (status === 429) {
    return { category: 'rateLimit', messageKey: 'vehicleDetail.commands.rateLimit', refresh: 'none' };
  }
  if (status === 409) {
    // Same idempotency key already in flight (e.g. a second tab, or a
    // resend racing the original request) — something is genuinely
    // pending, so a status refresh is worth it, but nothing new was sent.
    return { category: 'duplicate', messageKey: 'vehicleDetail.commands.duplicate', refresh: 'immediate' };
  }
  if (status === 503 || msg.includes('asleep') || msg.includes('sleep') || msg.includes('unavailable') || msg.includes('offline')) {
    return { category: 'unavailable', messageKey: 'vehicleDetail.commands.asleep', refresh: 'none' };
  }
  if (msg.includes('circuit open')) {
    return { category: 'circuitOpen', messageKey: 'vehicleDetail.commands.circuitOpen', refresh: 'none' };
  }
  if (status === 504 || msg.includes('timeout') || msg.includes('timed out')) {
    return { category: 'unconfirmed', messageKey: 'vehicleDetail.commands.unconfirmed', refresh: 'delayed' };
  }
  if (status === 0) {
    return { category: 'networkError', messageKey: 'vehicleDetail.commands.networkError', refresh: 'delayed' };
  }
  return { category: 'failed', messageKey: 'vehicleDetail.commands.failed', refresh: 'immediate' };
}

// Risk-based confirmation policy (mirrors QuickActions.tsx's CONFIRM_POLICY
// — duplicated intentionally as the source of truth for this pure module;
// QuickActions.tsx's copy stays UI-local since it also drives per-action
// dialog copy lookups that don't belong in a policy-only module).
export type ConfirmPolicy = 'always' | 'stale' | 'none';

export const COMMAND_CONFIRM_POLICY: Record<string, ConfirmPolicy> = {
  wake: 'always',
  unlock: 'always',
  honk: 'always',
  'stop-charge': 'always',
  climate: 'stale',
  'start-charge': 'stale',
  lock: 'none',
};

export function needsConfirmation(actionId: string, isStaleOrOffline: boolean): boolean {
  const policy = COMMAND_CONFIRM_POLICY[actionId] ?? 'none';
  return policy === 'always' || (policy === 'stale' && isStaleOrOffline);
}

// P1.6b — idempotency key lifecycle. A key must be *reused* across a manual
// retry only when the previous attempt's outcome to Tesla is genuinely
// unknown (timed out, or the request may never have left the browser) —
// that's the case the server-side dedup exists to protect. Every other
// outcome (rate-limited, vehicle asleep, rejected, or a confirmed success)
// means the previous key is fully resolved one way or another, so the next
// send is a new logical attempt and should get its own key.
export function shouldReuseIdempotencyKey(category: CommandErrorCategory): boolean {
  return category === 'unconfirmed' || category === 'networkError';
}
