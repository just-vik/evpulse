'use client'

import React, { useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import {
  ECHARTS_AXIS,
  ECHARTS_AXIS_LABEL,
  ECHARTS_BG,
  ECHARTS_SPLIT,
  ECHARTS_TEXT,
  ECHARTS_TOOLTIP_BG,
  ECHARTS_TOOLTIP_BORDER,
  NEON,
} from './echartsTheme'

export interface BatteryHistoryPoint {
  time: string
  value: number
}

export function BatteryHistoryChart({
  data,
  title,
  height = 220,
}: {
  data: BatteryHistoryPoint[]
  title: string
  height?: number
}) {
  const option = useMemo(
    () => ({
      backgroundColor: ECHARTS_BG,
      tooltip: {
        trigger: 'axis',
        backgroundColor: ECHARTS_TOOLTIP_BG,
        borderColor: ECHARTS_TOOLTIP_BORDER,
        textStyle: { color: ECHARTS_TEXT },
      },
      grid: { top: 20, right: 16, bottom: 28, left: 48 },
      xAxis: {
        type: 'category',
        data: data.map((d) => d.time),
        axisLine: { lineStyle: { color: ECHARTS_AXIS } },
        axisLabel: { color: ECHARTS_AXIS_LABEL, fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLine: { lineStyle: { color: ECHARTS_AXIS } },
        axisLabel: { color: ECHARTS_AXIS_LABEL, formatter: (v: number) => `${v}%` },
        splitLine: { lineStyle: { color: ECHARTS_SPLIT } },
      },
      series: [
        {
          data: data.map((d) => d.value),
          type: 'line',
          smooth: true,
          lineStyle: { color: NEON.blue, width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(59,130,246,0.35)' },
                { offset: 1, color: 'rgba(59,130,246,0)' },
              ],
            },
          },
          symbol: 'none',
        },
      ],
    }),
    [data],
  )

  if (!data.length) return null

  return (
    <div className="rounded-xl border border-[hsl(var(--border)/0.7)] bg-[hsl(var(--card))] shadow-[0_0_24px_rgba(59,130,246,0.06)] p-4 backdrop-blur-sm">
      <p className="text-sm text-muted-foreground mb-3">{title}</p>
      <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />
    </div>
  )
}
