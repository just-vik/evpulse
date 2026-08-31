'use client';

import React, { useEffect, useRef, useState } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { BaseCard } from './BaseCard';

type KPIStatus = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

interface KPIProps {
  title: string;
  value: string | number;
  hint?: string;
  status?: KPIStatus;
  icon?: React.ReactNode;
  className?: string;
  onClick?: () => void;
  /** Signed delta to display as badge, e.g. +1.2 = "+1.2%" */
  delta?: number;
  deltaUnit?: string;
  /** If true, positive delta is good (green↑), negative is bad (red↓) */
  deltaPositiveGood?: boolean;
  precision?: number;
  /** Tooltip text for the delta badge */
  deltaLabel?: string;
}

const STATUS_COLOR: Record<KPIStatus, string> = {
  success: 'text-[var(--c-success)]',
  warning: 'text-[var(--c-warning)]',
  danger:  'text-[var(--c-danger)]',
  info:    'text-[var(--c-info)]',
  neutral: 'text-[var(--s-text)]',
};

// Parse a formatted value string into { prefix, num, suffix }
// e.g. "~96.0 %" → { prefix: "~", num: 96.0, suffix: " %" }
// e.g. "123 km"  → { prefix: "",  num: 123,   suffix: " km" }
// e.g. "—"       → null (no numeric part)
function parseValue(value: string | number): { prefix: string; num: number; suffix: string } | null {
  const str = String(value);
  const match = str.match(/^([^0-9\-]*)(-?[\d.,]+)(.*)$/);
  if (!match) return null;
  const num = parseFloat(match[2].replace(',', '.'));
  if (isNaN(num)) return null;
  return { prefix: match[1], num, suffix: match[3] };
}

export function KPI({
  title, value, hint, status = 'neutral', icon, className, onClick,
  delta, deltaUnit = '%', deltaPositiveGood = true, precision, deltaLabel,
}: KPIProps) {
  const valueColor = STATUS_COLOR[status];
  const parsed = parseValue(value);

  // Animated display value — spring-like exponential decay via rAF
  const [displayNum, setDisplayNum] = useState(parsed?.num ?? 0);
  const rafRef     = useRef<number>(0);
  const currentRef = useRef<number>(parsed?.num ?? 0);

  useEffect(() => {
    if (parsed == null) return;
    const target = parsed.num;

    const step = () => {
      const diff = target - currentRef.current;
      if (Math.abs(diff) < 0.001) {
        currentRef.current = target;
        setDisplayNum(target);
        return;
      }
      currentRef.current += diff * 0.14;
      setDisplayNum(currentRef.current);
      rafRef.current = requestAnimationFrame(step);
    };

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [parsed?.num]); // eslint-disable-line react-hooks/exhaustive-deps

  // Determine precision from original value or prop
  const dp = precision ?? (parsed ? (String(parsed.num).split('.')[1]?.length ?? 0) : 0);

  const formattedValue = parsed
    ? `${parsed.prefix}${displayNum.toFixed(dp)}${parsed.suffix}`
    : String(value);

  // Delta badge
  const hasDelta = delta != null && isFinite(delta);
  const deltaGood = hasDelta && (deltaPositiveGood ? delta! > 0 : delta! < 0);
  const deltaBad  = hasDelta && (deltaPositiveGood ? delta! < 0 : delta! > 0);
  const DeltaIcon = delta != null && delta >= 0 ? TrendingUp : TrendingDown;
  const deltaColor = deltaGood
    ? 'text-[var(--c-success)] bg-[color-mix(in_oklch,var(--c-success)_10%,transparent)]'
    : deltaBad
      ? 'text-[var(--c-danger)] bg-[color-mix(in_oklch,var(--c-danger)_10%,transparent)]'
      : 'text-[var(--s-text-muted)] bg-[var(--s-2)]';

  return (
    <BaseCard className={className} interactive={!!onClick} onClick={onClick}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] uppercase tracking-wide text-[var(--s-text-muted)] font-semibold">{title}</p>
        <div className="flex items-center gap-1.5">
          {hasDelta && (
            <span
              className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${deltaColor}`}
              title={deltaLabel ?? 'vs previous period'}
            >
              <DeltaIcon size={9} />
              {delta! > 0 ? '+' : ''}{delta!.toFixed(1)}{deltaUnit}
            </span>
          )}
          {icon && (
            <div className="w-8 h-8 rounded-lg bg-[var(--s-2)] flex items-center justify-center text-[var(--s-text-muted)]">
              {icon}
            </div>
          )}
        </div>
      </div>
      <p className={`text-2xl font-bold mt-1 tabular-nums ${valueColor}`}>{formattedValue}</p>
      {hint && <p className="text-[11px] text-[var(--s-text-muted)] mt-1">{hint}</p>}
    </BaseCard>
  );
}
