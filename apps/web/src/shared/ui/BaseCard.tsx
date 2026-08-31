'use client';

import React, { useRef, useCallback } from 'react';
import { motion } from 'framer-motion';

interface BaseCardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  animate?: boolean;
  interactive?: boolean;
  elevated?: boolean;
}

export function BaseCard({
  children,
  className = '',
  onClick,
  animate = true,
  interactive = false,
  elevated = false,
}: BaseCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const { left, top, width, height } = el.getBoundingClientRect();
    const x = ((e.clientX - left) / width) * 100;
    const y = ((e.clientY - top) / height) * 100;
    el.style.setProperty('--mx', `${x}%`);
    el.style.setProperty('--my', `${y}%`);
  }, []);

  const handleMouseLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--mx', '50%');
    el.style.setProperty('--my', '50%');
  }, []);

  const classes = [
    'spatial-card',
    elevated ? 'spatial-card-elevated' : '',
    interactive ? 'spatial-card-interactive' : '',
    'rounded-2xl p-5',
    className,
  ].filter(Boolean).join(' ');

  const motionProps = animate
    ? { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.25 } }
    : {};

  return (
    <motion.div
      ref={ref}
      {...motionProps}
      className={classes}
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </motion.div>
  );
}
