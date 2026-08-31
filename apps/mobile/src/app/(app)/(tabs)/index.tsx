import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  Text,
  View,
  StyleSheet,
  RefreshControl,
  Animated,
  Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, radius, spacing, typography } from '@/theme/tokens';
import { useTelemetryStore } from '@/store/useTelemetryStore';
import { useVehicleSummary } from '@/features/vehicles/useVehicleSummary';

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

function stateLabel(state: string | undefined | null): string {
  switch ((state ?? '').toLowerCase()) {
    case 'charging': return 'Charging';
    case 'driving': return 'Driving';
    case 'parked': return 'Parked';
    case 'sleeping': return 'Sleeping';
    case 'offline': return 'Offline';
    default: return state ?? '—';
  }
}

function stateColor(state: string | undefined | null): string {
  switch ((state ?? '').toLowerCase()) {
    case 'charging': return colors.primary;
    case 'driving': return colors.green;
    case 'parked': return colors.textSecondary;
    case 'sleeping': return colors.textMuted;
    case 'offline': return colors.textMuted;
    default: return colors.textSecondary;
  }
}

function PulsingDot({ color }: { color: string }) {
  const anim = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 900, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(anim, { toValue: 0.4, duration: 900, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ]),
    ).start();
  }, [anim]);
  return (
    <Animated.View style={[styles.dot, { backgroundColor: color, opacity: anim }]} />
  );
}

function BatteryBar({ pct, charging }: { pct: number; charging: boolean }) {
  const clamp = Math.max(0, Math.min(100, pct));
  const barColor = charging ? colors.primary : clamp < 20 ? colors.danger : clamp < 40 ? colors.warning : colors.green;
  return (
    <View style={styles.batteryWrap}>
      <View style={styles.batteryTrack}>
        <View style={[styles.batteryFill, { width: `${clamp}%` as any, backgroundColor: barColor }]} />
      </View>
      <Text style={[styles.batteryPct, { color: barColor }]}>{Math.round(clamp)}%</Text>
    </View>
  );
}

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const live = useTelemetryStore((s) => s.current);
  const connected = useTelemetryStore((s) => s.connected);
  const { statusQuery, vehiclesQuery, vehicleId } = useVehicleSummary();
  const [refreshing, setRefreshing] = useState(false);

  const data = statusQuery.data;
  const battery = live?.batteryLevel ?? data?.soc ?? 0;
  const range = live?.range ?? data?.batteryRangeKm ?? 0;
  const outsideTemp = live?.outsideTemp ?? (data as any)?.outsideTemp ?? null;
  const chargingState = live?.chargingState ?? data?.chargingState ?? null;
  const vehicleState = live?.state ?? data?.vehicleState ?? null;
  const power: number | null = (data as any)?.power ?? null;
  const lastUpdate = live?.timestamp ?? data?.lastUpdate ?? null;

  const isCharging = (chargingState ?? '').toLowerCase() === 'charging'
    || (vehicleState ?? '').toLowerCase() === 'charging';
  const isDriving = (vehicleState ?? '').toLowerCase() === 'driving';
  const isOnline = connected || ((data as any)?.dataFreshnessSec != null && (data as any).dataFreshnessSec < 120);

  const v = vehiclesQuery.data?.find((x) => x.id === vehicleId);
  const vehicleName = v?.displayName ?? v?.model ?? 'Vehicle';

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([statusQuery.refetch(), vehiclesQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [statusQuery, vehiclesQuery]);

  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceUpdate((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const dotColor = isCharging ? colors.primary : isDriving ? colors.green : colors.textMuted;
  const gradColors: [string, string] = isCharging
    ? ['#1e3a5f', '#111217']
    : isDriving
      ? ['#1a3a2a', '#111217']
      : ['#1A1C23', '#111217'];

  return (
    <ScrollView
      style={[styles.screen, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          tintColor={colors.primary}
          colors={[colors.primary]}
        />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>EVPulse</Text>
          <Text style={styles.title}>{vehicleName}</Text>
        </View>
        <View style={styles.liveRow}>
          <PulsingDot color={isOnline ? dotColor : colors.textMuted} />
          <Text style={[styles.liveText, { color: isOnline ? dotColor : colors.textMuted }]}>
            {isOnline ? stateLabel(vehicleState) : 'Offline'}
          </Text>
        </View>
      </View>

      {/* Hero battery card */}
      <LinearGradient colors={gradColors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.heroCard}>
        <View style={styles.heroTop}>
          <Text style={styles.heroLabel}>Battery</Text>
          {isCharging && power != null && power > 0 && (
            <View style={styles.powerBadge}>
              <Text style={styles.powerBadgeText}>⚡ {power.toFixed(1)} kW</Text>
            </View>
          )}
        </View>
        <Text style={styles.heroValue}>{Math.round(Number(battery))}%</Text>
        <BatteryBar pct={Number(battery)} charging={isCharging} />
        <Text style={styles.heroMeta}>
          {Math.round(Number(range))} km range
          {isCharging ? ' · Charging' : ''}
        </Text>
      </LinearGradient>

      {/* Metric grid */}
      <View style={styles.grid}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Range</Text>
          <Text style={styles.cardValue}>{Math.round(Number(range))} km</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Outside</Text>
          <Text style={styles.cardValue}>
            {outsideTemp != null ? `${Math.round(Number(outsideTemp))}°C` : '—'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>State</Text>
          <Text style={[styles.cardValue, { color: stateColor(vehicleState), fontSize: 16 }]}>
            {stateLabel(vehicleState)}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Updated</Text>
          <Text style={styles.cardValue}>
            {timeAgo(lastUpdate)}
          </Text>
        </View>

        {isCharging && power != null && (
          <View style={[styles.card, styles.cardWide]}>
            <Text style={styles.cardLabel}>Charging power</Text>
            <Text style={[styles.cardValue, { color: colors.primary }]}>
              {power > 0 ? `${power.toFixed(1)} kW` : 'Idle'}
            </Text>
          </View>
        )}
      </View>

      {statusQuery.isError && (
        <Text style={styles.errorHint}>Could not load status — pull to retry</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl + 16 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingTop: spacing.sm,
  },
  eyebrow: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  title: { ...typography.h1, color: colors.textPrimary, marginTop: 2 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  liveText: { fontSize: 13, fontWeight: '600' },
  heroCard: {
    borderRadius: radius.xl,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heroLabel: { color: colors.textSecondary, fontSize: 14, fontWeight: '500' },
  powerBadge: {
    backgroundColor: `${colors.primary}22`,
    borderColor: `${colors.primary}44`,
    borderWidth: 1,
    borderRadius: 99,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  powerBadgeText: { color: colors.primary, fontSize: 12, fontWeight: '600' },
  heroValue: { color: colors.textPrimary, fontSize: 52, fontWeight: '700', lineHeight: 60 },
  batteryWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  batteryTrack: {
    flex: 1,
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 99,
    overflow: 'hidden',
  },
  batteryFill: { height: '100%', borderRadius: 99 },
  batteryPct: { fontSize: 13, fontWeight: '600', minWidth: 38, textAlign: 'right' },
  heroMeta: { color: colors.cyan, fontSize: 14, marginTop: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  card: {
    width: '47.5%',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 6,
  },
  cardWide: { width: '100%' },
  cardLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardValue: { color: colors.textPrimary, fontSize: 20, fontWeight: '600' },
  errorHint: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
});
