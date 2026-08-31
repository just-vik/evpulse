import { useCallback, useState } from 'react';
import {
  ScrollView,
  Text,
  View,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LineChart } from 'react-native-gifted-charts';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { colors, spacing, radius, typography } from '@/theme/tokens';
import { useVehicleSummary } from '@/features/vehicles/useVehicleSummary';

interface DegradationPayload {
  data: { timestamp: string; sohPercent: number }[];
  samples: number;
  degradationPerMonth: number;
}

interface HealthPayload {
  sohPercent: number;
  degradationPercent: number;
  estimatedCapacityKwh: number;
  originalCapacityKwh?: number | null;
}

interface TripRow {
  efficiencyWhkm: number | null;
  distanceKm: number | null;
  startTime: string;
}

interface ChargingSession {
  energyAddedKwh: number | null;
  startTime: string;
  endTime: string | null;
}

function MetricRow({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <View style={styles.metricRight}>
        <Text style={[styles.metricVal, color ? { color } : {}]}>{value}</Text>
        {unit && <Text style={styles.metricUnit}>{unit}</Text>}
      </View>
    </View>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

export default function AnalyticsScreen() {
  const insets = useSafeAreaInsets();
  const { vehicleId } = useVehicleSummary();
  const [refreshing, setRefreshing] = useState(false);

  const deg = useQuery({
    queryKey: ['battery-degradation', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<DegradationPayload | null>(
        `/battery/${vehicleId}/degradation?days=365`,
      );
      return data;
    },
    enabled: !!vehicleId,
  });

  const health = useQuery({
    queryKey: ['battery-health', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<HealthPayload>(`/battery/${vehicleId}/health`);
      return data;
    },
    enabled: !!vehicleId,
  });

  const trips = useQuery({
    queryKey: ['trips-analytics', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<{ data: TripRow[] }>(
        `/trips/vehicle/${vehicleId}?limit=30`,
      );
      return data.data;
    },
    enabled: !!vehicleId,
  });

  const charging = useQuery({
    queryKey: ['charging-analytics', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<{ data: ChargingSession[] }>(
        `/charging/vehicle/${vehicleId}/sessions?limit=30`,
      );
      return data.data;
    },
    enabled: !!vehicleId,
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([deg.refetch(), health.refetch(), trips.refetch(), charging.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [deg, health, trips, charging]);

  const sohLineData = (deg.data?.data ?? []).map((p, i) => ({
    value: Math.min(100, Math.max(0, p.sohPercent)),
    label: i % 4 === 0 ? String(i + 1) : '',
  }));

  // Trips analytics
  const tripsList = trips.data ?? [];
  const totalKm = tripsList.reduce((s, t) => s + (t.distanceKm ?? 0), 0);
  const efficiencies = tripsList.filter((t) => t.efficiencyWhkm != null).map((t) => t.efficiencyWhkm!);
  const avgEff = efficiencies.length ? efficiencies.reduce((s, e) => s + e, 0) / efficiencies.length : null;
  const bestEff = efficiencies.length ? Math.min(...efficiencies) : null;

  // Charging analytics
  const chargedSessions = (charging.data ?? []).filter((s) => s.endTime != null);
  const totalKwh = chargedSessions.reduce((s, c) => s + (c.energyAddedKwh != null ? Number(c.energyAddedKwh) : 0), 0);
  const avgKwh = chargedSessions.length ? totalKwh / chargedSessions.length : null;

  // Efficiency over recent trips chart
  const effLineData = efficiencies.slice(-20).map((v, i) => ({
    value: Math.round(v),
    label: i % 5 === 0 ? String(i + 1) : '',
  }));

  const isLoading = deg.isPending || health.isPending;

  if (!vehicleId) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <Text style={styles.muted}>No vehicle selected.</Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

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
      <Text style={styles.title}>Analytics</Text>
      <Text style={styles.subtitle}>Battery · Efficiency · Charging</Text>

      {/* Battery Health */}
      <SectionCard title="Battery Health">
        {health.data ? (
          <>
            <MetricRow
              label="State of Health"
              value={health.data.sohPercent.toFixed(1)}
              unit="%"
              color={health.data.sohPercent > 90 ? colors.green : health.data.sohPercent > 80 ? colors.warning : colors.danger}
            />
            <MetricRow
              label="Capacity loss"
              value={health.data.degradationPercent.toFixed(1)}
              unit="%"
              color={health.data.degradationPercent < 5 ? colors.green : health.data.degradationPercent < 10 ? colors.warning : colors.danger}
            />
            <MetricRow
              label="Est. capacity"
              value={health.data.estimatedCapacityKwh.toFixed(1)}
              unit="kWh"
            />
            {health.data.originalCapacityKwh && (
              <MetricRow
                label="Original capacity"
                value={health.data.originalCapacityKwh.toFixed(1)}
                unit="kWh"
              />
            )}
          </>
        ) : (
          <Text style={styles.muted}>No health data available.</Text>
        )}
      </SectionCard>

      {/* SOH Trend Chart */}
      {sohLineData.length > 1 && (
        <SectionCard title={`SOH Trend  ·  ${deg.data?.samples ?? 0} samples`}>
          <LineChart
            data={sohLineData}
            height={160}
            spacing={Math.max(16, 320 / sohLineData.length)}
            thickness={2}
            color={colors.purple}
            hideRules
            xAxisColor={colors.border}
            yAxisColor={colors.border}
            yAxisTextStyle={{ color: colors.textSecondary, fontSize: 9 }}
            xAxisLabelTextStyle={{ color: colors.textSecondary, fontSize: 9 }}
            curved
            areaChart
            startFillColor={colors.purple}
            endFillColor="transparent"
            startOpacity={0.3}
            endOpacity={0.02}
          />
          {deg.data && (
            <Text style={styles.caption}>
              ~{Math.abs(deg.data.degradationPerMonth).toFixed(3)}% degradation/month
            </Text>
          )}
        </SectionCard>
      )}

      {/* Efficiency */}
      {tripsList.length > 0 && (
        <SectionCard title="Driving Efficiency">
          <MetricRow
            label="Average"
            value={avgEff != null ? Math.round(avgEff).toString() : '—'}
            unit="Wh/km"
            color={avgEff != null ? (avgEff < 180 ? colors.green : avgEff < 230 ? colors.warning : colors.danger) : undefined}
          />
          {bestEff != null && (
            <MetricRow label="Best session" value={Math.round(bestEff).toString()} unit="Wh/km" color={colors.green} />
          )}
          <MetricRow label="Total driven" value={Math.round(totalKm).toString()} unit="km" />
          <MetricRow label="Trips analysed" value={tripsList.length.toString()} />
          {effLineData.length > 1 && (
            <View style={{ marginTop: spacing.sm }}>
              <Text style={[styles.caption, { marginBottom: spacing.xs }]}>Efficiency trend (recent trips)</Text>
              <LineChart
                data={effLineData}
                height={100}
                spacing={Math.max(16, 280 / effLineData.length)}
                thickness={2}
                color={colors.cyan}
                hideRules
                xAxisColor={colors.border}
                yAxisColor={colors.border}
                yAxisTextStyle={{ color: colors.textSecondary, fontSize: 9 }}
                xAxisLabelTextStyle={{ color: colors.textSecondary, fontSize: 9 }}
                curved
                areaChart
                startFillColor={colors.cyan}
                endFillColor="transparent"
                startOpacity={0.25}
                endOpacity={0.02}
              />
            </View>
          )}
        </SectionCard>
      )}

      {/* Charging stats */}
      {chargedSessions.length > 0 && (
        <SectionCard title="Charging Stats">
          <MetricRow label="Total energy charged" value={totalKwh.toFixed(1)} unit="kWh" color={colors.primary} />
          {avgKwh != null && (
            <MetricRow label="Avg per session" value={avgKwh.toFixed(1)} unit="kWh" />
          )}
          <MetricRow label="Sessions" value={chargedSessions.length.toString()} />
        </SectionCard>
      )}

      {deg.isError && health.isError && (
        <Text style={[styles.muted, { textAlign: 'center' }]}>Failed to load analytics — pull to retry</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl + 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background, padding: spacing.lg },
  title: { ...typography.h1, color: colors.textPrimary },
  subtitle: { color: colors.textSecondary, fontSize: 14, marginTop: -spacing.sm },

  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '700', marginBottom: 2 },

  metricRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 },
  metricLabel: { color: colors.textSecondary, fontSize: 14 },
  metricRight: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  metricVal: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  metricUnit: { color: colors.textMuted, fontSize: 12 },

  caption: { color: colors.textMuted, fontSize: 12 },
  muted: { color: colors.textSecondary, fontSize: 14 },
});
