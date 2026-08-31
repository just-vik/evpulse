'use client';

import { useState } from 'react';
import { Clock, ArrowRight } from 'lucide-react';
import { UpgradeModal } from './UpgradeModal';
import { useTranslation } from 'react-i18next';

interface Props {
  days: number;
}

export function ClampedBanner({ days }: Props) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-sm">
        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 min-w-0">
          <Clock size={14} className="shrink-0" />
          <span className="min-w-0">
            {t('clampedBanner.label')} <strong>{days} {t('clampedBanner.days')}</strong>. {t('clampedBanner.suffix')}
          </span>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1 text-xs font-medium text-brand-500 hover:text-brand-400 whitespace-nowrap transition shrink-0"
        >
          {t('clampedBanner.upgrade')} <ArrowRight size={12} />
        </button>
      </div>
      <UpgradeModal open={open} onOpenChange={setOpen} defaultPlan="PRO" />
    </>
  );
}
