'use client';

import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface Props {
  delta: number | null | undefined;
  unit?: string;
  invertColor?: boolean;
  precision?: number;
  className?: string;
}

export function PeriodDeltaBadge({
  delta,
  unit = '%',
  invertColor = false,
  precision = 1,
  className = '',
}: Props) {
  if (delta == null) return null;

  const isZero = Math.abs(delta) < 0.05;
  const isPositive = delta > 0;

  // By default: positive = green (good). invertColor = true flips (e.g. for drain — higher is worse).
  const colorPositive = invertColor ? 'text-red-400 bg-red-500/10' : 'text-emerald-400 bg-emerald-500/10';
  const colorNegative = invertColor ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10';
  const colorZero = 'text-muted-foreground bg-[hsl(var(--muted)/0.3)]';

  const colorClass = isZero ? colorZero : isPositive ? colorPositive : colorNegative;

  const Icon = isZero ? Minus : isPositive ? TrendingUp : TrendingDown;
  const sign = isPositive ? '+' : '';

  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-md tabular-nums ${colorClass} ${className}`}>
      <Icon size={10} strokeWidth={2.5} />
      {sign}{delta.toFixed(precision)}{unit}
    </span>
  );
}
