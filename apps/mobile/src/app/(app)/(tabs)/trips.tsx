import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Dimensions,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Polyline } from 'react-native-maps';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { colors, radius, spacing, typography } from '@/theme/tokens';
import { useVehicleSummary } from '@/features/vehicles/useVehicleSummary';
import { decodePolylineToCoords } from '@/lib/decodePolyline';

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
}

function formatDuration(startIso: string, endIso: string | null, durationMin?: number | null): string {
  const mins = durationMin != null
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today, ${timeStr}`;
  if (isYesterday) return `Yesterday, ${timeStr}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + `, ${timeStr}`;
}

function efficiencyColor(wh: number | null): string {
  if (wh == null) return colors.textSecondary;
  if (wh < 150) return colors.green;
  if (wh < 200) return '#22D3EE';
  if (wh < 250) return colors.warning;
  return colors.danger;
}

function efficiencyLabel(wh: number | null): string {
  if (wh == null) return '—';
  if (wh < 150) return '🌿 Eco';
  if (wh < 200) return '✓ Good';
  if (wh < 250) return '~ Avg';
  return '⚡ High';
}

function TripItem({ trip }: { trip: TripRow }) {
  const duration = formatDuration(trip.startTime, trip.endTime, trip.durationMin);
  const eColor = efficiencyColor(trip.efficiencyWhkm);

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTime}>{formatDate(trip.startTime)}</Text>
        {trip.efficiencyWhkm != null && (
          <View style={[styles.effBadge, { borderColor: `${eColor}55`, backgroundColor: `${eColor}15` }]}>
            <Text style={[styles.effBadgeText, { color: eColor }]}>
              {efficiencyLabel(trip.efficiencyWhkm)}
            </Text>
          </View>
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
    </View>
  );
}

export default function TripsScreen() {
  const insets = useSafeAreaInsets();
  const { vehicleId } = useVehicleSummary();
  const [refreshing, setRefreshing] = useState(false);

  const tripsQuery = useQuery({
    queryKey: ['trips', vehicleId],
    queryFn: async () => {
      const { data } = await api.get<{ data: TripRow[] }>(
        `/trips/vehicle/${vehicleId}?limit=50`,
      );
      return data.data;
    },
    enabled: !!vehicleId,
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await tripsQuery.refetch(); } finally { setRefreshing(false); }
  }, [tripsQuery]);

  const previewTrip = tripsQuery.data?.find((t) => t.polyline);
  const coords = useMemo(
    () => decodePolylineToCoords(previewTrip?.polyline),
    [previewTrip?.polyline],
  );

  const region = useMemo(() => {
    if (!coords.length) {
      return { latitude: 52.52, longitude: 13.405, latitudeDelta: 0.2, longitudeDelta: 0.2 };
    }
    const lats = coords.map((c) => c.latitude);
    const lngs = coords.map((c) => c.longitude);
    const latMin = Math.min(...lats), latMax = Math.max(...lats);
    const lngMin = Math.min(...lngs), lngMax = Math.max(...lngs);
    return {
      latitude: (latMin + latMax) / 2,
      longitude: (lngMin + lngMax) / 2,
      latitudeDelta: Math.max(0.02, (latMax - latMin) * 1.8),
      longitudeDelta: Math.max(0.02, (lngMax - lngMin) * 1.8),
    };
  }, [coords]);

  const totalKm = (tripsQuery.data ?? []).reduce((s, t) => s + (t.distanceKm ?? 0), 0);
  const avgEff = (() => {
    const trips = (tripsQuery.data ?? []).filter((t) => t.efficiencyWhkm != null);
    if (!trips.length) return null;
    return trips.reduce((s, t) => s + Number(t.efficiencyWhkm), 0) / trips.length;
  })();

  if (!vehicleId) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <Text style={styles.muted}>Select a vehicle in Settings after linking Tesla.</Text>
      </View>
    );
  }

  if (tripsQuery.isPending) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const mapW = Dimensions.get('window').width - spacing.md * 2;

  return (
    <FlatList
      style={[styles.screen, { paddingTop: insets.top }]}
      data={tripsQuery.data ?? []}
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
          <Text style={styles.title}>Trips</Text>
          <Text style={styles.subtitle}>Routes and efficiency</Text>

          {/* Map preview */}
          {coords.length > 1 && (
            <View style={styles.mapWrap}>
              <MapView
                style={{ width: mapW, height: 200 }}
                initialRegion={region}
                region={region}
                scrollEnabled={false}
                zoomEnabled={false}
              >
                <Polyline coordinates={coords} strokeColor={colors.cyan} strokeWidth={4} />
              </MapView>
              {previewTrip && (
                <View style={styles.mapOverlay}>
                  <Text style={styles.mapOverlayText}>
                    {previewTrip.startLocation ?? 'Latest trip'}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Summary stats */}
          {(tripsQuery.data?.length ?? 0) > 0 && (
            <View style={styles.statsRow}>
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{totalKm.toFixed(0)} km</Text>
                <Text style={styles.statLabel}>Total</Text>
              </View>
              {avgEff != null && (
                <View style={styles.statItem}>
                  <Text style={[styles.statValue, { color: efficiencyColor(avgEff) }]}>
                    {Math.round(avgEff)} Wh/km
                  </Text>
                  <Text style={styles.statLabel}>Avg eff.</Text>
                </View>
              )}
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{tripsQuery.data?.length ?? 0}</Text>
                <Text style={styles.statLabel}>Trips</Text>
              </View>
            </View>
          )}

          <Text style={styles.sectionTitle}>History</Text>
        </View>
      )}
      ListEmptyComponent={
        <Text style={styles.muted}>No trips recorded for this vehicle.</Text>
      }
      renderItem={({ item }) => <TripItem trip={item} />}
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

  mapWrap: { borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  mapOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: `${colors.background}cc`,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  mapOverlayText: { color: colors.textSecondary, fontSize: 12 },

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

  // Trip row
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 6,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowTime: { color: colors.textPrimary, fontWeight: '600', fontSize: 14, flex: 1 },
  effBadge: { borderRadius: 99, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  effBadgeText: { fontSize: 11, fontWeight: '600' },
  rowStats: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  statPrimary: { color: colors.cyan, fontSize: 14, fontWeight: '600' },
  statSep: { color: colors.textMuted, fontSize: 13 },
  statSecondary: { color: colors.textSecondary, fontSize: 13 },
  locations: { gap: 2 },
  locationText: { color: colors.textMuted, fontSize: 12 },

  muted: { color: colors.textSecondary, fontSize: 14, textAlign: 'center' },
});
