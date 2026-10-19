'use client'

import Link from 'next/link'
import clsx from 'clsx'
import { RoviqenMark } from './RoviqenMark'

type Props = {
  markSize?: number
  className?: string
  withLink?: boolean
  onNavigate?: () => void
  size?: 'default' | 'large'
}

export function RoviqenLogo({
  markSize,
  className,
  withLink = true,
  onNavigate,
  size = 'default',
}: Props) {
  const m = markSize ?? (size === 'large' ? 48 : 36)
  const fontSize = Math.round(m * 0.38)

  const inner = (
    <span className={clsx('inline-flex items-center gap-2.5', className)}>
      <RoviqenMark size={m} />
      <span
        className="font-bold tracking-[0.08em] leading-none uppercase"
        style={{ fontSize }}
      >
        <span style={{ color: 'var(--cloud-white, #F0F4ED)' }}>ROVIQEN</span>
      </span>
    </span>
  )

  if (!withLink) {
    return <span className="inline-flex shrink-0">{inner}</span>
  }

  return (
    <Link
      href="/dashboard"
      onClick={onNavigate}
      className="inline-flex items-center shrink-0 focus:outline-none focus-visible:ring-2 rounded-lg"
      style={{ '--tw-ring-color': 'color-mix(in oklch, var(--volt-lime) 50%, transparent)' } as React.CSSProperties}
    >
      {inner}
    </Link>
  )
}
