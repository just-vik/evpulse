'use client';

import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSubscription } from '@/hooks/useSubscription';
import { UpgradeModal } from '@/components/billing/UpgradeModal';

export type PremiumFeature = 'pack-diagnostics' | 'ai-insights' | 'export' | 'alerts';

interface PremiumGateProps {
  feature: PremiumFeature;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function PremiumGate({ feature, children, fallback }: PremiumGateProps) {
  const { isPro, isFleet, isLoading } = useSubscription();
  const isPremium = isPro || isFleet;

  // During loading show nothing to avoid layout flash
  if (isLoading) return null;
  if (isPremium) return <>{children}</>;
  return fallback ? <>{fallback}</> : <DefaultUpsell feature={feature} />;
}

function DefaultUpsell({ feature }: { feature: PremiumFeature }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <UpgradeModal open={open} onOpenChange={setOpen} />
      <div className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] p-8 flex flex-col items-center text-center gap-4">
        <div className="w-12 h-12 rounded-full bg-brand-500/15 flex items-center justify-center">
          <Lock size={20} className="text-brand-400" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground mb-1">
            {t(`premium.${feature}.title`)}
          </p>
          <p className="text-xs text-muted-foreground max-w-[220px]">
            {t(`premium.${feature}.description`)}
          </p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="px-5 py-3 min-h-[44px] rounded-xl bg-brand-500 text-white text-sm font-medium hover:brightness-110 transition-all"
        >
          {t('premium.upgrade')}
        </button>
      </div>
    </>
  );
}
