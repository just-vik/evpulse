/**
 * EVPulse custom SVG icon system.
 * Multi-layer opacity for depth, currentColor for theme-aware tinting.
 * All icons: 20×20 viewBox, size + className + style props.
 */

import React from 'react';

export interface IconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

// ── Navigation ──────────────────────────────────────────────────────────────

/** Dashboard — four-block grid (brand kit i-home) */
export function DashboardIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
      <rect x="3" y="3" width="8" height="10" rx="2" />
      <rect x="13" y="3" width="8" height="6" rx="2" />
      <rect x="13" y="11" width="8" height="10" rx="2" />
      <rect x="3" y="15" width="8" height="6" rx="2" />
    </svg>
  );
}

/** Vehicle — car profile with wheels (brand kit i-car) */
export function VehicleIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
      <path d="M5 17H3.5a1 1 0 0 1-1-1v-2.6a2 2 0 0 1 1.3-1.9l1.7-.6 2.2-3.1A3 3 0 0 1 10.2 6.5h4.4a3 3 0 0 1 2.4 1.2l2.5 3.3 1.3.4a2 2 0 0 1 1.4 1.9V16a1 1 0 0 1-1 1H19" />
      <circle cx="7" cy="17" r="2" />
      <circle cx="17" cy="17" r="2" />
      <path d="M9 17h6" />
    </svg>
  );
}

/** Trips — S-curve route with endpoint nodes (brand kit i-trips) */
export function TripIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" />
    </svg>
  );
}

/** Charging — plug body with inner lightning (brand kit i-charging) */
export function ChargingIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
      <path d="M9 2v4M15 2v4" />
      <path d="M6 6h12v4a6 6 0 0 1-12 0z" />
      <path d="M12 16v6" />
      <path d="M12.6 8.2 11 10.6h2l-1.6 2.4" />
    </svg>
  );
}

/** Battery — body with vertical cell bars (brand kit i-battery) */
export function BatteryIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
      <rect x="2" y="7" width="17" height="10" rx="2.5" />
      <path d="M22 10.5v3" />
      <path d="M5.5 10.5v3M9 10.5v3M12.5 10.5v3" />
    </svg>
  );
}

/** Analytics — bars with trend line */
export function AnalyticsIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} style={style}>
      <rect x="2"    y="13" width="3" height="5" rx="1" fill="currentColor" opacity="0.5" />
      <rect x="6.5"  y="9"  width="3" height="9" rx="1" fill="currentColor" opacity="0.75" />
      <rect x="11"   y="11" width="3" height="7" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="15.5" y="6"  width="3" height="12" rx="1" fill="currentColor" opacity="0.9" />
      <path d="M3.5 13 L8 9.5 L12.5 11 L17 6.5"
        stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
      <circle cx="3.5" cy="13" r="1.2" fill="currentColor" opacity="0.7" />
      <circle cx="17"  cy="6.5" r="1.2" fill="currentColor" opacity="0.9" />
    </svg>
  );
}

/** Settings — two-row sliders with knobs (brand kit i-settings) */
export function SettingsIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  );
}

/** Export — document with download arrow (brand kit i-export) */
export function ExportIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v6M9.5 14.5 12 17l2.5-2.5" />
    </svg>
  );
}

