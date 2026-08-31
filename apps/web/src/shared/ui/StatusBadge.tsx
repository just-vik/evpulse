'use client';

import React from 'react';

type BadgeType = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

interface StatusBadgeProps {
  type: BadgeType;
  label?: string;
  dot?: boolean;
  className?: string;
}

const BADGE_STYLES: Record<BadgeType, string> = {
  success: 'bg-emerald-500/15 text-emerald-300',
  warning: 'bg-amber-500/15 text-amber-300',
  danger:  'bg-red-500/15 text-red-300',
  info:    'bg-sky-500/15 text-sky-300',
  neutral: 'bg-[hsl(var(--secondary)/0.65)] text-muted-foreground',
};

const DOT_STYLES: Record<BadgeType, string> = {
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  danger:  'bg-red-400',
  info:    'bg-sky-400',
  neutral: 'bg-muted-foreground',
};

export function StatusBadge({ type, label, dot = false, className = '' }: StatusBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full ${BADGE_STYLES[type]} ${className}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${DOT_STYLES[type]}`} />}
      {label ?? type}
    </span>
  );
}
