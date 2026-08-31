'use client'

import clsx from 'clsx'

type Props = {
  size?: number
  className?: string
  variant?: 'default' | 'soft'
}

export function EVPulseMark({ size = 32, className }: Props) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/branding/icon.png"
      alt="EVPulse"
      width={size}
      height={size}
      className={clsx('shrink-0 object-contain', className)}
    />
  )
}