/** AI/Insights — neural network nodes */
export function AIIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} style={style}>
      <line x1="5"  y1="10" x2="10" y2="5"  stroke="currentColor" strokeWidth="1" opacity="0.35" />
      <line x1="5"  y1="10" x2="10" y2="15" stroke="currentColor" strokeWidth="1" opacity="0.35" />
      <line x1="10" y1="5"  x2="15" y2="8"  stroke="currentColor" strokeWidth="1" opacity="0.35" />
      <line x1="10" y1="15" x2="15" y2="12" stroke="currentColor" strokeWidth="1" opacity="0.35" />
      <line x1="15" y1="8"  x2="15" y2="12" stroke="currentColor" strokeWidth="1" opacity="0.25" />
      <line x1="10" y1="5"  x2="10" y2="15" stroke="currentColor" strokeWidth="1" opacity="0.2" />
      <circle cx="5"  cy="10" r="2.5" fill="currentColor" opacity="0.45" />
      <circle cx="5"  cy="10" r="1.2" fill="currentColor" opacity="0.9" />
      <circle cx="10" cy="5"  r="2"   fill="currentColor" opacity="0.55" />
      <circle cx="10" cy="15" r="2"   fill="currentColor" opacity="0.55" />
      <circle cx="15" cy="8"  r="1.8" fill="currentColor" opacity="0.7" />
      <circle cx="15" cy="12" r="1.8" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

// ── Brand ────────────────────────────────────────────────────────────────────

/** EVPulse brand mark — E bars with pulse dot */
export function BrandMark({ size = 28, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" className={className} style={style}>
      <defs>
        <linearGradient id="evp-grad"  x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="#3B82F6" />
          <stop offset="100%" stopColor="#22D3EE" />
        </linearGradient>
        <linearGradient id="evp-grad2" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="#3B82F6" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#22D3EE" stopOpacity="0.7" />
        </linearGradient>
        <filter id="evp-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="5" y="7"    width="16" height="3" rx="1.5" fill="url(#evp-grad)"  filter="url(#evp-glow)" />
      <rect x="5" y="12.5" width="11" height="3" rx="1.5" fill="url(#evp-grad2)" />
      <rect x="5" y="18"   width="14" height="3" rx="1.5" fill="url(#evp-grad)"  opacity="0.85" />
      <circle cx="23" cy="8.5" r="2" fill="#22D3EE" filter="url(#evp-glow)" />
    </svg>
  );
}

// ── Metric / Feature icons ───────────────────────────────────────────────────

/**
 * BoltIcon — standalone energy lightning bolt.
 * Distinct from ChargingIcon (no battery shell). Use for energy metrics.
 */
export function BoltIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} style={style}>
      {/* Outer glow shape */}
      <path d="M11.5 1.5 L4.5 11.5 L9 11.5 L8 18.5 L15.5 8 L11 8 Z"
        fill="currentColor" opacity="0.15" />
      {/* Main bolt */}
      <path d="M12 2.5 L5.5 12 L9.5 12 L8.5 17.5 L15 8.5 L11 8.5 Z"
        fill="currentColor" opacity="0.9" />
      {/* Inner highlight */}
      <path d="M11 5.5 L8 11.5 L10.5 11.5"
        stroke="currentColor" strokeWidth="0.5" strokeLinecap="round" strokeLinejoin="round"
        fill="none" opacity="0.35" />
    </svg>
  );
}

/**
 * LeafIcon — eco / efficiency symbol.
 * Use for efficiency KPIs and eco-mode indicators.
 */
export function LeafIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} style={style}>
      {/* Soft outer halo */}
      <path d="M6 16.5 C6 16.5 3 10 9.5 6 C14 3 18 2.5 18 2.5 C18 2.5 17 8.5 13 12 C9 15.5 6 16.5 6 16.5 Z"
        fill="currentColor" opacity="0.2" />
      {/* Leaf body */}
      <path d="M5.5 16 C5.5 16 4 9 10 6 C14.5 3.5 17 3 17 3 C17 3 16.5 8.5 13 11.5 C9.5 15 6 16 5.5 16 Z"
        fill="currentColor" opacity="0.82" />
      {/* Center vein */}
      <path d="M5.5 16 C7.5 13 10.5 10 14 7"
        stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" fill="none" opacity="0.38" />
      {/* Stem */}
      <path d="M5.5 16 L4 18.5"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.65" />
    </svg>
  );
}

/**
 * VampireIcon — ghost with EV lightning bolt.
 * EVPulse signature icon for vampire drain / parasitic power loss.
 */
