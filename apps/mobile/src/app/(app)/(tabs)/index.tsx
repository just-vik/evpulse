import { useCallback, useEffect, useState } from 'react';
import { Text, View, StyleSheet, RefreshControl, AppState } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { api } from '@/services/api';
import { Screen } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { useMetricGridColumns } from '@/components/layout/ResponsiveContainer';
import { Card } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatusChip } from '@/components/ui/StatusChip';
import { MetricCard } from '@/components/ui/MetricCard';
import { AlertCard } from '@/components/ui/AlertCard';
import { InsightCard } from '@/components/ui/InsightCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSkeleton } from '@/components/ui/LoadingSkeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { DataQualityBadge, type DataQuality } from '@/components/feedback/DataQualityBadge';
import { color, radius, space, type as tType, numeric } from '@/theme/tokens';
import { formatRelativeTime, formatDateTime } from '@/i18n/format';
import { useTelemetryStore } from '@/store/useTelemetryStore';
import { useVehicleSummary } from '@/features/vehicles/useVehicleSummary';
import { computeCriticalAlert, computeInsight } from '@/features/insights/homeInsights';
import { classifyLastTrip } from '@/features/insights/lastTripState';

interface TodaySummary {
  tripCount: number;
  distanceKm: number;
  energyKwh: number;
}

interface RecentTripRow {
  id: string;
  startTime: string;
  endTime: string | null;
  distanceKm: number | null;
  efficiencyWhkm: number | null;
}

interface RecentSessionRow {
  id: string;
  startTime: string;
  endTime: string | null;
  energyAddedKwh: number | null;
  chargerType: string | null;
}

function vehicleStateKey(state: string | undefined | null): string {
  const s = (state ?? '').toLowerCase();
  if (['charging', 'driving', 'parked', 'sleeping', 'offline'].includes(s)) {
    return `vehicleState.${s}`;
  }
  return 'vehicleState.unknown';
}

function stateColor(state: string | undefined | null): string {
  switch ((state ?? '').toLowerCase()) {
    case 'charging':
      return color.brand.teal400;
    case 'driving':
      return color.semantic.success;
    case 'parked':
      return color.text.secondary;
    case 'sleeping':
    case 'offline':
      return color.text.tertiary;
    default:
      return color.text.secondary;
  }
}

function BatteryBar({ pct, charging }: { pct: number; charging: boolean }) {
  const clamp = Math.max(0, Math.min(100, pct));
  const barColor = charging
    ? color.brand.teal400
    : clamp < 20
      ? color.semantic.danger
      : clamp < 40
        ? color.semantic.warning
        : color.semantic.success;
  return (
    <View style={styles.batteryWrap}>
      <View style={styles.batteryTrack}>
        <View style={[styles.batteryFill, { width: `${clamp}%`, backgroundColor: barColor }]} />
      </View>
      <Text style={[styles.batteryPct, { color: barColor }]}>{Math.round(clamp)}%</Text>
    </View>
  );
}

