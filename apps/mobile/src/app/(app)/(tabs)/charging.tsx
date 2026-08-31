import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Animated,
  Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { colors, radius, spacing, typography } from '@/theme/tokens';
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
  currency: string | null;
  location?: string | null;
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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function chargerLabel(type: string | null): string {
  switch (type) {
    case 'tesla_sc':
    case 'supercharger': return 'Supercharger';
    case 'dc_fast':
    case 'dc_third': return 'DC Fast';
    case 'ac_fast':
    case 'ac_city': return 'AC Public';
    case 'home_slow':
    case 'ac_home': return 'Home';
    case 'home_wall':
    case 'ac_slow': return 'Home';
    default: return type ?? 'Unknown';
  }
}

function chargerColor(type: string | null): string {
  switch (type) {
    case 'tesla_sc':
    case 'supercharger': return colors.danger;
    case 'dc_fast':
    case 'dc_third': return colors.warning;
    case 'ac_fast':
    case 'ac_city': return colors.cyan;
    default: return colors.green;
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

function ActiveSessionCard({ session }: { session: SessionRow }) {
  const duration = formatDuration(session.startTime, null);
  const socDelta =
    session.startSoc != null && session.endSoc != null
      ? session.endSoc - session.startSoc
      : null;

  return (
    <View style={styles.activeCard}>
      <View style={styles.activeHeader}>
        <View style={styles.activeTitle}>
          <PulsingDot />
          <Text style={styles.activeTitleText}>Charging in progress</Text>
        </View>
        {session.chargerType && (
          <View style={[styles.badge, { borderColor: `${chargerColor(session.chargerType)}66`, backgroundColor: `${chargerColor(session.chargerType)}18` }]}>
            <Text style={[styles.badgeText, { color: chargerColor(session.chargerType) }]}>
              {chargerLabel(session.chargerType)}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.activeMetrics}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Started</Text>
          <Text style={styles.metricValue}>{formatTime(session.startTime)}</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Duration</Text>
          <Text style={styles.metricValue}>{duration}</Text>
        </View>
        {session.startSoc != null && (
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>SOC</Text>
            <Text style={styles.metricValue}>
              {Math.round(session.startSoc)}%
              {socDelta != null && socDelta > 0 ? ` → ${Math.round(Number(session.endSoc))}%` : ''}
            </Text>
          </View>
        )}
        {session.energyAddedKwh != null && (
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Energy</Text>
            <Text style={styles.metricValue}>{Number(session.energyAddedKwh).toFixed(2)} kWh</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function SessionItem({ session }: { session: SessionRow }) {
  const cost = session.manualCost ?? session.costTotal;
  const socDelta =
    session.startSoc != null && session.endSoc != null
      ? Math.round(Number(session.endSoc) - Number(session.startSoc))
      : null;

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTime}>{formatTime(session.startTime)}</Text>
        {session.chargerType && (
          <View style={[styles.badge, { borderColor: `${chargerColor(session.chargerType)}55`, backgroundColor: `${chargerColor(session.chargerType)}15` }]}>
            <Text style={[styles.badgeText, { color: chargerColor(session.chargerType) }]}>
              {chargerLabel(session.chargerType)}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.rowMeta}>
        {session.energyAddedKwh != null && (
          <Text style={styles.metaPrimary}>
            ⚡ {Number(session.energyAddedKwh).toFixed(2)} kWh
          </Text>
        )}
        {socDelta != null && socDelta > 0 && (
          <Text style={styles.metaSecondary}>
            +{socDelta}% SOC
          </Text>
        )}
        {session.endTime && (
          <Text style={styles.metaSecondary}>
            {formatDuration(session.startTime, session.endTime)}
          </Text>
        )}
        {session.maxPowerKw != null && (
          <Text style={styles.metaSecondary}>
            {Number(session.maxPowerKw).toFixed(1)} kW max
          </Text>
        )}
        {cost != null && (
          <Text style={[styles.metaPrimary, { color: colors.green }]}>
            €{Number(cost).toFixed(2)}
          </Text>
        )}
      </View>

      {session.location && (
        <Text style={styles.rowLocation} numberOfLines={1}>📍 {session.location}</Text>
      )}
    </View>
  );
}

export default function ChargingScreen() {
  const insets = useSafeAreaInsets();
  const { vehicleId } = useVehicleSummary();
  const [refreshing, setRefreshing] = useState(false);

  const q = useQuery({
    queryKey: ['charging-sessions', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<{ data: SessionRow[] }>(
        `/charging/vehicle/${vehicleId}/sessions?limit=40`,
      );
      return data.data;
    },
    enabled: !!vehicleId,
    refetchInterval: 30_000,
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await q.refetch(); } finally { setRefreshing(false); }
  }, [q]);

  const activeSession = q.data?.find((s) => s.endTime == null) ?? null;
  const completedSessions = q.data?.filter((s) => s.endTime != null) ?? [];

  const totalKwh = completedSessions.reduce((sum, s) => sum + (s.energyAddedKwh != null ? Number(s.energyAddedKwh) : 0), 0);
  const totalCost = completedSessions.reduce((sum, s) => {
    const c = s.manualCost ?? s.costTotal;
    return sum + (c != null ? Number(c) : 0);
  }, 0);

  if (!vehicleId) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <Text style={styles.muted}>Add a vehicle via Tesla linking first.</Text>
      </View>
    );
  }

  if (q.isPending) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <FlatList
      style={[styles.screen, { paddingTop: insets.top }]}
      data={completedSessions}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          tintColor={colors.primary}
          colors={[colors.primary]}
        />
      }
      ListHeaderComponent={() => (
        <View style={styles.listHeader}>
          <Text style={styles.title}>Charging</Text>
          <Text style={styles.subtitle}>Sessions and energy</Text>

          {activeSession && <ActiveSessionCard session={activeSession} />}

          {completedSessions.length > 0 && (
            <View style={styles.statsRow}>
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{totalKwh.toFixed(1)} kWh</Text>
                <Text style={styles.statLabel}>Total energy</Text>
              </View>
              {totalCost > 0 && (
                <View style={styles.statItem}>
                  <Text style={[styles.statValue, { color: colors.green }]}>€{totalCost.toFixed(2)}</Text>
                  <Text style={styles.statLabel}>Total cost</Text>
                </View>
              )}
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{completedSessions.length}</Text>
                <Text style={styles.statLabel}>Sessions</Text>
              </View>
            </View>
          )}

          {completedSessions.length > 0 && (
            <Text style={styles.sectionTitle}>History</Text>
          )}
        </View>
      )}
      ListEmptyComponent={
        !activeSession ? (
          <Text style={styles.muted}>No charging sessions yet.</Text>
        ) : null
      }
      renderItem={({ item }) => <SessionItem session={item} />}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg, backgroundColor: colors.background },
  list: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xxl + 16 },
  listHeader: { gap: spacing.md, marginBottom: spacing.sm },
  title: { ...typography.h1, color: colors.textPrimary },
  subtitle: { color: colors.textSecondary, fontSize: 14 },
  sectionTitle: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginTop: spacing.xs },

  // Active session card
  activeCard: {
    backgroundColor: `${colors.primary}12`,
    borderWidth: 1,
    borderColor: `${colors.primary}44`,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.md,
  },
  activeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  activeTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  activeTitleText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  activeMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  metric: { gap: 2, minWidth: '40%' },
  metricLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5 },
  metricValue: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },

  // Stats summary row
  statsRow: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  statItem: { flex: 1, alignItems: 'center', gap: 3 },
  statValue: { color: colors.textPrimary, fontSize: 18, fontWeight: '700' },
  statLabel: { color: colors.textSecondary, fontSize: 11 },

  // History rows
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 6,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowTime: { color: colors.textPrimary, fontWeight: '600', fontSize: 14 },
  rowMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  metaPrimary: { color: colors.cyan, fontSize: 14, fontWeight: '500' },
  metaSecondary: { color: colors.textSecondary, fontSize: 13 },
  rowLocation: { color: colors.textMuted, fontSize: 12 },

  // Badge
  badge: { borderRadius: 99, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '600' },

  muted: { color: colors.textSecondary, fontSize: 14, textAlign: 'center' },
});
