/**
 * Classifies Tesla Fleet API errors so callers can tell "car is asleep" (normal,
 * no action needed) apart from "we are locked out" (billing limit / revoked auth —
 * needs an alert, and must NOT be treated as vehicle sleep by the state machine).
 *
 * Real-world incident (2026-08-27): the Tesla Developer billing limit was hit and
 * every Fleet API call — including account-level GET /vehicles — started returning
 * 403. The app swallowed this as "vehicle may be sleeping" and stayed silent for
 * 4 days because checkTelemetryFreshness() only alerts for vehicles NOT in the
 * sleeping state. This classifier exists to prevent that from recurring silently.
 */
export type TeslaApiErrorKind =
  | 'billing_limit'   // 403, account-wide — Tesla Developer Portal payment limit hit
  | 'unauthorized'    // 401, or 403 with an explicit scope/consent error in the body
  | 'vehicle_sleeping' // 408 / vehicle_unavailable — normal, no action needed
  | 'rate_limited'    // 429
  | 'unknown';

export interface ClassifiedTeslaError {
  kind: TeslaApiErrorKind;
  status?: number;
  detail?: string;
}

export function classifyTeslaApiError(error: any): ClassifiedTeslaError {
  const status: number | undefined = error?.response?.status ?? error?.status;
  const body = error?.response?.data;
  const bodyText =
    typeof body === 'string' ? body : body ? JSON.stringify(body).toLowerCase() : '';

  if (status === 401) {
    return { kind: 'unauthorized', status, detail: bodyText || undefined };
  }

  if (status === 403) {
    // Tesla returns an explicit scope/consent error string for revoked-app or
    // missing-scope cases. Anything else at 403 — including account-level
    // GET /vehicles, which never needed a vehicle-specific scope — is the
    // billing-limit lockout, not a permissions problem.
    if (bodyText.includes('scope') || bodyText.includes('consent') || bodyText.includes('unauthorized_client')) {
      return { kind: 'unauthorized', status, detail: bodyText };
    }
    return { kind: 'billing_limit', status, detail: bodyText || undefined };
  }

  if (status === 429) {
    return { kind: 'rate_limited', status };
  }

  if (
    status === 408 ||
    bodyText.includes('vehicle_unavailable') ||
    bodyText.includes('asleep') ||
    bodyText.includes('offline')
  ) {
    return { kind: 'vehicle_sleeping', status };
  }

  return { kind: 'unknown', status, detail: bodyText || undefined };
}

/** Minimal, dependency-free Telegram sender shared by ops-alert call sites. */
export async function sendTelegramOpsAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OPS_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch {
    // best-effort — never let alerting break the calling request
  }
}