export default function DashboardScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const live = useTelemetryStore((s) => s.current);
  const { statusQuery, vehiclesQuery, vehicleId } = useVehicleSummary();
  const [refreshing, setRefreshing] = useState(false);
  const columns = useMetricGridColumns();

  const data = statusQuery.data;
  const battery = live?.batteryLevel ?? data?.soc ?? null;
  const range = live?.range ?? data?.batteryRangeKm ?? null;
  const outsideTemp = live?.outsideTemp ?? data?.outsideTemp ?? null;
  const chargingState = live?.chargingState ?? data?.chargingState ?? null;
  const power = data?.power ?? null;

  // P1.2 telemetry freshness fix. Pick whichever source — the live WS feed
  // vs. the REST snapshot — actually holds the more recent underlying data
  // timestamp; never blindly prefer the WS feed. The WS feed can itself be
  // holding a stale cached reading from before the socket reconnected (e.g.
  // the app was backgrounded while the vehicle was asleep) while a
  // just-completed REST refetch (foreground/reconnect-triggered, both
  // Tesla-API-free — see useReactQueryFocusSync/useTelemetrySocket) is
  // actually fresher. This is the fix for dataQuality/lastUpdate/
  // vehicleState continuing to show stale values after the vehicle actually
  // woke and resumed streaming.
  const liveTs = live?.lastUpdate ?? live?.timestamp ?? null;
  const restTs = data?.lastUpdate ?? null;
  const liveIsFresher =
    liveTs != null && (restTs == null || new Date(liveTs).getTime() >= new Date(restTs).getTime());

  const lastUpdate = liveIsFresher ? liveTs : restTs;
  const dataQuality: DataQuality = liveIsFresher ? (live?.dataQuality ?? 'OFFLINE') : (data?.dataQuality ?? 'OFFLINE');
  const vehicleState = liveIsFresher ? (live?.state ?? null) : (data?.vehicleState ?? null);

  const isCharging =
    (chargingState ?? '').toLowerCase() === 'charging' ||
    (vehicleState ?? '').toLowerCase() === 'charging';
  const isDriving = (vehicleState ?? '').toLowerCase() === 'driving';

  const v = vehiclesQuery.data?.find((x) => x.id === vehicleId);
  const vehicleName = v?.displayName ?? v?.model ?? t('home.eyebrow');

  // Real, genuinely "today"-scoped endpoint (GET /vehicles/:id/trips/today) —
  // deliberately NOT the charging/cost summary endpoints, which are fixed
  // 30-day windows and would mislabel as "today".
  const todayQuery = useQuery({
    queryKey: ['home-trips-today', vehicleId],
    queryFn: async () => {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const { data } = await api.get<TodaySummary>(
        `/vehicles/${vehicleId}/trips/today?dayStart=${encodeURIComponent(dayStart.toISOString())}`,
      );
      return data;
    },
    enabled: !!vehicleId,
  });

  const recentTripsQuery = useQuery({
    queryKey: ['home-recent-trip', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<{ data: RecentTripRow[] }>(`/trips/vehicle/${vehicleId}?limit=1`);
      return data.data;
    },
    enabled: !!vehicleId,
  });

  // No dedicated "active session" endpoint exists — same list-scan the
  // backend itself uses server-side (endTime == null), matching Charge tab.
  const sessionsQuery = useQuery({
    queryKey: ['home-recent-sessions', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<{ data: RecentSessionRow[] }>(
        `/charging/vehicle/${vehicleId}/sessions?limit=5`,
      );
      return data.data;
    },
    enabled: !!vehicleId,
    refetchInterval: 30_000,
  });

  const recentTrip = recentTripsQuery.data?.[0] ?? null;
  const activeSession = sessionsQuery.data?.find((s) => s.endTime == null) ?? null;

  const insightInput = {
    soc: battery != null ? Number(battery) : null,
    dataQuality,
    outsideTemp: outsideTemp != null ? Number(outsideTemp) : null,
    recentTrip: recentTrip
      ? { efficiencyWhkm: recentTrip.efficiencyWhkm, distanceKm: recentTrip.distanceKm }
      : null,
  };
  const criticalAlert = computeCriticalAlert(insightInput);
  const insight = computeInsight(insightInput);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        statusQuery.refetch(),
        vehiclesQuery.refetch(),
        todayQuery.refetch(),
        recentTripsQuery.refetch(),
        sessionsQuery.refetch(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [statusQuery, vehiclesQuery, todayQuery, recentTripsQuery, sessionsQuery]);

  // Local display-only timer: re-renders every 30s so the "N min ago" text
  // (derived from lastUpdate via formatRelativeTime) stays current. Never
  // touches the network and never changes dataQuality/lastUpdate itself —
  // those only ever change from an actual REST/WS read (above). Paused
  // while backgrounded so it isn't silently ticking for a screen no one can
  // see; cleaned up on unmount either way.
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!timer) timer = setInterval(() => forceUpdate((n) => n + 1), 30_000);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    if (AppState.currentState === 'active') start();
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') start();
      else stop();
    });

    return () => {
      stop();
      subscription.remove();
    };
  }, []);

  // LinearGradient requires literal color strings; these two decorative dark
  // teal/green gradient washes have no token equivalent (the token set has
  // no "dark decorative gradient" category) and are used nowhere else.
  const gradColors: [string, string] = isCharging
    ? ['#134E4A', color.bg.surface1]
    : isDriving
      ? ['#14432E', color.bg.surface1]
      : [color.bg.surface2, color.bg.surface1];

  // No vehicle at all yet — never render a numeric dashboard with fabricated zeros.
  if (!vehiclesQuery.isPending && !vehicleId) {
    return (
      <Screen>
        <ScreenHeader title={t('home.eyebrow')} />
        <EmptyState
          icon="car-outline"
          title={t('home.emptyTitle')}
          body={t('home.emptyBody')}
          actionLabel={t('home.connectTesla')}
          onAction={() => router.push('/(app)/(tabs)/settings')}
        />
      </Screen>
    );
  }

  // First load: no cached REST data and no live socket data yet — skeleton,
  // never a flash of 0% / 0 km.
  const isFirstLoad = (vehiclesQuery.isPending || statusQuery.isPending) && !live && !data;

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          tintColor={color.brand.teal400}
          colors={[color.brand.teal400]}
        />
      }
      header={
        <ScreenHeader
          title={vehicleName}
          right={!isFirstLoad ? <DataQualityBadge quality={dataQuality} lastSeenLabel={formatRelativeTime(lastUpdate)} /> : undefined}
        />
      }
    >
      {isFirstLoad ? (
        <View style={{ gap: space.md }}>
          <LoadingSkeleton variant="card" height={190} />
          <View style={styles.grid}>
            <LoadingSkeleton variant="card" height={80} style={{ flexBasis: '48%' }} />
            <LoadingSkeleton variant="card" height={80} style={{ flexBasis: '48%' }} />
            <LoadingSkeleton variant="card" height={80} style={{ flexBasis: '48%' }} />
            <LoadingSkeleton variant="card" height={80} style={{ flexBasis: '48%' }} />
          </View>
        </View>
      ) : (
        <>
          <LinearGradient
            colors={gradColors}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroCard}
          >
            <View style={styles.heroTop}>
              <Text style={styles.heroLabel}>{t('home.battery')}</Text>
              {/* isCharging comes from chargingState/vehicleState, never from power's
                  sign or value — power only supplies the magnitude to display. Before
                  the Oct 2026 power-polarity fix, a `power > 0` gate here could hide
                  this badge during a real charging session (when power came from the
                  PackVoltage×PackCurrent fallback, which used to be negative while
                  charging). Math.abs() is defense in depth, not load-bearing: the
                  canonical contract already guarantees charging power is positive. */}
              {isCharging && power != null && (
                <View style={styles.powerBadge}>
                  <Text style={styles.powerBadgeText}>⚡ {Math.abs(power).toFixed(1)} kW</Text>
                </View>
              )}
            </View>
            <Text style={styles.heroValue} maxFontSizeMultiplier={1.3}>
              {battery != null ? `${Math.round(Number(battery))}%` : '—'}
            </Text>
            {battery != null && <BatteryBar pct={Number(battery)} charging={isCharging} />}
            <Text style={styles.heroMeta}>
              {range != null
                ? t(isCharging ? 'home.rangeLabelCharging' : 'home.rangeLabel', {
                    km: Math.round(Number(range)),
                  })
                : '—'}
            </Text>
          </LinearGradient>

          <View style={[styles.grid, columns === 1 && styles.gridSingleCol]}>
            <MetricCard
              label={t('home.range')}
              value={range != null ? Math.round(Number(range)).toString() : undefined}
              unit={t('common.km')}
              wide={columns === 1}
            />
            <MetricCard
              label={t('home.outside')}
              value={outsideTemp != null ? Math.round(Number(outsideTemp)).toString() : undefined}
              unit="°C"
              wide={columns === 1}
            />
            <MetricCard
              label={t('home.state')}
              value={t(vehicleStateKey(vehicleState))}
              valueColor={stateColor(vehicleState)}
              wide={columns === 1}
            />
            <MetricCard
              label={t('home.updated')}
              value={formatRelativeTime(lastUpdate)}
              wide={columns === 1}
            />
            {isCharging && power != null && (
              <MetricCard
                label={t('home.chargingPower')}
                value={`${Math.abs(power).toFixed(1)} kW`}
                valueColor={color.brand.teal400}
                wide
              />
            )}
          </View>

          {statusQuery.isError && (
            <ErrorState compact message={t('home.errorLoadingStatus')} onRetry={() => statusQuery.refetch()} />
          )}

          {/* Today summary — real, "today"-scoped data */}
          <Card>
            <SectionHeader title={t('home.today.title')} />
            {todayQuery.isPending ? (
              <LoadingSkeleton variant="row" height={22} />
            ) : todayQuery.isError ? (
              <ErrorState compact message={t('home.today.error')} onRetry={() => todayQuery.refetch()} />
            ) : todayQuery.data && todayQuery.data.tripCount > 0 ? (
              <Text style={styles.cardLine}>
                {t('home.today.summary', {
                  count: todayQuery.data.tripCount,
                  km: Math.round(todayQuery.data.distanceKm),
                  kwh: todayQuery.data.energyKwh.toFixed(1),
                })}
              </Text>
            ) : (
              <Text style={styles.muted}>{t('home.today.empty')}</Text>
            )}
          </Card>

          {/* Active charge — only rendered when a session is actually in progress */}
          {activeSession && (
            <Card>
              <View style={styles.cardTitleRow}>
                <Text style={styles.cardTitle}>{t('home.activeCharge.title')}</Text>
                <StatusChip label={formatDateTime(activeSession.startTime)} tone="neutral" />
              </View>
              <Text style={styles.cardLine}>
                {t('home.activeCharge.summary', {
                  energy: activeSession.energyAddedKwh != null ? activeSession.energyAddedKwh.toFixed(2) : '—',
                })}
              </Text>
            </Card>
          )}

          {/* Critical alert — only rendered when a real condition exists */}
          {criticalAlert && (
            <AlertCard
              severity={criticalAlert.severity}
              title={t(criticalAlert.titleKey)}
              message={t(criticalAlert.messageKey, criticalAlert.messageParams)}
            />
          )}

          {/* One actionable insight — always renders (the "all good" state is
              itself real, checked information, not decorative filler) */}
          {!recentTripsQuery.isPending && (
            <InsightCard title={t(insight.titleKey)} description={t(insight.messageKey, insight.messageParams)} />
          )}

          {/* Last trip — P1.2.1: data-availability states only, never dash
              placeholders for an open/in-progress trip row. Deliberately does
              NOT try to infer whether backend finalization is "overdue" (see
              features/insights/lastTripState.ts) — that's a server-side
              lifecycle question, not a client one. */}
          <Card>
            <SectionHeader title={t('home.lastTrip.title')} />
            {recentTripsQuery.isPending ? (
              <LoadingSkeleton variant="row" height={22} />
            ) : (
              (() => {
                const state = classifyLastTrip(recentTrip);
                switch (state.kind) {
                  case 'completed':
                    return (
                      <Text style={styles.cardLine}>
                        {t('home.lastTrip.summary', {
                          distance: state.distanceKm.toFixed(1),
                          efficiency: Math.round(state.efficiencyWhkm).toString(),
                        })}
                      </Text>
                    );
                  case 'processing':
                    return <Text style={styles.muted}>{t('home.lastTrip.processing')}</Text>;
                  case 'empty':
                  default:
                    return <Text style={styles.muted}>{t('home.lastTrip.empty')}</Text>;
                }
              })()
            )}
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heroCard: {
    borderRadius: radius.xl,
    padding: space.lg,
    borderWidth: 1,
    borderColor: color.border.subtle,
    gap: space.sm,
  },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heroLabel: { ...tType.body, color: color.text.secondary },
  powerBadge: {
    backgroundColor: `${color.brand.teal400}22`,
    borderColor: `${color.brand.teal400}44`,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  powerBadgeText: { color: color.brand.teal400, fontSize: 12, fontWeight: '600' },
  heroValue: { ...numeric.metricValueDisplay, fontSize: 52, lineHeight: 60 },
  batteryWrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  batteryTrack: {
    flex: 1,
    height: 6,
    backgroundColor: color.border.subtle,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  batteryFill: { height: '100%', borderRadius: radius.pill },
  batteryPct: {
    ...tType.caption,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    minWidth: 38,
    textAlign: 'right',
  },
  heroMeta: { color: color.brand.teal300, fontSize: 14, marginTop: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  gridSingleCol: { flexDirection: 'column' },
  cardTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  cardTitle: { color: color.text.primary, fontSize: 16, fontWeight: '700' },
  cardLine: { color: color.text.primary, fontSize: 14, fontVariant: ['tabular-nums'] },
  muted: { color: color.text.secondary, fontSize: 14 },
});
