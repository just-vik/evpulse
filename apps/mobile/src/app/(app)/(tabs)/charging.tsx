import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, Animated, Easing } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/services/api';
import { color, radius, space, type as tType } from '@/theme/tokens';
import { Screen, useScreenInsets } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Card } from '@/components/ui/Card';
import { StatusChip } from '@/components/ui/StatusChip';
import { MetricCard } from '@/components/ui/MetricCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingSkeleton } from '@/components/ui/LoadingSkeleton';
import { formatDateTime, formatCurrency } from '@/i18n/format';
import { useVehicleSummary } from '@/features/vehicles/useVehicleSummary';

interface SessionRow {
  id: string;
  startTime: string;
  endTime: string | null;
  startSoc: number | null;
  endSoc: number | null;
  energyAddedKwh: number | null;
  maxPowerKw: number | null;
  chargerType: string | null;
  costTotal: number | null;
  manualCost: number | null;
  currency: string | null; // real field, default 'EUR' server-side — never hardcode '€'
  location?: string | null;
  // Real field (ChargingSession.chargingEfficiency, apps/api schema.prisma) —
  // energy delivered to battery vs. energy drawn from the charger. Nullable:
  // only computed for sessions with ΔSOC>=2% and a plausible [0.70,1.25] ratio.
  chargingEfficiency: number | null;
}

/** GET /analytics/vehicle/:id/cost-forecast — real, hierarchical rate
 *  resolution (sessions -> settings -> default -> override). No currency
 *  field in the response; formatCurrency's own EUR fallback applies, same
 *  as every other cost figure in this app when a session has none. */
interface CostForecast {
  weeklyCost: number;
  monthlyCost: number;
  avgEnergyPerDay: number;
  effectiveRate: number;
  rateSource: 'sessions' | 'settings' | 'default' | 'override';
  dataSource: 'daily_energy' | 'trips';
}

type ChargerBucket = 'home' | 'supercharger' | 'other';

function chargerBucket(type: string | null): ChargerBucket {
  switch (type) {
    case 'home_slow':
    case 'ac_home':
    case 'home_wall':
    case 'ac_slow':
      return 'home';
    case 'tesla_sc':
    case 'supercharger':
      return 'supercharger';
    default:
      return 'other';
  }
}

function formatDuration(startIso: string, endIso: string | null): string {
  const endMs = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = endMs - new Date(startIso).getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function chargerLabelKey(t: string | null): string {
  switch (t) {
    case 'tesla_sc':
    case 'supercharger':
      return 'charge.chargerType.supercharger';
    case 'dc_fast':
    case 'dc_third':
      return 'charge.chargerType.dcFast';
    case 'ac_fast':
    case 'ac_city':
      return 'charge.chargerType.acPublic';
    case 'home_slow':
    case 'ac_home':
    case 'home_wall':
    case 'ac_slow':
      return 'charge.chargerType.home';
    default:
      return 'charge.chargerType.unknown';
  }
}

function chargerColor(t: string | null): string {
  switch (t) {
    case 'tesla_sc':
    case 'supercharger':
      return color.semantic.danger;
    case 'dc_fast':
    case 'dc_third':
      return color.semantic.warning;
    case 'ac_fast':
    case 'ac_city':
      return color.brand.teal400;
    default:
      return color.semantic.success;
  }
}

function PulsingDot() {
  const anim = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 800, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(anim, { toValue: 0.4, duration: 800, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ]),
    ).start();
  }, [anim]);
  return <Animated.View style={[styles.dot, { opacity: anim }]} />;
}

