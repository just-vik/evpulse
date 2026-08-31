/**
 * Lightweight live exchange rates hook.
 *
 * Strategy:
 *  1. On mount — try to read from localStorage cache (< 6h old).
 *  2. If stale or missing — fetch from free public API (no key required).
 *  3. On network error — fall back to hardcoded approximate rates.
 *  4. Exposes { rates, isLoading, isStale, updatedAt } so the UI can
 *     show "Rates updated X hours ago" or "Using offline rates".
 *
 * All costs in the app are computed from the user's own energyRate,
 * so we only need rates to SUGGEST a new energyRate when the user
 * changes their display currency.
 *
 * API: https://open.er-api.com/v6/latest/EUR  (free, no key, 1500 req/month)
 */

import { useState, useEffect } from 'react'

// Fallback rates relative to EUR (refreshed 2026-04-03)
const FALLBACK_RATES: Record<string, number> = {
  EUR: 1,
  USD: 1.1517,
  GBP: 0.8729,
  CHF: 0.9219,
  RUB: 92.36,
  JPY: 183.92,
  CNY: 7.9346,
  CAD: 1.6054,
  AUD: 1.6722,
  PLN: 4.2774,
  SEK: 10.9127,
  NOK: 11.2565,
  DKK: 7.4605,
}

const CACHE_KEY    = 'evp_exchange_rates_v1'
const CACHE_MAX_MS = 6 * 60 * 60 * 1000   // 6 hours
const API_URL      = 'https://open.er-api.com/v6/latest/EUR'

export interface ExchangeRatesState {
  /** Rates relative to EUR base. rates['USD'] = how many USD per 1 EUR */
  rates:      Record<string, number>
  isLoading:  boolean
  /** true when using hardcoded fallback or cache older than 6h */
  isStale:    boolean
  /** ISO string of the last successful API fetch, or null */
  updatedAt:  string | null
}

interface CachePayload {
  rates:      Record<string, number>
  fetchedAt:  string   // ISO
}

function readCache(): CachePayload | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const payload: CachePayload = JSON.parse(raw)
    if (!payload?.fetchedAt || !payload?.rates) return null
    return payload
  } catch {
    return null
  }
}

function writeCache(rates: Record<string, number>) {
  try {
    const payload: CachePayload = { rates, fetchedAt: new Date().toISOString() }
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload))
  } catch { /* storage full – ignore */ }
}

function isCacheFresh(payload: CachePayload): boolean {
  return Date.now() - new Date(payload.fetchedAt).getTime() < CACHE_MAX_MS
}

export function useExchangeRates(): ExchangeRatesState {
  const [state, setState] = useState<ExchangeRatesState>(() => {
    // SSR guard
    if (typeof window === 'undefined') {
      return { rates: FALLBACK_RATES, isLoading: false, isStale: true, updatedAt: null }
    }
    const cached = readCache()
    if (cached && isCacheFresh(cached)) {
      return { rates: cached.rates, isLoading: false, isStale: false, updatedAt: cached.fetchedAt }
    }
    // Stale cache: use it as starting value while we re-fetch
    return {
      rates:     cached?.rates ?? FALLBACK_RATES,
      isLoading: true,
      isStale:   true,
      updatedAt: cached?.fetchedAt ?? null,
    }
  })

  useEffect(() => {
    if (!state.isLoading) return   // fresh cache — nothing to fetch

    const controller = new AbortController()

    async function fetchRates() {
      try {
        const res = await fetch(API_URL, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (json.result !== 'success' || !json.rates) throw new Error('bad payload')

        const rates: Record<string, number> = json.rates
        writeCache(rates)
        setState({ rates, isLoading: false, isStale: false, updatedAt: new Date().toISOString() })
      } catch (err: any) {
        if (err?.name === 'AbortError') return
        // Network failure — keep using whatever we had (fallback or stale cache)
        setState(prev => ({ ...prev, isLoading: false, isStale: true }))
      }
    }

    fetchRates()
    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return state
}

/**
 * Convert `amount` from one currency to another using the provided rates (EUR base).
 * Returns null if either currency is missing from rates.
 */
export function convertCurrency(
  amount:    number,
  from:      string,
  to:        string,
  rates:     Record<string, number>,
): number | null {
  if (from === to) return amount
  const fromRate = from === 'EUR' ? 1 : rates[from]
  const toRate   = to   === 'EUR' ? 1 : rates[to]
  if (!fromRate || !toRate) return null
  // amount / fromRate → EUR, then × toRate → target
  return (amount / fromRate) * toRate
}
