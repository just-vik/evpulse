import { Text, View, StyleSheet } from 'react-native';
import { LineChart } from 'react-native-gifted-charts';
import { color, space, type as tType } from '@/theme/tokens';
import type { ChartSample } from '@/lib/tripTelemetry';

interface Props {
  /** Omit when the card already renders its own heading above this chart (e.g. above
   *  a TripStat row) — avoids showing the same section name twice. */
  title?: string;
  data: ChartSample[];
  unit: string;
  /** Line/area color — one per metric, so Speed/Elevation/Power/SOC stay visually
   *  distinct. Defaults to the app's primary brand accent. */
  lineColor?: string;
  emptyLabel?: string;
  /** Visual-only y-axis clamp (e.g. SOC: 0–100). Never clamps the underlying data —
   *  points outside this range would still be drawn, this only fixes the axis scale. */
  maxValue?: number;
  yAxisOffset?: number;
}

const CHART_HEIGHT = 120;

/**
 * Renders one telemetry metric as a small line/area chart, reusing the project's
 * existing react-native-gifted-charts pattern (see (tabs)/analytics.tsx) — not a new
 * chart abstraction, just the same LineChart config factored out so Trip Detail's four
 * charts (speed/elevation/power/SOC) don't each re-declare the same prop block.
 *
 * Data is expected pre-filtered/downsampled (see src/lib/tripTelemetry.ts) — this
 * component does no transformation of its own.
 */
export function TripTelemetryChart({
  title,
  data,
  unit,
  lineColor = color.brand.teal400,
  emptyLabel,
  maxValue,
  yAxisOffset,
}: Props) {
  return (
    <View style={styles.wrap}>
      {(title || data.length > 0) && (
        <View style={styles.titleRow}>
          {title ? <Text style={styles.title}>{title}</Text> : <View />}
          {data.length > 0 && <Text style={styles.unit}>{unit}</Text>}
        </View>
      )}

      {data.length === 0 ? (
        <Text style={styles.empty}>{emptyLabel ?? '—'}</Text>
      ) : (
        <LineChart
          data={data}
          height={CHART_HEIGHT}
          spacing={Math.max(2, 260 / data.length)}
          thickness={2}
          color={lineColor}
          maxValue={maxValue}
          yAxisOffset={yAxisOffset}
          hideRules
          hideDataPoints
          hideYAxisText
          xAxisColor={color.border.subtle}
          yAxisColor={color.border.subtle}
          curved
          areaChart
          startFillColor={lineColor}
          endFillColor="transparent"
          startOpacity={0.25}
          endOpacity={0.02}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { ...tType.bodyStrong, color: color.text.primary },
  unit: { ...tType.caption, color: color.text.secondary },
  empty: { ...tType.caption, color: color.text.tertiary, paddingVertical: space.lg, textAlign: 'center' },
});
