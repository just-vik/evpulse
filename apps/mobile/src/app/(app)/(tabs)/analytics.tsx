import { useCallback, useState } from 'react';
import { ScrollView, Text, View, StyleSheet, RefreshControl } from 'react-native';
import { LineChart } from 'react-native-gifted-charts';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/services/api';
import { color, space, type as tType } from '@/theme/tokens';
import { Screen } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { Card } from '@/components/ui/Card';
import { StatusChip } from '@/components/ui/StatusChip';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingSkeleton } from '@/components/ui/LoadingSkeleton';
import { useVehicleSummary } from '@/features/vehicles/useVehicleSummary';

/**
 * GET /battery/:id/health — verified against
 * apps/api/src/battery/battery-analytics.service.ts `getBatteryHealth`.
 * Fields are optional where the "no health record yet" response omits them.
 * `baselineLockedAt` is intentionally NOT typed here — the backend computes
 * it as a local variable but never actually includes it in the response
 * (dead field server-side), despite web's older type claiming it exists.
 */
interface BatteryHealthPayload {
  vehicleId: string;
  sohPercent: number;
  sohRaw?: number;
  isEstimate?: boolean;
  dataQuality: 'learning' | 'ok' | 'high';
  chargesNeededForHighBaseline: number;
  qualifyingChargeSessions: number;
  estimatedCapacityKwh: number;
  nominalCapacityKwh: number;
  degradationPercent: number;
  method: string;
  confidenceScore: number;
  lowData: boolean;
  tripSoh?: number | null;
  chargingSoh?: number | null;
  ratedRangeSoh?: number | null;
  avgBatteryTempC?: number | null;
  baselineLocked: boolean;
  baselineConfidence: 'HIGH' | 'MEDIUM' | 'NONE';
  baselineHighKwh: number | null;
  baselineMediumKwh: number | null;
  baselineKwh: number | null;
  cycles: number | null;
  updatedAt: string | null;
}

/** GET /battery/:id/degradation — verified against the same service, `getDegradationTrend`. */
interface DegradationPayload {
  vehicleId: string;
  period: { startDate: string; endDate: string; days: number };
  samples: number;
  hasTrend: boolean;
  latestSoh: number;
  degradationPerMonth: number | null;
  data: { timestamp: string; sohPercent: number; confidence: number }[];
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

type ConfidenceLevel = 'high' | 'medium' | 'low';

function confidenceLevel(health: BatteryHealthPayload): ConfidenceLevel {
  if (health.lowData) return 'low';
  if (health.baselineConfidence === 'HIGH') return 'high';
  if (health.baselineConfidence === 'MEDIUM') return 'medium';
  if (health.confidenceScore >= 0.8) return 'high';
  if (health.confidenceScore >= 0.6) return 'medium';
  return 'low';
}

const CONFIDENCE_COLOR: Record<ConfidenceLevel, string> = {
  high: color.confidence.high,
  medium: color.confidence.medium,
  low: color.confidence.low,
};

function ConfidenceBadge({ level, t }: { level: ConfidenceLevel; t: (k: string) => string }) {
  return <StatusChip label={t(`confidence.${level}`)} tintColor={CONFIDENCE_COLOR[level]} />;
}

function MetricRow({
  label,
  value,
  unit,
  color: valueColor,
}: {
  label: string;
  value: string;
  unit?: string;
  color?: string;
}) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <View style={styles.metricRight}>
        <Text style={[styles.metricVal, valueColor ? { color: valueColor } : {}]}>{value}</Text>
        {unit && <Text style={styles.metricUnit}>{unit}</Text>}
      </View>
    </View>
  );
}

