'use client'

import clsx from 'clsx'

type Props = {
  size?: number
  className?: string
}

export function RoviqenMark({ size = 32, className }: Props) {
  const large = size > 24
  const strokeW = large ? 6.5 : 8
  const strokeColor = large ? 'url(#rq-grad)' : '#2DD4BF'

  return (
    <svg
      width={size}
      height={size}
      viewBox="13 7 42 52"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={clsx('shrink-0', className)}
      aria-hidden="true"
    >
      {large && (
        <defs>
          <linearGradient id="rq-grad" x1="14" y1="10" x2="52" y2="56" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#2DD4BF" />
            <stop offset="1" stopColor="#B6F03C" />
          </linearGradient>
        </defs>
      )}
      <g fill="none" stroke={strokeColor} strokeWidth={strokeW} strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 52V12h17a12.5 12.5 0 0 1 0 25H18" />
        <path d="M30 37l5 6.5 4-5 5 7.5" />
      </g>
      <circle cx="49" cy="53.5" r="3.6" fill="#B6F03C" stroke="none" />
    </svg>
  )
}
