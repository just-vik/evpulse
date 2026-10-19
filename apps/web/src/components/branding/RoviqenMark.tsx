'use client'

import clsx from 'clsx'

type Props = {
  size?: number
  className?: string
}

/**
 * ROVIQEN geometric mark — angular R shape with a diagonal energy leg,
 * rendered in Volt Lime. Works at 16 px–256 px with no raster assets.
 */
export function RoviqenMark({ size = 32, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={clsx('shrink-0', className)}
      aria-hidden="true"
    >
      {/* Left vertical bar */}
      <rect x="5" y="4" width="6.5" height="32" rx="1.5" fill="var(--volt-lime, #C2F54A)" />
      {/* Bowl top fill (trapezoid) */}
      <path d="M11.5 4 L28 4 Q33 4 33 10 Q33 18 26 18 L11.5 18 Z"
        fill="var(--volt-lime, #C2F54A)" />
      {/* Bowl inner cutout */}
      <path d="M13 7.5 L25 7.5 Q28.5 7.5 28.5 11 Q28.5 14.5 25 14.5 L13 14.5 Z"
        fill="var(--s-base, #0C0F11)" />
      {/* Diagonal leg */}
      <path d="M13.5 19.5 L32 36 L27 36 L13.5 24 Z"
        fill="var(--volt-lime, #C2F54A)" />
      {/* Signal Teal accent — small notch at bowl/leg junction */}
      <rect x="11.5" y="17" width="10" height="2.5" rx="1"
        fill="var(--signal-teal, #43D1AD)" opacity="0.8" />
    </svg>
  )
}
