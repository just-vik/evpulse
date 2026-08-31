'use client';

import React from 'react';
import { Page } from '@/components/layout';
import { useLayoutStore } from '@/stores/layout.store';
import { useTranslation } from 'react-i18next';
import { Car } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { InsightsFeed } from '@/components/insights/InsightsFeed';

export default function InsightsPage() {
  const selectedVehicleId = useLayoutStore((s) => s.selectedVehicleId);
  const { t } = useTranslation();

  if (!selectedVehicleId) {
    return (
      <Page title={t('pages.insights.title', { defaultValue: 'Insights' })}>
        <EmptyState icon={<Car size={26} />} title={t('dashboard.selectVehicle')} className="py-16" />
      </Page>
    );
  }

  return (
    <Page title={t('pages.insights.title', { defaultValue: 'Insights' })}>
      <InsightsFeed vehicleId={selectedVehicleId} />
    </Page>
  );
}
