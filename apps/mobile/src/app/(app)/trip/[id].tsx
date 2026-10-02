import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import MapView, { Polyline } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@/services/api';
import { color, radius, space, type as tType } from '@/theme/tokens';
import { useScreenInsets } from '@/components/layout/Screen';
import { Card } from '@/components/ui/Card';
import { StatusChip, type StatusTone } from '@/components/ui/StatusChip';
import { LoadingSkeleton } from '@/components/ui/LoadingSkeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { formatDateLabel } from '@/i18n/format';
import { decodePolylineToCoords } from '@/lib/decodePolyline';
import {
  type TripPointsResponse,
  speedChartData,
  powerChartData,
  elevationChartData,
  socChartData,
} from '@/lib/tripTelemetry';
import { TripStat } from '@/components/trips/TripStat';
import { TripTelemetryChart } from '@/components/trips/TripTelemetryChart';

/** GET /trips/:tripId/quality — real endpoint (apps/api/src/trips/trips.controller.ts). */
interface TripQuality {
  tripId: string;
  score: number | null;
  reliability: string | null;
  severity: 'ok' | 'warning' | 'repaired' | 'degraded';
  issues: string[];
}

/**
 * TripStats, as passed through navigation params from (tabs)/trips.tsx — the backend's
 * TripStats row (trip.stats, included by GET /trips/vehicle/:vehicleId) via individual
 * scalar route params rather than a fetch-by-id, since there's no GET /trips/:id yet.
 * Temporary: once a canonical detail endpoint exists, fetch this directly by tripId
 * instead of depending on what the list screen happened to pass through.
 */
interface TripStats {
  avgSpeed: number | null;
  maxSpeed: number | null;
  regenEnergyKwh: number | null;
  elevationGain: number | null;
  drivingStyle: string | null;
  trafficStopRatio: number | null;
}

const SEVERITY_TONE: Record<TripQuality['severity'], StatusTone> = {
  ok: 'success',
  warning: 'warning',
  repaired: 'neutral',
  // 'degraded' still reads as warning, not danger — low/degraded confidence
  // is "approximate," not a fault (tokens doc §2.5 rule).
  degraded: 'warning',
};

