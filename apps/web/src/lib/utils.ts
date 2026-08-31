/**
 * Get relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(dateStr: string | Date, locale?: string): string {
  const date = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  const lang = locale ?? 'en';

  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });

  if (seconds < 60) return rtf.format(-seconds, 'second');
  if (seconds < 3600) return rtf.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return rtf.format(-Math.floor(seconds / 3600), 'hour');
  if (seconds < 604800) return rtf.format(-Math.floor(seconds / 86400), 'day');

  return new Intl.DateTimeFormat(lang, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/**
 * Generate optimal color based on battery level
 */
export function getBatteryColor(percentage: number): string {
  if (percentage >= 80) return '#10b981'; // green
  if (percentage >= 50) return '#f59e0b'; // amber
  if (percentage >= 20) return '#f97316'; // orange
  return '#ef4444'; // red
}

/**
 * Round to nearest decimal place
 */
export function round(value: number, decimals: number = 0): number {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}