function ActiveSessionCard({ session, t }: { session: SessionRow; t: (k: string) => string }) {
  const duration = formatDuration(session.startTime, null);
  const socDelta =
    session.startSoc != null && session.endSoc != null ? session.endSoc - session.startSoc : null;

  return (
    <View style={styles.activeCard}>
      <View style={styles.activeHeader}>
        <View style={styles.activeTitle}>
          <PulsingDot />
          <Text style={styles.activeTitleText}>{t('charge.chargingInProgress')}</Text>
        </View>
        {session.chargerType && (
          <StatusChip label={t(chargerLabelKey(session.chargerType))} tintColor={chargerColor(session.chargerType)} />
        )}
      </View>

      <View style={styles.activeMetrics}>
        <MetricCard label={t('charge.started')} value={formatDateTime(session.startTime)} />
        <MetricCard label={t('charge.duration')} value={duration} />
        {session.startSoc != null && (
          <MetricCard
            label={t('charge.soc')}
            value={`${Math.round(session.startSoc)}%${socDelta != null && socDelta > 0 ? ` → ${Math.round(Number(session.endSoc))}%` : ''}`}
          />
        )}
        {session.energyAddedKwh != null && (
          <MetricCard label={t('charge.energy')} value={Number(session.energyAddedKwh).toFixed(2)} unit={t('common.kwh')} />
        )}
      </View>
    </View>
  );
}

function SessionItem({ session, t }: { session: SessionRow; t: (k: string) => string }) {
  const cost = session.manualCost ?? session.costTotal;
  const socDelta =
    session.startSoc != null && session.endSoc != null
      ? Math.round(Number(session.endSoc) - Number(session.startSoc))
      : null;

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTime}>{formatDateTime(session.startTime)}</Text>
        {session.chargerType && (
          <StatusChip label={t(chargerLabelKey(session.chargerType))} tintColor={chargerColor(session.chargerType)} />
        )}
      </View>

      <View style={styles.rowMeta}>
        {session.energyAddedKwh != null && (
          <Text style={styles.metaPrimary}>⚡ {Number(session.energyAddedKwh).toFixed(2)} kWh</Text>
        )}
        {socDelta != null && socDelta > 0 && <Text style={styles.metaSecondary}>+{socDelta}% SOC</Text>}
        {session.endTime && (
          <Text style={styles.metaSecondary}>{formatDuration(session.startTime, session.endTime)}</Text>
        )}
        {session.maxPowerKw != null && (
          <Text style={styles.metaSecondary}>{Number(session.maxPowerKw).toFixed(1)} kW max</Text>
        )}
        {session.chargingEfficiency != null && (
          <Text style={styles.metaSecondary}>
            {Math.round(session.chargingEfficiency * 100)}% {t('charge.efficiencyShort')}
          </Text>
        )}
        {cost != null && (
          <Text style={[styles.metaPrimary, { color: color.semantic.success }]}>
            {formatCurrency(Number(cost), session.currency)}
          </Text>
        )}
      </View>

      {session.location && (
        <Text style={styles.rowLocation} numberOfLines={1}>
          📍 {session.location}
        </Text>
      )}
    </View>
  );
}

