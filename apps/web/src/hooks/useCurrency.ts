import { useUIStore } from '@/stores/uiStore'
import {
  formatCurrency,
  formatRate,
  formatCostPerKm,
  getCurrencyDisplaySymbol,
  normalizeCurrencyCode,
} from '@/lib/format'
import { useExchangeRates } from './useExchangeRates'

/**
 * Hook that returns currency-aware formatting helpers.
 *
 * KEY FEATURE: when `currency` ≠ `baseCurrency`, values are automatically
 * converted using live exchange rates (cached 6 h, offline-safe).
 *
 *   baseCurrency = the currency in which DB costs were computed
 *   currency     = the currency the user wants to SEE
 *
 * Example:
 *   baseCurrency = 'EUR', energyRate = 0.30 → costs stored in EUR
 *   user switches display to 'USD', rate = 1.08
 *   formatMoney(12)  → "$12.96"  (12 × 1.08)
 *   formatRate(0.30) → "$0.32/kWh"
 */
export function useCurrency() {
  const currencyRaw  = useUIStore(s => s.preferences.currency)
  const baseRaw      = useUIStore(s => s.preferences.baseCurrency)
  const currency     = normalizeCurrencyCode(currencyRaw, 'EUR')
  const baseCurrency = normalizeCurrencyCode(baseRaw, 'EUR')
  const { rates }    = useExchangeRates()

  /** Conversion multiplier: 1 unit of baseCurrency expressed in currency */
  const conversionRate = (() => {
    if (currency === baseCurrency) return 1
    const baseRate    = baseCurrency === 'EUR' ? 1 : (rates[baseCurrency] ?? 1)
    const displayRate = currency     === 'EUR' ? 1 : (rates[currency]     ?? 1)
    return displayRate / baseRate
  })()

  /** Convert a stored cost value and format in the display currency */
  function formatMoney(value: number, decimals?: number): string {
    return formatCurrency(value * conversionRate, currency, decimals)
  }

  /** Convert and format an energy rate */
  function fmtRate(value: number): string {
    return formatRate(value * conversionRate, currency)
  }

  /** Convert and format cost per km */
  function fmtPerKm(value: number): string {
    return formatCostPerKm(value * conversionRate, currency)
  }

  return {
    currency,
    baseCurrency,
    conversionRate,
    symbol:     getCurrencyDisplaySymbol(currency),
    formatMoney,
    formatRate: fmtRate,
    formatPerKm: fmtPerKm,
  }
}
