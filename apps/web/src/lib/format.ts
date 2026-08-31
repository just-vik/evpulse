// Currency symbol fallback map for environments where Intl may not extract symbols cleanly
const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  CHF: 'CHF\u00a0',
  RUB: '₽',
  JPY: '¥',
  CNY: '¥',
  CAD: 'CA$',
  AUD: 'A$',
  PLN: 'zł',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
}

/** Normalise persisted / user input (e.g. "usd" → "USD") for Intl + rate tables */
export function normalizeCurrencyCode(code: string | undefined | null, fallback = 'EUR'): string {
  if (code == null || typeof code !== 'string') return fallback
  const t = code.trim().toUpperCase()
  return t.length > 0 ? t : fallback
}

/**
 * Returns the display symbol for a currency code, e.g. 'EUR' → '€'
 */
export function getCurrencySymbol(currency = 'EUR'): string {
  const code = normalizeCurrencyCode(currency, 'EUR')
  return CURRENCY_SYMBOLS[code] ?? code
}

/**
 * Symbol that matches Intl currency formatting (same family as formatCurrency / formatMoney).
 */
export function getCurrencyDisplaySymbol(currency: string): string {
  const code = normalizeCurrencyCode(currency, 'EUR')
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0)
    const sym = parts.find((p) => p.type === 'currency')?.value
    if (sym && sym.trim()) return sym.trim()
  } catch {
    /* invalid code */
  }
  return getCurrencySymbol(code)
}

/**
 * Format a monetary value using the given ISO 4217 currency code.
 * Uses Intl.NumberFormat when available, falls back to manual symbol prefix.
 * e.g. formatCurrency(12.5, 'USD') → "$12.50"
 */
export function formatCurrency(value: number, currency = 'EUR', decimals = 2): string {
  const code = normalizeCurrencyCode(currency, 'EUR')
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value)
  } catch {
    return `${getCurrencySymbol(code)}${value.toFixed(decimals)}`
  }
}

/**
 * Format an energy rate, e.g. formatRate(0.35, 'USD') → "$0.35/kWh"
 */
export function formatRate(value: number, currency = 'EUR'): string {
  return `${formatCurrency(value, currency, 2)}/kWh`
}

/**
 * Format cost-per-km with 3 decimal places.
 * e.g. formatCostPerKm(0.056, 'EUR') → "€0.056/km"
 */
export function formatCostPerKm(value: number, currency = 'EUR'): string {
  return `${formatCurrency(value, currency, 3)}/km`
}
