'use client';

import React from 'react';

interface Props {
  rows?: number;
  className?: string;
}

export function SkeletonCard({ rows = 3, className = '' }: Props) {
  return (
    <div className={`relative overflow-hidden bg-[hsl(var(--card))] border border-[hsl(var(--border)/0.7)] rounded-2xl p-5 shadow-[0_1px_3px_hsl(0_0%_0%/0.15)] ${className}`}>
      <div className="animate-pulse space-y-3">
        <div className="h-3 w-24 rounded-full bg-[hsl(var(--muted)/0.4)]" />
        <div className="h-7 w-32 rounded-lg bg-[hsl(var(--muted)/0.35)]" />
        <div className="border-t border-[hsl(var(--border)/0.5)] pt-3 space-y-2">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="h-3 rounded-full bg-[hsl(var(--muted)/0.3)]" style={{ width: `${65 + (i % 3) * 12}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
