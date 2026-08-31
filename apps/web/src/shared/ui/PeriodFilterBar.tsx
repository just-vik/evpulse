'use client'

import React, { useState } from 'react'
import { CalendarRange, ChevronLeft, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import { ru, de } from 'date-fns/locale'
import type { Locale } from 'date-fns'

export type QuickPeriod = 7 | 30 | 90
export interface DateRange { from: Date; to: Date }
export type PeriodValue = QuickPeriod | DateRange | null

interface PeriodFilterBarProps {
  value: PeriodValue
  onChange: (value: PeriodValue) => void
  defaultPeriod?: QuickPeriod
}

const QUICK_PERIODS: QuickPeriod[] = [7, 30, 90]

const LOCALE_MAP: Record<string, Locale> = { ru, de }

/** Convert PeriodValue → API-ready { from, to } string pair (local midnight boundaries) */
export function periodToApiRange(period: PeriodValue): { from?: string; to?: string } | undefined {
  if (period == null) return undefined
  if (typeof period === 'number') {
    const to = new Date()
    to.setHours(23, 59, 59, 999)
    const from = new Date()
    from.setDate(from.getDate() - period)
    from.setHours(0, 0, 0, 0)
    return { from: from.toISOString(), to: to.toISOString() }
  }
  return { from: period.from.toISOString(), to: period.to.toISOString() }
}

export function PeriodFilterBar({ value, onChange, defaultPeriod = 30 }: PeriodFilterBarProps) {
  const { t, i18n } = useTranslation()
  const [customMode, setCustomMode] = useState(false)
  const [draftFrom, setDraftFrom] = useState('')
  const [draftTo, setDraftTo]     = useState('')
  const dateLocale = LOCALE_MAP[i18n.language]

  const isCustom   = value != null && typeof value === 'object'
  const activePreset: QuickPeriod | 'custom' | null =
    value == null
      ? defaultPeriod
      : typeof value === 'number' ? value : isCustom ? 'custom' : null

  const customLabel = isCustom
    ? `${format(value.from, 'd MMM', { locale: dateLocale })} – ${format(value.to, 'd MMM', { locale: dateLocale })}`
    : t('filter.customPeriod')

  const openCustom = () => {
    if (isCustom) {
      setDraftFrom(value.from.toISOString().slice(0, 10))
      setDraftTo(value.to.toISOString().slice(0, 10))
    } else {
      setDraftFrom('')
      setDraftTo('')
    }
    setCustomMode(true)
  }

  const applyCustom = () => {
    if (!draftFrom || !draftTo) return
    onChange({ from: new Date(`${draftFrom}T00:00:00`), to: new Date(`${draftTo}T23:59:59.999`) })
    setCustomMode(false)
  }

  const reset = () => {
    setCustomMode(false)
    setDraftFrom('')
    setDraftTo('')
    onChange(defaultPeriod)
  }

  const canApply = !!(draftFrom && draftTo)

  return (
    <div className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] px-3 py-2.5 shadow-lg overflow-hidden">
      <div className="relative" style={{ minHeight: '2rem' }}>

        {/* ── Preset chips view ──────────────────────────────── */}
        <div
          className={`flex items-center gap-2 flex-wrap transition-all duration-200 ${
            customMode ? 'opacity-0 pointer-events-none absolute inset-0' : 'opacity-100'
          }`}
        >
          <CalendarRange size={14} className="text-muted-foreground shrink-0" />

          {QUICK_PERIODS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => { setCustomMode(false); onChange(n); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activePreset === n
                  ? 'bg-sky-500/20 border border-sky-500/40 text-sky-300'
                  : 'border border-[hsl(var(--border)/0.6)] bg-[hsl(var(--secondary)/0.25)] text-muted-foreground hover:border-sky-500/30 hover:text-foreground'
              }`}
            >
              {t('filter.daysLabel', { count: n })}
            </button>
          ))}

          <button
            type="button"
            onClick={openCustom}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activePreset === 'custom'
                ? 'bg-sky-500/20 border border-sky-500/40 text-sky-300'
                : 'border border-[hsl(var(--border)/0.6)] bg-[hsl(var(--secondary)/0.25)] text-muted-foreground hover:border-sky-500/30 hover:text-foreground'
            }`}
          >
            {customLabel}
          </button>

          {value != null && !(typeof value === 'number' && value === defaultPeriod) && (
            <button
              onClick={reset}
              className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <X size={11} />
              {t('filter.reset')}
            </button>
          )}
        </div>

        {/* ── Custom date inputs view ─────────────────────────── */}
        <div
          className={`flex items-center gap-2 flex-wrap transition-all duration-200 ${
            customMode ? 'opacity-100' : 'opacity-0 pointer-events-none absolute inset-0'
          }`}
        >
          <button
            type="button"
            onClick={() => setCustomMode(false)}
            className="flex items-center justify-center w-7 h-7 rounded-lg border border-[hsl(var(--border)/0.6)]
                       text-muted-foreground hover:text-foreground hover:border-[hsl(var(--border))] transition-colors shrink-0"
          >
            <ChevronLeft size={13} />
          </button>

          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
            {t('filter.from')}
            <input
              type="date"
              value={draftFrom}
              max={draftTo || undefined}
              onChange={(e) => setDraftFrom(e.target.value)}
              className="rounded-lg border border-[hsl(var(--border)/0.7)] bg-[hsl(var(--secondary)/0.4)] px-2 py-1.5
                         text-xs text-foreground focus:outline-none focus:border-sky-500/50 [color-scheme:dark]"
            />
          </label>

          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
            {t('filter.to')}
            <input
              type="date"
              value={draftTo}
              min={draftFrom || undefined}
              onChange={(e) => setDraftTo(e.target.value)}
              className="rounded-lg border border-[hsl(var(--border)/0.7)] bg-[hsl(var(--secondary)/0.4)] px-2 py-1.5
                         text-xs text-foreground focus:outline-none focus:border-sky-500/50 [color-scheme:dark]"
            />
          </label>

          <button
            type="button"
            onClick={applyCustom}
            disabled={!canApply}
            className={`ml-auto px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors shrink-0 ${
              canApply
                ? 'bg-sky-600 text-white hover:bg-sky-500'
                : 'bg-[hsl(var(--secondary)/0.25)] text-muted-foreground/40 cursor-not-allowed'
            }`}
          >
            {t('filter.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
