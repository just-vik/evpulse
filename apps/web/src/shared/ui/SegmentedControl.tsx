'use client'

import React from 'react'
import clsx from 'clsx'

interface SegmentOption<T extends string> {
  value: T
  label: string
  icon?: React.ReactNode
}

interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  className?: string
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={clsx(
        'flex rounded-xl bg-[hsl(var(--secondary)/0.4)] border border-[hsl(var(--border)/0.5)] p-1 gap-1',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={clsx(
              'flex-1 flex items-center justify-center gap-1.5 rounded-lg transition-all',
              size === 'md' ? 'min-h-[44px] px-3 text-sm font-medium' : 'min-h-[36px] px-2 text-xs font-medium',
              active
                ? 'bg-[hsl(var(--background))] text-foreground shadow-sm border border-[hsl(var(--border)/0.6)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {opt.icon && (
              <span className="shrink-0">{opt.icon}</span>
            )}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