export default function ChargingScreen() {
  const { t } = useTranslation();
  const { paddingBottom } = useScreenInsets();
  const { vehicleId } = useVehicleSummary();
  const [refreshing, setRefreshing] = useState(false);

  const q = useQuery({
    queryKey: ['charging-sessions', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<{ data: SessionRow[] }>(`/charging/vehicle/${vehicleId}/sessions?limit=40`);
      return data.data;
    },
    enabled: !!vehicleId,
    refetchInterval: 30_000,
  });

  const forecastQuery = useQuery({
    queryKey: ['cost-forecast', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<CostForecast>(`/analytics/vehicle/${vehicleId}/cost-forecast`);
      return data;
    },
    enabled: !!vehicleId,
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([q.refetch(), forecastQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [q, forecastQuery]);

  const activeSession = q.data?.find((s) => s.endTime == null) ?? null;
  const completedSessions = q.data?.filter((s) => s.endTime != null) ?? [];

  const totalKwh = completedSessions.reduce(
    (sum, s) => sum + (s.energyAddedKwh != null ? Number(s.energyAddedKwh) : 0),
    0,
  );
  // Cost totals mix currencies only in the (rare) multi-currency case; P0
  // keeps the simple sum + formats with the most common currency present,
  // matching what a single-currency household actually sees in practice.
  const totalCost = completedSessions.reduce((sum, s) => {
    const c = s.manualCost ?? s.costTotal;
    return sum + (c != null ? Number(c) : 0);
  }, 0);
  const totalCostCurrency = completedSessions.find((s) => s.manualCost != null || s.costTotal != null)?.currency ?? null;

  // Home vs. Supercharger vs. other-public — no dedicated backend
  // aggregation endpoint exists; computed client-side from the same session
  // list, exactly matching how the web charging page does this split.
  const breakdown = useMemo(() => {
    const groups: Record<ChargerBucket, number> = { home: 0, supercharger: 0, other: 0 };
    for (const s of completedSessions) {
      groups[chargerBucket(s.chargerType)] += s.energyAddedKwh ?? 0;
    }
    const total = groups.home + groups.supercharger + groups.other;
    return { groups, total };
  }, [completedSessions]);

  if (!vehicleId) {
    return (
      <Screen scrollable={false}>
        <ScreenHeader title={t('charge.title')} />
        <EmptyState icon="flash-outline" title={t('charge.noVehicle')} />
      </Screen>
    );
  }

  if (q.isPending) {
    return (
      <Screen scrollable={false}>
        <ScreenHeader title={t('charge.title')} subtitle={t('charge.subtitle')} />
        <View style={{ paddingHorizontal: space.md, gap: space.sm }}>
          <LoadingSkeleton variant="card" height={96} />
          <LoadingSkeleton variant="card" height={72} />
          <LoadingSkeleton variant="card" height={72} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scrollable={false}>
      <FlatList
        style={styles.list}
        data={completedSessions}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.listContent, { paddingBottom }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={color.brand.teal400}
            colors={[color.brand.teal400]}
          />
        }
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <ScreenHeader title={t('charge.title')} subtitle={t('charge.subtitle')} />

            {activeSession && <ActiveSessionCard session={activeSession} t={t} />}

            {completedSessions.length > 0 && (
              <View style={styles.statsRow}>
                <View style={styles.statItem}>
                  <Text style={styles.statValue}>{totalKwh.toFixed(1)} kWh</Text>
                  <Text style={styles.statLabel}>{t('charge.totalEnergy')}</Text>
                </View>
                {totalCost > 0 && (
                  <View style={styles.statItem}>
                    <Text style={[styles.statValue, { color: color.semantic.success }]}>
                      {formatCurrency(totalCost, totalCostCurrency)}
                    </Text>
                    <Text style={styles.statLabel}>{t('charge.totalCost')}</Text>
                  </View>
                )}
                <View style={styles.statItem}>
                  <Text style={styles.statValue}>{completedSessions.length}</Text>
                  <Text style={styles.statLabel}>{t('charge.sessions')}</Text>
                </View>
              </View>
            )}

            {q.isError && (
              <ErrorState compact message={t('charge.errorLoading')} onRetry={() => q.refetch()} />
            )}

            {/* Tariff / cost forecast — real hierarchical rate resolution */}
            <Card>
              <SectionHeader title={t('charge.tariff.title')} />
              {forecastQuery.isPending ? (
                <LoadingSkeleton variant="row" height={40} />
              ) : forecastQuery.isError ? (
                <ErrorState compact message={t('charge.tariff.error')} onRetry={() => forecastQuery.refetch()} />
              ) : forecastQuery.data ? (
                <>
                  <View style={styles.tariffRow}>
                    <Text style={styles.tariffValue}>{formatCurrency(forecastQuery.data.weeklyCost, null)}</Text>
                    <Text style={styles.tariffLabel}>{t('charge.tariff.weekly')}</Text>
                  </View>
                  <View style={styles.tariffRow}>
                    <Text style={styles.tariffValue}>{formatCurrency(forecastQuery.data.monthlyCost, null)}</Text>
                    <Text style={styles.tariffLabel}>{t('charge.tariff.monthly')}</Text>
                  </View>
                  <View style={styles.tariffSourceRow}>
                    <Text style={styles.metaSecondary}>
                      {formatCurrency(forecastQuery.data.effectiveRate, null)}/{t('common.kwh')}
                    </Text>
                    <StatusChip
                      label={t(`charge.tariff.source.${forecastQuery.data.rateSource}`)}
                      tone={forecastQuery.data.rateSource === 'default' ? 'neutral' : 'brand'}
                    />
                  </View>
                </>
              ) : null}
            </Card>

            {/* Home vs. Supercharger vs. other-public */}
            {breakdown.total > 0 && (
              <Card>
                <SectionHeader title={t('charge.breakdown.title')} />
                {(['home', 'supercharger', 'other'] as const).map((bucket) => {
                  const kwh = breakdown.groups[bucket];
                  if (kwh <= 0) return null;
                  const pct = Math.round((kwh / breakdown.total) * 100);
                  return (
                    <View key={bucket} style={styles.breakdownRow}>
                      <Text style={styles.breakdownLabel}>{t(`charge.breakdown.${bucket}`)}</Text>
                      <View style={styles.breakdownBarTrack}>
                        <View
                          style={[
                            styles.breakdownBarFill,
                            { width: `${pct}%`, backgroundColor: chargerColor(bucket === 'home' ? 'ac_home' : bucket === 'supercharger' ? 'supercharger' : 'ac_fast') },
                          ]}
                        />
                      </View>
                      <Text style={styles.breakdownPct}>{pct}%</Text>
                    </View>
                  );
                })}
                {/* Honest scope caption — this is a split of the fetched
                    session list (limit=40), not a lifetime total; matters
                    once a user has more history than one page covers. */}
                <Text style={styles.breakdownCaption}>
                  {t('charge.breakdown.basedOn', { count: completedSessions.length })}
                </Text>
              </Card>
            )}

            {!q.isError && completedSessions.length > 0 && <SectionHeader title={t('charge.history')} />}
          </View>
        }
        ListEmptyComponent={
          !activeSession && !q.isError ? <EmptyState icon="flash-outline" title={t('charge.empty')} /> : null
        }
        renderItem={({ item }) => <SessionItem session={item} t={t} />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { paddingHorizontal: space.md, gap: space.sm },
  listHeader: { gap: space.md, marginBottom: space.sm },

  activeCard: {
    backgroundColor: `${color.brand.teal400}12`,
    borderWidth: 1,
    borderColor: `${color.brand.teal400}44`,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.md,
  },
  activeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  activeTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  activeTitleText: { color: color.brand.teal400, fontSize: 15, fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.brand.teal400 },
  activeMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },

  statsRow: {
    flexDirection: 'row',
    backgroundColor: color.bg.surface1,
    borderWidth: 1,
    borderColor: color.border.subtle,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.md,
  },
  statItem: { flex: 1, alignItems: 'center', gap: 3 },
  statValue: { color: color.text.primary, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statLabel: { ...tType.caption, color: color.text.secondary },

  row: {
    backgroundColor: color.bg.surface1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border.subtle,
    padding: space.md,
    gap: 6,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  rowTime: { color: color.text.primary, fontWeight: '600', fontSize: 14 },
  rowMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  metaPrimary: { color: color.brand.teal300, fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'] },
  metaSecondary: { color: color.text.secondary, fontSize: 13 },
  rowLocation: { color: color.text.tertiary, fontSize: 12 },

  tariffRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  tariffValue: { color: color.text.primary, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  tariffLabel: { ...tType.caption, color: color.text.secondary },
  tariffSourceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },

  breakdownRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  breakdownLabel: { ...tType.caption, color: color.text.secondary, width: 96 },
  breakdownBarTrack: {
    flex: 1,
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: color.bg.surface2,
    overflow: 'hidden',
  },
  breakdownBarFill: { height: '100%', borderRadius: radius.pill },
  breakdownPct: { ...tType.caption, color: color.text.primary, fontWeight: '600', width: 36, textAlign: 'right' },
  breakdownCaption: { ...tType.caption, color: color.text.tertiary, marginTop: 2 },
});
