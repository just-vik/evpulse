'use client';

import React from 'react';

interface Props {
  height?: number;
  bars?: number;
  className?: string;
}

export function SkeletonChart({ height = 180, bars = 12, className = '' }: Props) {
  return (
    <div className={`animate-pulse ${className}`} style={{ height }}>
      <div className="flex items-end gap-1.5 h-full px-2 pb-6">
        {Array.from({ length: bars }).map((_, i) => {
          const barHeight = 30 + ((i * 37 + i * i * 7) % 55);
          return (
            <div
              key={i}
              className="flex-1 rounded-t-sm bg-[hsl(var(--muted)/0.3)]"
              style={{ height: `${barHeight}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}
