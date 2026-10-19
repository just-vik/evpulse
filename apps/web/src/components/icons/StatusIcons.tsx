// Brand kit status & metric icons — exactly matching StatusIcons artboard (24×24, stroke 1.75)
import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function Icon({ size = 22, className, strokeWidth = 1.75, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

// ── Vehicle state (s-*) ──────────────────────────────────────────────────────

export function SleepIcon(p: IconProps) {
  return <Icon {...p}><path d="M17 15.5A7 7 0 0 1 8.5 7a7 7 0 1 0 8.5 8.5z"/><path d="M15 3h4l-4 4h4"/></Icon>;
}

export function OnlineIcon(p: IconProps) {
  return <Icon {...p}><circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></Icon>;
}

export function DrivingIcon(p: IconProps) {
  return <Icon {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M3.5 10.5h6.5M14 10.5h6.5M12 14v7"/></Icon>;
}

export function ChargingStatusIcon(p: IconProps) {
  return <Icon {...p}><rect x="2" y="7" width="17" height="10" rx="2.5"/><path d="M22 10.5v3"/><path d="M11.5 9 9 12.2h3.2L9.8 15.2"/></Icon>;
}

export function SoftwareUpdateIcon(p: IconProps) {
  return <Icon {...p}><path d="M12 3v12M7.5 10.5 12 15l4.5-4.5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></Icon>;
}

export function OfflineIcon(p: IconProps) {
  return <Icon {...p}><path d="M2 8.8a15 15 0 0 1 4.2-2.6M10.7 5.1A15 15 0 0 1 22 8.8M5 12.5a10 10 0 0 1 5.1-2.7M16.8 11.1A10 10 0 0 1 19 12.5M8.5 16a5 5 0 0 1 7 0"/><path d="M12 19.5h.01"/><path d="M3 3l18 18"/></Icon>;
}

export function PowerIcon(p: IconProps) {
  return <Icon {...p}><path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></Icon>;
}

export function StaleIcon(p: IconProps) {
  return <Icon {...p}><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></Icon>;
}

// ── Metric icons (m-*) ───────────────────────────────────────────────────────

export function DistanceIcon(p: IconProps) {
  return <Icon {...p}><path d="M3 12h18M6.5 8.5 3 12l3.5 3.5M17.5 8.5 21 12l-3.5 3.5"/></Icon>;
}

export function OdometerIcon(p: IconProps) {
  return <Icon {...p}><path d="M4.5 18a8.5 8.5 0 1 1 15 0"/><path d="m12 14 4-4"/><circle cx="12" cy="14" r="1.3"/></Icon>;
}

export function SpeedMetricIcon(p: IconProps) {
  return <Icon {...p}><path d="M13 5l7 7-7 7"/><path d="M4 8h6M3 12h9M4 16h6"/></Icon>;
}

export function BoltMetricIcon(p: IconProps) {
  return <Icon {...p}><path d="M13 3 5 14h6l-1 7 8-11h-6z"/></Icon>;
}

export function ChargedIcon(p: IconProps) {
  return <Icon {...p}><rect x="2" y="7" width="17" height="10" rx="2.5"/><path d="M22 10.5v3"/><path d="M10.5 9.5v5M8 12h5"/></Icon>;
}

export function PlugIcon(p: IconProps) {
  return <Icon {...p}><path d="M9 2v4M15 2v4"/><path d="M6 6h12v4a6 6 0 0 1-12 0z"/><path d="M12 16v6"/></Icon>;
}

export function LeafMetricIcon(p: IconProps) {
  return <Icon {...p}><path d="M5 19c0-9 5-14 15-15-1 10-6 15-15 15z"/><path d="M5 19l7-7"/></Icon>;
}

export function EuroIcon(p: IconProps) {
  return <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M15.5 8.6a4.5 4.5 0 1 0 0 6.8"/><path d="M8 10.8h5M8 13.4h5"/></Icon>;
}

export function SohIcon(p: IconProps) {
  return <Icon {...p}><rect x="2" y="7" width="17" height="10" rx="2.5"/><path d="M22 10.5v3"/><path d="M5 12h2.5L9 9.5l2 5 1.5-2.5H16"/></Icon>;
}

export function DrainIcon(p: IconProps) {
  return <Icon {...p}><rect x="2" y="7" width="17" height="10" rx="2.5"/><path d="M22 10.5v3"/><path d="M10.5 9.5v5M8.5 12.5l2 2 2-2"/></Icon>;
}

export function TrendIcon(p: IconProps) {
  return <Icon {...p}><path d="M3 17l5-5 4 3 4-5"/><path d="M16 10l5-5" strokeDasharray="1.5 2.5"/><path d="M3 21h18"/></Icon>;
}

export function CalendarMetricIcon(p: IconProps) {
  return <Icon {...p}><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/></Icon>;
}

export function TempIcon(p: IconProps) {
  return <Icon {...p}><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 10v7.5"/></Icon>;
}

export function ShieldIcon(p: IconProps) {
  return <Icon {...p}><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/></Icon>;
}

export function TargetIcon(p: IconProps) {
  return <Icon {...p}><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></Icon>;
}

export function SignalMetricIcon(p: IconProps) {
  return <Icon {...p}><path d="M5 20v-3M10 20v-7M15 20v-11M20 20V5"/></Icon>;
}

export function AlertMetricIcon(p: IconProps) {
  return <Icon {...p}><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></Icon>;
}
