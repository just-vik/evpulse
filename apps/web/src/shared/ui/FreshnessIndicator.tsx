'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useTelemetryFreshness } from '@/hooks/useTelemetryFreshness';
import { formatRelativeTime } from '@/lib/utils';

interface Props {
  vehicleId: string | null;
  showLabel?: boolean;
  className?: string;
}

const LABEL: Record<string, string> = {
  realtime: 'Live',
  delayed:  'Delayed',
  stale:    'Stale',
  offline:  'Offline',
};

export function FreshnessIndicator({ vehicleId, showLabel = true, className = '' }: Props) {
  const { state, lastEventAt, latencyMs, cssClass, dotClass } = useTelemetryFreshness(vehicleId);
  const { i18n } = useTranslation();

  const latencyLabel = latencyMs != null && latencyMs > 0
    ? formatRelativeTime(new Date(Date.now() - latencyMs), i18n.language)
    : lastEventAt
      ? formatRelativeTime(lastEventAt.toISOString(), i18n.language)
      : null;

  return (
    <div className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-full border ${cssClass} ${className}`}>
      <span className={`${dotClass} w-1.5 h-1.5 rounded-full shrink-0`} />
      {showLabel && (
        <span>{latencyLabel && state !== 'realtime' ? latencyLabel : LABEL[state]}</span>
      )}
    </div>
  );
}
