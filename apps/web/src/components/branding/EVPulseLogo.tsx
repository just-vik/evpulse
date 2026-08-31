'use client'

import Link from 'next/link'
import clsx from 'clsx'
import { EVPulseMark } from './EVPulseMark'

type Props = {
  markSize?: number
  className?: string
  withLink?: boolean
  onNavigate?: () => void
  size?: 'default' | 'large'
}

export function EVPulseLogo({
  markSize,
  className,
  withLink = true,
  onNavigate,
  size = 'default',
}: Props) {
  const m = markSize ?? (size === 'large' ? 48 : 36)
  // Text scales proportionally with icon
  const fontSize = Math.round(m * 0.45)

  const inner = (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      <EVPulseMark
        size={m}
        className="drop-shadow-[0_0_14px_rgba(168,85,247,0.5)]"
      />
      <span
        className="font-bold tracking-tight leading-none"
        style={{ fontSize }}
      >
        <span className="text-white/95">EV</span>
        <span className="bg-gradient-to-r from-violet-400 via-purple-400 to-fuchsia-400 bg-clip-text text-transparent">
          Pulse
        </span>
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
      className="inline-flex items-center shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 rounded-lg"
    >
      {inner}
    </Link>
  )
}
