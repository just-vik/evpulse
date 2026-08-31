import { Text, View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { color, space, type as tType } from '@/theme/tokens';

export type DataQuality = 'REALTIME' | 'DELAYED' | 'STALE' | 'OFFLINE';

const QUALITY_COLOR: Record<DataQuality, string> = {
  REALTIME: color.quality.realtime,
  DELAYED: color.quality.delayed,
  STALE: color.quality.stale,
  OFFLINE: color.quality.offline,
};

const QUALITY_KEY: Record<DataQuality, string> = {
  REALTIME: 'dataQuality.realtime',
  DELAYED: 'dataQuality.delayed',
  STALE: 'dataQuality.stale',
  OFFLINE: 'dataQuality.offline',
};

interface Props {
  quality: DataQuality;
  /** Pre-formatted relative time (e.g. "5m ago") shown only when offline. */
  lastSeenLabel?: string;
}

/** Live data-quality indicator — dot + text label, color is never the only
 *  signal (WCAG 1.4.1). Maps the backend's real `dataQuality` enum
 *  (REALTIME/DELAYED/STALE/OFFLINE) rather than a client-computed boolean. */
export function DataQualityBadge({ quality, lastSeenLabel }: Props) {
  const { t } = useTranslation();
  const tint = QUALITY_COLOR[quality];
  const label =
    quality === 'OFFLINE' && lastSeenLabel
      ? t('dataQuality.lastSeen', { time: lastSeenLabel })
      : t(QUALITY_KEY[quality]);

  return (
    <View style={styles.row} accessibilityLabel={label}>
      <View style={[styles.dot, { backgroundColor: tint }]} />
      <Text style={[styles.text, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { ...tType.caption, fontWeight: '600' },
});
