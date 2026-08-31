'use client';

import React from 'react';
import { motion } from 'framer-motion';

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: EmptyStateProps) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={`text-center py-20 ${className}`}>
      <div className="w-16 h-16 rounded-2xl bg-[hsl(var(--surface-1))] border border-[hsl(var(--border)/0.8)] flex items-center justify-center mx-auto mb-4 text-muted-foreground">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-foreground mb-2">{title}</h3>
      {description ? <p className="text-muted-foreground text-sm mb-6">{description}</p> : null}
      {action}
    </motion.div>
  );
}