export default function AnalyticsScreen() {
  const { t } = useTranslation();
  const { vehicleId } = useVehicleSummary();
  const [refreshing, setRefreshing] = useState(false);

  const deg = useQuery({
    queryKey: ['battery-degradation', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<DegradationPayload | null>(`/battery/${vehicleId}/degradation?days=365`);
      return data;
    },
    enabled: !!vehicleId,
  });

  const health = useQuery({
    queryKey: ['battery-health', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<BatteryHealthPayload>(`/battery/${vehicleId}/health`);
      return data;
    },
    enabled: !!vehicleId,
  });

  const trips = useQuery({
    queryKey: ['trips-analytics', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<{ data: TripRow[] }>(`/trips/vehicle/${vehicleId}?limit=30`);
      return data.data;
    },
    enabled: !!vehicleId,
  });

  const charging = useQuery({
    queryKey: ['charging-analytics', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<{ data: ChargingSession[] }>(`/charging/vehicle/${vehicleId}/sessions?limit=30`);
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

  // Only render a trend line when the backend itself says there's a real
  // trend and the health record isn't flagged low-data — never smooth a
  // curve over data the source itself doesn't trust.
  const showSohChart = !!deg.data?.hasTrend && (deg.data?.data.length ?? 0) > 1 && !health.data?.lowData;
  const sohLineData = (deg.data?.data ?? []).map((p, i) => ({
    value: Math.min(100, Math.max(0, p.sohPercent)),
    label: i % 4 === 0 ? String(i + 1) : '',
  }));

  const tripsList = trips.data ?? [];
  const totalKm = tripsList.reduce((s, tr) => s + (tr.distanceKm ?? 0), 0);
  const efficiencies = tripsList.filter((tr) => tr.efficiencyWhkm != null).map((tr) => tr.efficiencyWhkm!);
  const avgEff = efficiencies.length ? efficiencies.reduce((s, e) => s + e, 0) / efficiencies.length : null;
  const bestEff = efficiencies.length ? Math.min(...efficiencies) : null;

  const chargedSessions = (charging.data ?? []).filter((s) => s.endTime != null);
  const totalKwh = chargedSessions.reduce((s, c) => s + (c.energyAddedKwh != null ? Number(c.energyAddedKwh) : 0), 0);
  const avgKwh = chargedSessions.length ? totalKwh / chargedSessions.length : null;

  const effLineData = efficiencies.slice(-20).map((v, i) => ({
    value: Math.round(v),
    label: i % 5 === 0 ? String(i + 1) : '',
  }));

  if (!vehicleId) {
    return (
      <Screen>
        <ScreenHeader title={t('insights.title')} />
        <EmptyState icon="bulb-outline" title={t('insights.noVehicle')} />
      </Screen>
    );
  }

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
      header={<ScreenHeader title={t('insights.title')} subtitle={t('insights.subtitle')} />}
    >
      {/* Battery Health */}
      <Card>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>{t('insights.batteryHealth')}</Text>
          {health.data && <ConfidenceBadge level={confidenceLevel(health.data)} t={t} />}
        </View>
        {health.isPending ? (
          <LoadingSkeleton variant="row" height={70} />
        ) : health.isError ? (
          <ErrorState compact message={t('insights.errorHealth')} onRetry={() => health.refetch()} />
        ) : health.data ? (
          (() => {
            const h = health.data;
            // dataQuality === 'learning' means no baseline is locked yet — the
            // SoH/degradation/capacity numbers below are provisional, derived
            // from whatever charging sessions have been seen so far. lowData
            // means confidence is too low even for a provisional number.
            const isCalibrating = h.dataQuality === 'learning';
            const isLowData     = h.lowData;
            const tilde = (v: string) => (isCalibrating ? `~${v}` : v);
            // Degradation is a comparison against a baseline that doesn't exist
            // yet while calibrating — "~0.0%" would misleadingly read as "almost
            // no wear" rather than "not computed yet", so show it as pending
            // instead of a tilde-prefixed number (unlike SoH/capacity, which are
            // current-state readings and stay useful even before baseline).
            const isDegradationPending = isCalibrating && !isLowData;
            return (
              <>
                <MetricRow
                  label={t(isCalibrating ? 'insights.estStateOfHealth' : 'insights.stateOfHealth')}
                  value={isLowData ? '—' : tilde(h.sohPercent.toFixed(1))}
                  unit={isLowData ? '' : '%'}
                  color={
                    h.sohPercent > 90
                      ? color.semantic.success
                      : h.sohPercent > 80
                        ? color.semantic.warning
                        : color.semantic.danger
                  }
                />
                <MetricRow
                  label={t('insights.capacityLoss')}
                  value={isLowData ? '—' : isDegradationPending ? t('insights.pendingBaseline') : tilde(h.degradationPercent.toFixed(1))}
                  unit={isLowData || isDegradationPending ? '' : '%'}
                />
                <MetricRow
                  label={t('insights.estCapacity')}
                  value={isLowData ? '—' : tilde(h.estimatedCapacityKwh.toFixed(1))}
                  unit={isLowData ? '' : 'kWh'}
                />
                <MetricRow label={t('insights.nominalCapacity')} value={h.nominalCapacityKwh.toFixed(1)} unit="kWh" />
                <Text style={styles.caption}>
                  {t('insights.basedOnCycles', { count: h.cycles ?? h.qualifyingChargeSessions })}
                </Text>
                {isCalibrating && h.chargesNeededForHighBaseline > 0 && (
                  <Text style={styles.caption}>
                    {t('insights.needMoreChargesForBaseline', { count: h.chargesNeededForHighBaseline })}
                  </Text>
                )}
              </>
            );
          })()
        ) : (
          <Text style={styles.muted}>{t('insights.noHealthData')}</Text>
        )}
      </Card>

      {/* SOH Trend */}
      {deg.isPending ? (
        <Card>
          <LoadingSkeleton variant="chart" />
        </Card>
      ) : deg.isError ? (
        <Card>
          <ErrorState compact message={t('insights.errorDegradation')} onRetry={() => deg.refetch()} />
        </Card>
      ) : showSohChart ? (
        <Card>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>{t('insights.sohTrend')}</Text>
            <Text style={styles.caption}>{t('insights.samples', { count: deg.data?.samples ?? 0 })}</Text>
          </View>
          <LineChart
            data={sohLineData}
            height={160}
            spacing={Math.max(16, 320 / sohLineData.length)}
            thickness={2}
            color={color.brand.violet400}
            hideRules
            xAxisColor={color.border.subtle}
            yAxisColor={color.border.subtle}
            yAxisTextStyle={{ color: color.text.secondary, fontSize: tType.micro.fontSize }}
            xAxisLabelTextStyle={{ color: color.text.secondary, fontSize: tType.micro.fontSize }}
            curved
            areaChart
            startFillColor={color.brand.violet400}
            endFillColor="transparent"
            startOpacity={0.3}
            endOpacity={0.02}
          />
          {deg.data?.degradationPerMonth != null && (
            <Text style={styles.caption}>
              {t('insights.degradationPerMonth', { value: Math.abs(deg.data.degradationPerMonth).toFixed(3) })}
            </Text>
          )}
        </Card>
      ) : deg.data ? (
        <Card>
          <Text style={styles.cardTitle}>{t('insights.notEnoughData')}</Text>
          <Text style={styles.muted}>{t('insights.notEnoughDataBody')}</Text>
        </Card>
      ) : null}

      {/* Driving Efficiency */}
      {trips.isError ? (
        <Card>
          <ErrorState compact message={t('insights.errorTrips')} onRetry={() => trips.refetch()} />
        </Card>
      ) : trips.isPending ? (
        <Card>
          <LoadingSkeleton variant="row" height={90} />
        </Card>
      ) : tripsList.length > 0 ? (
        <Card>
          <Text style={styles.cardTitle}>{t('insights.drivingEfficiency')}</Text>
          <MetricRow
            label={t('insights.average')}
            value={avgEff != null ? Math.round(avgEff).toString() : '—'}
            unit="Wh/km"
            color={avgEff != null ? (avgEff < 180 ? color.semantic.success : avgEff < 230 ? color.semantic.warning : color.semantic.danger) : undefined}
          />
          {bestEff != null && (
            <MetricRow label={t('insights.bestSession')} value={Math.round(bestEff).toString()} unit="Wh/km" color={color.semantic.success} />
          )}
          <MetricRow label={t('insights.totalDriven')} value={Math.round(totalKm).toString()} unit="km" />
          <MetricRow label={t('insights.tripsAnalysed')} value={tripsList.length.toString()} />
          {effLineData.length > 1 && (
            <View style={{ marginTop: space.sm }}>
              <Text style={[styles.caption, { marginBottom: space.xs }]}>{t('insights.efficiencyTrend')}</Text>
              <LineChart
                data={effLineData}
                height={100}
                spacing={Math.max(16, 280 / effLineData.length)}
                thickness={2}
                color={color.brand.teal400}
                hideRules
                xAxisColor={color.border.subtle}
                yAxisColor={color.border.subtle}
                yAxisTextStyle={{ color: color.text.secondary, fontSize: tType.micro.fontSize }}
                xAxisLabelTextStyle={{ color: color.text.secondary, fontSize: tType.micro.fontSize }}
                curved
                areaChart
                startFillColor={color.brand.teal400}
                endFillColor="transparent"
                startOpacity={0.25}
                endOpacity={0.02}
              />
            </View>
          )}
        </Card>
      ) : null}

      {/* Charging Stats */}
      {charging.isError ? (
        <Card>
          <ErrorState compact message={t('insights.errorCharging')} onRetry={() => charging.refetch()} />
        </Card>
      ) : charging.isPending ? (
        <Card>
          <LoadingSkeleton variant="row" height={60} />
        </Card>
      ) : chargedSessions.length > 0 ? (
        <Card>
          <Text style={styles.cardTitle}>{t('insights.chargingStats')}</Text>
          <MetricRow label={t('insights.totalEnergyCharged')} value={totalKwh.toFixed(1)} unit="kWh" color={color.brand.teal400} />
          {avgKwh != null && <MetricRow label={t('insights.avgPerSession')} value={avgKwh.toFixed(1)} unit="kWh" />}
          <MetricRow label={t('charge.sessions')} value={chargedSessions.length.toString()} />
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  cardTitle: { color: color.text.primary, fontSize: 16, fontWeight: '700' },

  metricRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 },
  metricLabel: { color: color.text.secondary, fontSize: 14 },
  metricRight: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  metricVal: { color: color.text.primary, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  metricUnit: { color: color.text.tertiary, fontSize: 12 },

  caption: { color: color.text.tertiary, fontSize: 12 },
  muted: { color: color.text.secondary, fontSize: 14 },
});
