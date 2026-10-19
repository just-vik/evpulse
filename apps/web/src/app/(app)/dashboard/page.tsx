'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Car } from 'lucide-react';
import { SetupWizard } from '@/components/system/SetupWizard';
import { Page } from '@/components/layout';
import { useLayoutStore } from '@/stores/layout.store';
import { useAuthStore } from '@/stores/authStore';
import { apiClient } from '@/lib/api';
import { EmptyState } from '@/shared/ui/EmptyState';

import { VehicleStatusCard } from '@/components/dashboard/VehicleStatusCard';
import { InsightsSection } from '@/components/dashboard/InsightsSection';
import { AIActivityFeed } from '@/components/dashboard/AIActivityFeed';

import { TripsTodayCard } from '@/components/dashboard/TripsTodayCard';
import { WeekSummaryCard } from '@/components/dashboard/WeekSummaryCard';
import { ChargingSummaryCard } from '@/components/dashboard/ChargingSummaryCard';
import { CostAnalyticsCard } from '@/components/dashboard/CostAnalyticsCard';
import { EfficiencyCard } from '@/components/dashboard/EfficiencyCard';
import { BatteryHealthCard } from '@/components/dashboard/BatteryHealthCard';
import { CostForecastCard } from '@/components/dashboard/CostForecastCard';
import { VampireDrainWidget } from '@/components/dashboard/VampireDrainWidget';

export default function DashboardPage() {
  const selectedVehicleId = useLayoutStore((s) => s.selectedVehicleId);
  const { accessToken } = useAuthStore();
  const { t } = useTranslation();
  const [showSetupBanner, setShowSetupBanner] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('tesla') === 'connected') {
      setShowSetupBanner(true);
      // Clean up URL without reload
      const clean = window.location.pathname;
      window.history.replaceState({}, '', clean);
    }
  }, []);

  useEffect(() => {
    if (!selectedVehicleId || !accessToken) return;
    apiClient.wakePoll(selectedVehicleId, accessToken).catch(() => {});
  }, [selectedVehicleId, accessToken]);

  if (!selectedVehicleId) {
    return (
      <Page title={t('pages.dashboard.title')}>
        <EmptyState
          icon={<Car size={26} />}
          title={t('dashboard.selectVehicle')}
          className="py-16"
        />
      </Page>
    );
  }

  return (
    <Page title={t('pages.dashboard.title')}>
      <div className="space-y-5 pb-8">

        {/* ── Tesla setup wizard (shown after OAuth redirect) ─────────────── */}
        <SetupWizard show={showSetupBanner} onDismiss={() => setShowSetupBanner(false)} />

        {/* ── 1. Vehicle status hero ───────────────────────────────────────── */}
        <VehicleStatusCard vehicleId={selectedVehicleId} />

        {/* ── 2. Activity — today + this week (2-col always) ──────────────── */}
        <div className="grid grid-cols-2 gap-3">
          <TripsTodayCard vehicleId={selectedVehicleId} />
          <WeekSummaryCard vehicleId={selectedVehicleId} />
        </div>

        {/* ── 3. Month analytics — charging · cost (2-col, 3rd wraps on mobile) */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <ChargingSummaryCard vehicleId={selectedVehicleId} />
          <CostAnalyticsCard vehicleId={selectedVehicleId} />
          <div className="col-span-2 lg:col-span-1">
            <BatteryHealthCard vehicleId={selectedVehicleId} />
          </div>
        </div>

        {/* ── 4. Health & intelligence — efficiency · drain · forecast ────── */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <EfficiencyCard vehicleId={selectedVehicleId} />
          <VampireDrainWidget vehicleId={selectedVehicleId} />
          <div className="col-span-2 lg:col-span-1">
            <CostForecastCard vehicleId={selectedVehicleId} />
          </div>
        </div>

        {/* ── 5. AI insights + activity ────────────────────────────────────── */}
        <div className="space-y-4">
          <InsightsSection vehicleId={selectedVehicleId} />
          <AIActivityFeed vehicleId={selectedVehicleId} />
        </div>

      </div>
    </Page>
  );
}
