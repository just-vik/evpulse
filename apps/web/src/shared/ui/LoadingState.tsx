'use client';

import React from 'react';
import { Loader } from 'lucide-react';

interface LoadingStateProps {
  className?: string;
  size?: number;
}

export function LoadingState({ className = '', size = 32 }: LoadingStateProps) {
  return (
    <div className={`flex items-center justify-center py-20 ${className}`}>
      <Loader size={size} className="animate-spin text-[hsl(var(--brand-h)_var(--brand-s)_var(--brand-l-500))]" />
    </div>
  );
}