export function VampireIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} style={style}>
      {/* Ghost outer glow */}
      <path d="M10 1.5 C6.5 1.5 3.5 4.5 3.5 8 L3.5 18 L6 16 L8.5 18 L10 16 L11.5 18 L14 16 L16.5 18 L16.5 8 C16.5 4.5 13.5 1.5 10 1.5 Z"
        fill="currentColor" opacity="0.18" />
      {/* Ghost body */}
      <path d="M10 2.5 C7.2 2.5 4.5 5 4.5 8.5 L4.5 17 L6.5 15.5 L8.5 17 L10 15.5 L11.5 17 L13.5 15.5 L15.5 17 L15.5 8.5 C15.5 5 12.8 2.5 10 2.5 Z"
        fill="currentColor" opacity="0.65" />
      {/* Eyes */}
      <circle cx="7.5"  cy="9"  r="1.25" fill="currentColor" opacity="0.95" />
      <circle cx="12.5" cy="9"  r="1.25" fill="currentColor" opacity="0.95" />
      {/* Mini lightning bolt — the "drain" */}
      <path d="M11 11 L9 13 L10.5 13 L9.5 15.5 L12 13 L10.5 13 Z"
        fill="currentColor" opacity="0.9" />
    </svg>
  );
}

/**
 * ClimateIcon — flowing wind waves.
 * Use for climate control / HVAC actions.
 */
export function ClimateIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} style={style}>
      {/* Top wave */}
      <path d="M2 6 C4 4.5 6.5 7.5 9.5 6.5 C11.5 5.5 13 4.5 15.5 5.5 C16.5 6 17.5 6.5 18 6"
        stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" fill="none" opacity="0.42" />
      {/* Middle wave — main */}
      <path d="M2 10.5 C3.5 8.5 6.5 12.5 9.5 11 C12 9.5 13.5 8.5 16.5 9.5 C17.5 10 18 10.5 18 10.5"
        stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" fill="none" opacity="0.9" />
      {/* Bottom wave */}
      <path d="M2 15 C4 13.5 7 16.5 10.5 15 C13 13.5 15 13 17.5 14.5"
        stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" fill="none" opacity="0.42" />
    </svg>
  );
}

/**
 * PowerOnIcon — power button with arc.
 * Use for wake vehicle / power-on actions.
 */
export function PowerOnIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} style={style}>
      {/* Outer ring glow */}
      <circle cx="10" cy="11" r="7" stroke="currentColor" strokeWidth="0.5" opacity="0.2" />
      {/* Arc — open at top where line exits */}
      <path d="M6.5 7.5 A5 5 0 1 0 13.5 7.5"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" opacity="0.72" />
      {/* Power line */}
      <line x1="10" y1="3" x2="10" y2="10.5"
        stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.96" />
      {/* Center dot */}
      <circle cx="10" cy="10.5" r="1.2" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

/**
 * SpeedIcon — semicircle speedometer with needle.
 * Use for speed / performance metrics.
 */
export function SpeedIcon({ size = 20, className, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} style={style}>
      {/* Track arc */}
      <path d="M3 14 A7 7 0 0 1 17 14"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.3" />
      {/* Active arc portion */}
      <path d="M3 14 A7 7 0 0 1 14 7"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" opacity="0.8" />
      {/* Tick marks */}
      <line x1="3"  y1="14" x2="4.3"  y2="12.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
      <line x1="10" y1="7"  x2="10"   y2="8.5"   stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
      <line x1="17" y1="14" x2="15.7" y2="12.5"  stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
      {/* Needle */}
      <line x1="10" y1="14" x2="14.5" y2="8"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.92" />
      {/* Hub */}
      <circle cx="10" cy="14" r="2" fill="currentColor" opacity="0.9" />
      <circle cx="10" cy="14" r="1" fill="currentColor" opacity="0.3" />
    </svg>
  );
}
