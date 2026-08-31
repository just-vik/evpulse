import type { SVGProps } from 'react'

type Props = SVGProps<SVGSVGElement> & {
  /** Match lucide-react icon sizing */
  size?: number
}

/**
 * Neutral “money” glyph for metric cards (same paths as Lucide Banknote).
 * Inline SVG avoids any chance of a wrong icon ending up in the bundle.
 */
export function MetricBanknoteIcon({ size = 24, className, ...rest }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      {...rest}
    >
      <rect width="20" height="12" x="2" y="6" rx="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 12h.01M18 12h.01" />
    </svg>
  )
}
