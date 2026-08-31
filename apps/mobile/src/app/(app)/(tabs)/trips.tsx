import { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, FlatList, RefreshControl, useWindowDimensions } from 'react-native';
import MapView, { Polyline } from 'react-native-maps';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { api } from '@/services/api';
import { color, radius, space, type as tType } from '@/theme/tokens';
import { Screen, useScreenInsets } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatusChip } from '@/components/ui/StatusChip';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingSkeleton } from '@/components/ui/LoadingSkeleton';
import { formatDateLabel } from '@/i18n/format';
import { useVehicleSummary } from '@/features/vehicles/useVehicleSummary';
import { decodePolylineToCoords } from '@/lib/decodePolyline';

/** Real Trip fields (apps/api/prisma/schema.prisma `model Trip`) — `reliability`
 *  is 'HIGH'|'MEDIUM'|'LOW'|null, `qualityScore` is 0-100 or null. There is
 *  NO start/end temperature field anywhere on Trip and no `startBattery`/
 *  `endBattery` — only `startSoc`/`endSoc` exist; those other names were a
 *  dead legacy type on the web side, not real API fields. */
interface TripRow {
  id: string;
  startTime: string;
  endTime: string | null;
  distanceKm: number | null;
  efficiencyWhkm: number | null;
  durationMin?: number | null;
  polyline: string | null;
  startLocation: string | null;
  endLocation: string | null;
  startSoc: number | null;
  endSoc: number | null;
  qualityScore: number | null;
  reliability: 'HIGH' | 'MEDIUM' | 'LOW' | null;
}

type DateFilter = 'all' | '7d' | '30d' | '90d';
const DATE_FILTERS: DateFilter[] = ['all', '7d', '30d', '90d'];

// Legacy fallback only — used when a trip predates the reliability field
// (null). Mirrors web's own insight engine's distanceKm>2 floor; not a
// fabricated server-side confidence value.
const MIN_RELIABLE_DISTANCE_KM = 2;
const MIN_PLAUSIBLE_WH_KM = 50;
const MAX_PLAUSIBLE_WH_KM = 600;

function isQualityLimitedHeuristic(trip: TripRow): boolean {
  if (trip.efficiencyWhkm == null) return false;
  if (trip.distanceKm == null || trip.distanceKm < MIN_RELIABLE_DISTANCE_KM) return true;
  if (trip.efficiencyWhkm < MIN_PLAUSIBLE_WH_KM || trip.efficiencyWhkm > MAX_PLAUSIBLE_WH_KM) return true;
  return false;
}

/** `reliability` is a real backend field, but it measures GPS/data-collection
 *  confidence — it does NOT by itself mean a trip's Wh/km figure is
 *  statistically meaningful. A short-but-perfectly-tracked trip can still
 *  report `reliability: 'HIGH'` while its efficiency number is noise (tiny
 *  distance, regen spikes dominate). So the plausibility/minimum-distance
 *  heuristic is always applied, in addition to (not instead of) the real
 *  reliability flag. */
function isLowReliability(trip: TripRow): boolean {
  if (trip.reliability === 'LOW') return true;
  return isQualityLimitedHeuristic(trip);
}

function formatDuration(startIso: string, endIso: string | null, durationMin?: number | null): string {
  const mins =
    durationMin != null
      ? Math.round(durationMin)
      : endIso
        ? Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000)
        : null;
  if (mins == null) return '—';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function efficiencyColor(wh: number | null): string {
  if (wh == null) return color.text.secondary;
  if (wh < 150) return color.semantic.success;
  if (wh < 200) return color.brand.teal400;
  if (wh < 250) return color.semantic.warning;
  return color.semantic.danger;
}

