'use client';

import React from 'react';
import { AlertCircle } from 'lucide-react';

interface ErrorStateProps {
  message: string;
  className?: string;
}

export function ErrorState({ message, className = '' }: ErrorStateProps) {
  return (
    <div className={`flex items-center gap-3 p-4 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 ${className}`}>
      <AlertCircle size={20} />
      <p>{message}</p>
    </div>
  );
}
