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

export interface EfficiencyBarRow {
  date: string
  /** Relative efficiency vs fleet baseline, e.g. 130 = 130% */
  efficiencyPct: number
}

export function EfficiencyChart({
  data,
  title,
  height = 200,
}: {
  data: EfficiencyBarRow[]
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
        formatter: (params: unknown) => {
          const row = Array.isArray(params) ? params[0] : params
          const v = row && typeof row === 'object' && 'value' in row ? (row as { value: number }).value : null
          return v != null ? `${v}%` : ''
        },
      },
      grid: { top: 16, right: 12, bottom: 36, left: 40 },
      xAxis: {
        type: 'category',
        data: data.map((d) => d.date),
        axisLabel: { color: ECHARTS_AXIS_LABEL, fontSize: 10, rotate: data.length > 8 ? 30 : 0 },
        axisLine: { lineStyle: { color: ECHARTS_AXIS } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: ECHARTS_AXIS_LABEL, formatter: (v: number) => `${v}%` },
        splitLine: { lineStyle: { color: ECHARTS_SPLIT } },
      },
      series: [
        {
          data: data.map((d) => d.efficiencyPct),
          type: 'bar',
          barMaxWidth: 32,
          itemStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: NEON.emerald },
                { offset: 1, color: '#065f46' },
              ],
            },
            borderRadius: [6, 6, 0, 0],
          },
        },
      ],
    }),
    [data],
  )

  if (!data.length) return null

  return (
    <div className="rounded-xl border border-[hsl(var(--border)/0.7)] bg-[hsl(var(--card))] shadow-[0_0_24px_rgba(16,185,129,0.07)] p-4 backdrop-blur-sm">
      <p className="text-sm text-muted-foreground mb-3">{title}</p>
      <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />
    </div>
  )
}
