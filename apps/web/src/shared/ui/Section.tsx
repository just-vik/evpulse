'use client';

import React from 'react';

interface SectionProps {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}

export function Section({ title, children, right, className = '' }: SectionProps) {
  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-widest text-slate-500 font-medium">
          {title}
        </h2>
        {right}
      </div>
      {children}
    </div>
  );
}
