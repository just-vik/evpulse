'use client';

import React from 'react';

interface Props {
  rows?: number;
  cols?: number;
  className?: string;
}

export function SkeletonTable({ rows = 5, cols = 4, className = '' }: Props) {
  return (
    <div className={`animate-pulse ${className}`}>
      {/* Header */}
      <div className="flex gap-4 px-4 py-2 border-b border-[hsl(var(--border)/0.5)]">
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="h-3 rounded-full bg-[hsl(var(--muted)/0.4)] flex-1" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 px-4 py-3 border-b border-[hsl(var(--border)/0.3)]">
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={c}
              className="h-3 rounded-full bg-[hsl(var(--muted)/0.25)] flex-1"
              style={{ opacity: 1 - r * 0.12 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
