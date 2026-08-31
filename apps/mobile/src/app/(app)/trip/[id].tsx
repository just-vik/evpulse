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

/** GET /trips/:tripId/quality — real endpoint (apps/api/src/trips/trips.controller.ts). */
interface TripQuality {
  tripId: string;
  score: number | null;
  reliability: string | null;
  severity: 'ok' | 'warning' | 'repaired' | 'degraded';
  issues: string[];
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
  }>();

  const distanceKm = params.distanceKm ? Number(params.distanceKm) : null;
  const efficiencyWhkm = params.efficiencyWhkm ? Number(params.efficiencyWhkm) : null;
  const startSoc = params.startSoc ? Number(params.startSoc) : null;
  const endSoc = params.endSoc ? Number(params.endSoc) : null;

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
});