export default function TripDetailScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { paddingTop, paddingBottom } = useScreenInsets();
  const params = useLocalSearchParams<{
    id: string;
    startTime: string;
    endTime: string;
    distanceKm: string;
    efficiencyWhkm: string;
    durationMin: string;
    polyline: string;
    startLocation: string;
    endLocation: string;
    startSoc: string;
    endSoc: string;
    avgSpeed: string;
    maxSpeed: string;
    regenEnergyKwh: string;
    elevationGain: string;
    trafficStopRatio: string;
    drivingStyle: string;
  }>();

  const distanceKm = params.distanceKm ? Number(params.distanceKm) : null;
  const efficiencyWhkm = params.efficiencyWhkm ? Number(params.efficiencyWhkm) : null;
  const startSoc = params.startSoc ? Number(params.startSoc) : null;
  const endSoc = params.endSoc ? Number(params.endSoc) : null;

  // trip.stats, as passed through navigation params — see TripStats doc comment above.
  // Not rendered in this commit; wired up so the next (UI) commit has it available.
  const stats: TripStats = useMemo(
    () => ({
      avgSpeed: params.avgSpeed ? Number(params.avgSpeed) : null,
      maxSpeed: params.maxSpeed ? Number(params.maxSpeed) : null,
      regenEnergyKwh: params.regenEnergyKwh ? Number(params.regenEnergyKwh) : null,
      elevationGain: params.elevationGain ? Number(params.elevationGain) : null,
      trafficStopRatio: params.trafficStopRatio ? Number(params.trafficStopRatio) : null,
      drivingStyle: params.drivingStyle || null,
    }),
    [params.avgSpeed, params.maxSpeed, params.regenEnergyKwh, params.elevationGain, params.trafficStopRatio, params.drivingStyle],
  );

  const coords = useMemo(() => decodePolylineToCoords(params.polyline || null), [params.polyline]);
  const region = useMemo(() => {
    if (!coords.length) {
      return { latitude: 52.52, longitude: 13.405, latitudeDelta: 0.2, longitudeDelta: 0.2 };
    }
    const lats = coords.map((c) => c.latitude);
    const lngs = coords.map((c) => c.longitude);
    const latMin = Math.min(...lats);
    const latMax = Math.max(...lats);
    const lngMin = Math.min(...lngs);
    const lngMax = Math.max(...lngs);
    return {
      latitude: (latMin + latMax) / 2,
      longitude: (lngMin + lngMax) / 2,
      latitudeDelta: Math.max(0.01, (latMax - latMin) * 1.6),
      longitudeDelta: Math.max(0.01, (lngMax - lngMin) * 1.6),
    };
  }, [coords]);

  const qualityQuery = useQuery({
    queryKey: ['trip-quality', params.id],
    queryFn: async () => {
      const { data } = await api.get<TripQuality>(`/trips/${params.id}/quality`);
      return data;
    },
    enabled: !!params.id,
  });

  // Kept independent from qualityQuery (not Promise.all) on purpose: these two
  // endpoints have unrelated failure modes, and quality must keep rendering even
  // when points are temporarily unavailable (or vice versa).
  //
  // The map still renders from decodePolylineToCoords(params.polyline) above, NOT
  // from these points — a server-side map-matched route and raw per-sample telemetry
  // are different things, and swapping the map's coordinate source is a separate
  // decision for later (once point density/quality across real trips has been
  // checked), not a side effect of wiring up the telemetry charts below.
  const pointsQuery = useQuery({
    queryKey: ['trip-points', params.id],
    queryFn: async () => {
      const { data } = await api.get<TripPointsResponse>(`/trips/${params.id}/points`);
      return data;
    },
    enabled: !!params.id,
  });
  const points = pointsQuery.data?.points ?? [];

  // Pure transforms (filter valid + downsample for the chart) — see
  // src/lib/tripTelemetry.ts. None of this recomputes or reinterprets a value; it's
  // strictly "which of the canonical /points samples get a dot on this chart."
  const speedData = useMemo(() => speedChartData(points), [points]);
  const powerData = useMemo(() => powerChartData(points), [points]);
  const elevationData = useMemo(() => elevationChartData(points), [points]);
  const socData = useMemo(() => socChartData(points), [points]);

  const duration = (() => {
    const mins = params.durationMin
      ? Math.round(Number(params.durationMin))
      : params.endTime
        ? Math.round((new Date(params.endTime).getTime() - new Date(params.startTime).getTime()) / 60_000)
        : null;
    if (mins == null) return '—';
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  })();

  const title =
    params.startLocation && params.endLocation
      ? `${params.startLocation} → ${params.endLocation}`
      : formatDateLabel(params.startTime);

  return (
    <ScrollView
      style={[styles.screen, { paddingTop }]}
      contentContainerStyle={[styles.content, { paddingBottom }]}
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={color.text.primary} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      </View>

      {coords.length > 1 && (
        <View style={styles.mapWrap}>
          <MapView
            style={styles.map}
            initialRegion={region}
            region={region}
            scrollEnabled={false}
            zoomEnabled={false}
          >
            <Polyline coordinates={coords} strokeColor={color.brand.teal300} strokeWidth={4} />
          </MapView>
        </View>
      )}

      <Card>
        <Text style={styles.statLine}>
          {distanceKm != null ? `${distanceKm.toFixed(1)} km` : '—'} · {duration}
          {efficiencyWhkm != null ? ` · ${Math.round(efficiencyWhkm)} Wh/km` : ''}
        </Text>
        {startSoc != null && (
          <Text style={styles.statLine}>
            {t('drive.tripDetail.batteryUsed', {
              start: Math.round(startSoc),
              end: endSoc != null ? Math.round(endSoc) : '—',
            })}
          </Text>
        )}
      </Card>

      <Card>
        {qualityQuery.isPending ? (
          <LoadingSkeleton variant="row" height={40} />
        ) : qualityQuery.isError ? (
          <ErrorState compact message={t('drive.tripDetail.errorQuality')} onRetry={() => qualityQuery.refetch()} />
        ) : qualityQuery.data ? (
          <>
            <View style={styles.qualityRow}>
              <StatusChip
                label={t(`drive.tripDetail.severity.${qualityQuery.data.severity}`)}
                tone={SEVERITY_TONE[qualityQuery.data.severity]}
              />
            </View>
            <Text style={styles.qualityText}>
              {qualityQuery.data.severity === 'ok'
                ? t('drive.tripDetail.qualityGood')
                : t(`drive.tripDetail.qualityMessage.${qualityQuery.data.severity}`)}
            </Text>
          </>
        ) : null}
      </Card>

      {pointsQuery.isPending ? (
        <Card>
          <LoadingSkeleton variant="chart" height={120} />
        </Card>
      ) : pointsQuery.isError ? (
        <Card>
          <ErrorState
            compact
            message={t('drive.tripDetail.errorTelemetry')}
            onRetry={() => pointsQuery.refetch()}
          />
        </Card>
      ) : (
        <>
          <Card>
            <Text style={styles.sectionTitle}>{t('drive.tripDetail.speed')}</Text>
            <View style={styles.statRow}>
              <TripStat
                label={t('drive.tripDetail.avg')}
                value={stats.avgSpeed != null ? Math.round(stats.avgSpeed).toString() : '—'}
                unit="km/h"
              />
              <TripStat
                label={t('drive.tripDetail.max')}
                value={stats.maxSpeed != null ? Math.round(stats.maxSpeed).toString() : '—'}
                unit="km/h"
              />
            </View>
            <TripTelemetryChart
              data={speedData}
              unit="km/h"
              lineColor={color.brand.teal400}
              emptyLabel={t('drive.tripDetail.noSpeedData')}
            />
          </Card>

          <Card>
            <Text style={styles.sectionTitle}>{t('drive.tripDetail.elevation')}</Text>
            <TripStat
              label={t('drive.tripDetail.elevationGain')}
              value={stats.elevationGain != null ? Math.round(stats.elevationGain).toString() : '—'}
              unit="m"
            />
            <TripTelemetryChart
              data={elevationData}
              unit="m"
              lineColor={color.semantic.info}
              emptyLabel={t('drive.tripDetail.noElevationData')}
            />
          </Card>

          <Card>
            <TripTelemetryChart
              title={t('drive.tripDetail.power')}
              data={powerData}
              unit="kW"
              lineColor={color.brand.teal300}
              emptyLabel={t('drive.tripDetail.noPowerData')}
            />
          </Card>

          <Card>
            <TripTelemetryChart
              title={t('home.battery')}
              data={socData}
              unit="%"
              lineColor={color.semantic.success}
              emptyLabel={t('drive.tripDetail.noSocData')}
              maxValue={100}
              yAxisOffset={0}
            />
          </Card>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg.app },
  content: { paddingHorizontal: space.md, gap: space.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.sm },
  backBtn: { padding: space.xs, marginLeft: -space.xs, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  title: { ...tType.h3, color: color.text.primary, flex: 1 },
  mapWrap: { borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: color.border.subtle },
  map: { width: '100%', height: 220 },
  statLine: { ...tType.body, color: color.text.primary, fontVariant: ['tabular-nums'] },
  qualityRow: { flexDirection: 'row' },
  qualityText: { ...tType.caption, color: color.text.secondary },
  // Card.base already applies `gap: space.sm` between direct children — no margin needed here.
  sectionTitle: { ...tType.bodyStrong, color: color.text.primary },
  statRow: { flexDirection: 'row', gap: space.md },
});
