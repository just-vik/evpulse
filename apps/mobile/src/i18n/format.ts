import i18n from './index';

/** Relative "Xm ago" style label, localized via Intl-backed i18next plurals. */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 10) return i18n.t('common.justNow');
  if (diffSec < 60) return i18n.t('common.secondsAgo', { count: diffSec });
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return i18n.t('common.minutesAgo', { count: diffMin });
  const diffHour = Math.floor(diffMin / 60);
  return i18n.t('common.hoursAgo', { count: diffHour });
}

/** "Today, 14:32" / "Yesterday, 09:10" / "Aug 28, 09:10", locale-aware. */
export function formatDateLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const timeStr = new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(d);
  if (isToday) return `${i18n.t('common.today')}, ${timeStr}`;
  if (isYesterday) return `${i18n.t('common.yesterday')}, ${timeStr}`;
  const dateStr = new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }).format(d);
  return `${dateStr}, ${timeStr}`;
}

/** "Aug 28, 09:10", locale-aware, no relative day labels. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function formatNumber(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(i18n.language, { maximumFractionDigits }).format(value);
}

/** Uses the session's actual currency (e.g. from `session.currency`) — never a hardcoded symbol. */
export function formatCurrency(value: number, currency: string | null | undefined): string {
  const cur = currency && currency.trim() ? currency : 'EUR';
  try {
    return new Intl.NumberFormat(i18n.language, { style: 'currency', currency: cur }).format(value);
  } catch {
    return `${formatNumber(value, 2)} ${cur}`;
  }
}
