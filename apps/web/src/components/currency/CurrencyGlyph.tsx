'use client'

import clsx from 'clsx'
import { useCurrency } from '@/hooks/useCurrency'

type Size = 'md' | 'sm' | 'badge'

/**
 * Shows the same currency symbol as formatMoney() (€, $, £, CHF, …).
 * Use instead of lucide DollarSign/Euro so icons never disagree with amounts.
 */
export function CurrencyGlyph({ size = 'md', className }: { size?: Size; className?: string }) {
  const { symbol } = useCurrency()
  const text = symbol.replace(/\u00a0/g, '').trim()
  const short = text.length <= 2

  return (
    <span
      className={clsx(
        'inline-flex items-center justify-center shrink-0 font-bold tabular-nums',
        size === 'badge'
          ? short
            ? 'text-base leading-none'
            : 'text-[9px] leading-tight uppercase tracking-tight px-0.5'
          : size === 'md'
            ? short
              ? 'w-[18px] h-[18px] text-lg leading-none'
              : 'min-h-[18px] min-w-[18px] px-0.5 text-[9px] leading-tight text-center uppercase tracking-tight'
            : short
              ? 'w-[13px] h-[13px] text-[12px] leading-none'
              : 'min-h-[13px] min-w-[13px] px-0.5 text-[7px] leading-tight text-center uppercase tracking-tight',
        className,
      )}
      aria-hidden
    >
      {text}
    </span>
  )
}