function TripItem({ trip, eco, good, avg, high, dataQualityLimited, onPress }: {
  trip: TripRow;
  eco: string;
  good: string;
  avg: string;
  high: string;
  dataQualityLimited: string;
  onPress: () => void;
}) {
  const duration = formatDuration(trip.startTime, trip.endTime, trip.durationMin);
  const limited = isLowReliability(trip);
  const eColor = limited ? color.text.tertiary : efficiencyColor(trip.efficiencyWhkm);

  const effLabel = (() => {
    if (limited) return dataQualityLimited;
    if (trip.efficiencyWhkm == null) return '—';
    if (trip.efficiencyWhkm < 150) return eco;
    if (trip.efficiencyWhkm < 200) return good;
    if (trip.efficiencyWhkm < 250) return avg;
    return high;
  })();

  return (
    <Pressable style={styles.row} onPress={onPress} accessibilityRole="button">
      <View style={styles.rowHeader}>
        <Text style={styles.rowTime}>{formatDateLabel(trip.startTime)}</Text>
        {trip.efficiencyWhkm != null && (
          <StatusChip label={effLabel} tintColor={eColor} />
        )}
      </View>

      <View style={styles.rowStats}>
        {trip.distanceKm != null && (
          <Text style={styles.statPrimary}>{trip.distanceKm.toFixed(1)} km</Text>
        )}
        <Text style={styles.statSep}>·</Text>
        <Text style={styles.statSecondary}>{duration}</Text>
        {trip.efficiencyWhkm != null && (
          <>
            <Text style={styles.statSep}>·</Text>
            <Text style={[styles.statSecondary, { color: eColor }]}>
              {Math.round(trip.efficiencyWhkm)} Wh/km
            </Text>
          </>
        )}
      </View>

      {(trip.startLocation || trip.endLocation) && (
        <View style={styles.locations}>
          {trip.startLocation && (
            <Text style={styles.locationText} numberOfLines={1}>
              🟢 {trip.startLocation}
            </Text>
          )}
          {trip.endLocation && (
            <Text style={styles.locationText} numberOfLines={1}>
              🔴 {trip.endLocation}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );
}

export default function TripsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { paddingBottom } = useScreenInsets();
  const { vehicleId } = useVehicleSummary();
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<DateFilter>('all');
  const { width: windowWidth } = useWindowDimensions();

  // Real query params (GET /trips/vehicle/:id?from=&to=), server-side date filter.
  const dateRange = useMemo(() => {
    if (filter === 'all') return null;
    const days = filter === '7d' ? 7 : filter === '30d' ? 30 : 90;
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [filter]);

  const tripsQuery = useQuery({
    queryKey: ['trips', vehicleId, filter],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '50' });
      if (dateRange) {
        params.set('from', dateRange.from);
        params.set('to', dateRange.to);
      }
      const { data } = await api.get<{ data: TripRow[] }>(
        `/trips/vehicle/${vehicleId}?${params.toString()}`,
      );
      return data.data;
    },
    enabled: !!vehicleId,
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await tripsQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [tripsQuery]);

  const previewTrip = tripsQuery.data?.find((tr) => tr.polyline);
  const coords = useMemo(() => decodePolylineToCoords(previewTrip?.polyline), [previewTrip?.polyline]);

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
      latitudeDelta: Math.max(0.02, (latMax - latMin) * 1.8),
      longitudeDelta: Math.max(0.02, (lngMax - lngMin) * 1.8),
    };
  }, [coords]);

  const totalKm = (tripsQuery.data ?? []).reduce((s, tr) => s + (tr.distanceKm ?? 0), 0);
  const avgEff = (() => {
    // Low-reliability trips are excluded from the aggregate so one bad trip
    // can't skew "avg efficiency" — they still appear, labeled, in the list.
    const reliable = (tripsQuery.data ?? []).filter(
      (tr) => tr.efficiencyWhkm != null && !isLowReliability(tr),
    );
    if (!reliable.length) return null;
    return reliable.reduce((s, tr) => s + Number(tr.efficiencyWhkm), 0) / reliable.length;
  })();

  const mapW = windowWidth - space.md * 2;

  if (!vehicleId) {
    return (
      <Screen scrollable={false}>
        <ScreenHeader title={t('drive.title')} />
        <EmptyState icon="car-outline" title={t('drive.noVehicle')} />
      </Screen>
    );
  }

  if (tripsQuery.isPending) {
    return (
      <Screen scrollable={false}>
        <ScreenHeader title={t('drive.title')} subtitle={t('drive.subtitle')} />
        <View style={{ paddingHorizontal: space.md, gap: space.sm }}>
          <LoadingSkeleton variant="chart" height={200} />
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
        data={tripsQuery.data ?? []}
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
            <ScreenHeader title={t('drive.title')} subtitle={t('drive.subtitle')} />

            {coords.length > 1 && (
              <View style={styles.mapWrap}>
                <MapView
                  style={{ width: mapW, height: 200 }}
                  initialRegion={region}
                  region={region}
                  scrollEnabled={false}
                  zoomEnabled={false}
                >
                  <Polyline coordinates={coords} strokeColor={color.brand.teal300} strokeWidth={4} />
                </MapView>
                {previewTrip && (
                  <LinearGradient
                    colors={['transparent', `${color.bg.app}f2`]}
                    style={styles.mapOverlay}
                    pointerEvents="none"
                  >
                    <Text style={styles.mapOverlayText} numberOfLines={2} ellipsizeMode="tail">
                      {previewTrip.startLocation ?? t('drive.latestTrip')}
                    </Text>
                  </LinearGradient>
                )}
              </View>
            )}

            <View style={styles.filterRow}>
              {DATE_FILTERS.map((f) => (
                <Pressable
                  key={f}
                  onPress={() => setFilter(f)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: filter === f }}
                >
                  <StatusChip label={t(`drive.filter.${f}`)} tone={filter === f ? 'brand' : 'neutral'} />
                </Pressable>
              ))}
            </View>

            {(tripsQuery.data?.length ?? 0) > 0 && (
              <View style={styles.statsRow}>
                <View style={styles.statItem}>
                  <Text style={styles.statValue}>{totalKm.toFixed(0)} km</Text>
                  <Text style={styles.statLabel}>{t('drive.total')}</Text>
                </View>
                {avgEff != null && (
                  <View style={styles.statItem}>
                    <Text style={[styles.statValue, { color: efficiencyColor(avgEff) }]}>
                      {Math.round(avgEff)} Wh/km
                    </Text>
                    <Text style={styles.statLabel}>{t('drive.avgEfficiency')}</Text>
                  </View>
                )}
                <View style={styles.statItem}>
                  <Text style={styles.statValue}>{tripsQuery.data?.length ?? 0}</Text>
                  <Text style={styles.statLabel}>{t('drive.trips')}</Text>
                </View>
              </View>
            )}

            {tripsQuery.isError && (
              <ErrorState compact message={t('drive.errorLoading')} onRetry={() => tripsQuery.refetch()} />
            )}

            {!tripsQuery.isError && (tripsQuery.data?.length ?? 0) > 0 && (
              <SectionHeader title={t('drive.history')} />
            )}
          </View>
        }
        ListEmptyComponent={
          !tripsQuery.isError ? <EmptyState icon="map-outline" title={t('drive.empty')} /> : null
        }
        renderItem={({ item }) => (
          <TripItem
            trip={item}
            eco={t('drive.eco')}
            good={t('drive.good')}
            avg={t('drive.avg')}
            high={t('drive.high')}
            dataQualityLimited={t('drive.dataQualityLimited')}
            onPress={() =>
              router.push({
                pathname: '/(app)/trip/[id]',
                params: {
                  id: item.id,
                  startTime: item.startTime,
                  endTime: item.endTime ?? '',
                  distanceKm: item.distanceKm != null ? String(item.distanceKm) : '',
                  efficiencyWhkm: item.efficiencyWhkm != null ? String(item.efficiencyWhkm) : '',
                  durationMin: item.durationMin != null ? String(item.durationMin) : '',
                  polyline: item.polyline ?? '',
                  startLocation: item.startLocation ?? '',
                  endLocation: item.endLocation ?? '',
                  startSoc: item.startSoc != null ? String(item.startSoc) : '',
                  endSoc: item.endSoc != null ? String(item.endSoc) : '',
                  reliability: item.reliability ?? '',
                },
              })
            }
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { paddingHorizontal: space.md, gap: space.sm },
  listHeader: { gap: space.md, marginBottom: space.sm },

  mapWrap: { borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: color.border.subtle },
  mapOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.md,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  mapOverlayText: { ...tType.caption, color: color.text.primary, fontWeight: '600' },

  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },

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
  rowTime: { color: color.text.primary, fontWeight: '600', fontSize: 14, flex: 1 },
  rowStats: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' },
  statPrimary: { color: color.brand.teal300, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  statSep: { color: color.text.tertiary, fontSize: 13 },
  statSecondary: { color: color.text.secondary, fontSize: 13 },
  locations: { gap: 2 },
  locationText: { color: color.text.tertiary, fontSize: 12 },
});
