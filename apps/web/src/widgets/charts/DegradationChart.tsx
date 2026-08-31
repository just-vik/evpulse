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

export interface DegradationPoint {
  label: string
  soh: number
  timestamp?: string
}

export interface ProjectionPoint {
  label: string
  soh: number
  upper: number
  lower: number
}

export function DegradationChart({
  data,
  projection,
  title,
  subtitle,
  height = 240,
}: {
  data: DegradationPoint[]
  projection?: ProjectionPoint[]
  title: string
  subtitle?: string
  height?: number
}) {
  const option = useMemo(() => {
    const proj = projection ?? []
    const allLabels = [...data.map((d) => d.label), ...proj.map((p) => p.label)]
    const n = data.length
    const values = data.map((d) => d.soh)
    const lastSoh = values[n - 1] ?? 100

    const yMin = Math.max(0, Math.floor(Math.min(
      ...values,
      ...proj.map(p => p.lower),
      78,
    ) - 2))

    // Confidence band uses ECharts stack technique:
    // bandLower fills transparent from 0 to lower bound
    // bandWidth fills the visible band from lower to upper
    // Historical region: bandWidth=0 makes it invisible there
    const bandLowerData = [
      ...values,
      ...proj.map(p => p.lower),
    ]
    const bandWidthData = [
      ...Array(n).fill(0),
      ...proj.map(p => Math.max(0, p.upper - p.lower)),
    ]

    // Projection line: null in historical region, connects at last real point
    const projLineData = proj.length > 0
      ? [...Array(n - 1).fill(null), lastSoh, ...proj.map(p => p.soh)]
      : []

    // Detect winter dip — first Dec/Jan/Feb point that is lower than its neighbours
    let winterMarkPoint: any = undefined
    if (data.length >= 3) {
      for (let i = 1; i < data.length - 1; i++) {
        const d = data[i]
        if (!d.timestamp) continue
        const month = new Date(d.timestamp).getMonth()
        if (month === 11 || month === 0 || month === 1) {
          // Only annotate if it's actually a local dip
          if (d.soh < data[i - 1].soh && d.soh < data[i + 1].soh) {
            winterMarkPoint = {
              data: [{
                coord: [d.label, d.soh],
                symbol: 'circle',
                symbolSize: 10,
                itemStyle: { color: '#60A5FA', borderColor: '#93C5FD', borderWidth: 2 },
                label: {
                  show: true,
                  formatter: '❄',
                  position: 'top',
                  fontSize: 12,
                  offset: [0, -2],
                },
              }],
            }
            break
          }
        }
      }
    }

    const series: any[] = [
      // Band: lower base (transparent, stacked)
      {
        type: 'line',
        data: bandLowerData,
        lineStyle: { opacity: 0 },
        areaStyle: { color: 'transparent' },
        stack: 'soh-band',
        symbol: 'none',
        silent: true,
        animation: false,
        tooltip: { show: false },
        legendHoverLink: false,
      },
      // Band: width (visible confidence area, stacked on top of lower)
      {
        type: 'line',
        data: bandWidthData,
        lineStyle: { opacity: 0 },
        areaStyle: { color: 'rgba(139,92,246,0.10)' },
        stack: 'soh-band',
        symbol: 'none',
        silent: true,
        animation: false,
        tooltip: { show: false },
        legendHoverLink: false,
      },
      // Historical SOH line
      {
        name: 'SOH',
        data: values,
        type: 'line',
        smooth: true,
        lineStyle: { color: NEON.violet, width: 2 },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(139,92,246,0.28)' },
              { offset: 1, color: 'rgba(139,92,246,0)' },
            ],
          },
        },
        symbol: 'circle',
        symbolSize: 4,
        markLine: {
          silent: true,
          data: [
            {
              yAxis: 80,
              name: '80% SOH',
              lineStyle: { color: '#EF4444', type: 'dashed', width: 1.5, opacity: 0.65 },
              label: { formatter: '80%', position: 'insideEndTop', color: '#F87171', fontSize: 10 },
            },
            ...(data.length >= 3
              ? [{
                  type: 'average' as const,
                  name: 'Avg',
                  lineStyle: { color: '#6B7280', type: 'dashed' as const },
                  label: { color: '#9CA3AF', fontSize: 10 },
                }]
              : []),
          ],
        },
        ...(winterMarkPoint ? { markPoint: winterMarkPoint } : {}),
      },
      // Projection dashed line
      ...(proj.length > 0
        ? [{
            name: 'Projection',
            data: projLineData,
            type: 'line',
            smooth: true,
            lineStyle: { color: 'rgba(139,92,246,0.5)', width: 1.5, type: 'dashed' },
            itemStyle: { color: 'rgba(139,92,246,0.5)' },
            symbol: 'none',
            connectNulls: false,
          }]
        : []),
    ]

    return {
      backgroundColor: ECHARTS_BG,
      tooltip: {
        trigger: 'axis',
        backgroundColor: ECHARTS_TOOLTIP_BG,
        borderColor: ECHARTS_TOOLTIP_BORDER,
        textStyle: { color: ECHARTS_TEXT },
        formatter: (params: any[]) => {
          const relevant = params.filter(
            p => p.seriesName === 'SOH' || p.seriesName === 'Projection',
          )
          if (!relevant.length) return ''
          const p = relevant[0]
          const val = p.value != null ? `${Number(p.value).toFixed(1)}%` : '—'
          const isProj = p.seriesName === 'Projection'
          return `<div style="font-size:12px"><b>${p.axisValue}</b><br/>${isProj ? '↗ Projected' : 'SOH'}: <b>${val}</b></div>`
        },
      },
      grid: { top: 24, right: 16, bottom: 28, left: 48 },
      xAxis: {
        type: 'category',
        data: allLabels,
        axisLine: { lineStyle: { color: ECHARTS_AXIS } },
        axisLabel: {
          color: ECHARTS_AXIS_LABEL,
          fontSize: 11,
          rotate: allLabels.length > 10 ? 35 : 0,
        },
      },
      yAxis: {
        type: 'value',
        min: yMin,
        max: 100,
        axisLine: { lineStyle: { color: ECHARTS_AXIS } },
        axisLabel: { color: ECHARTS_AXIS_LABEL, formatter: (v: number) => `${v}%` },
        splitLine: { lineStyle: { color: ECHARTS_SPLIT } },
      },
      series,
    }
  }, [data, projection])

  if (!data.length) return null

  return (
    <div className="rounded-xl border border-[hsl(var(--border)/0.7)] bg-[hsl(var(--card))] shadow-[0_0_28px_rgba(139,92,246,0.08)] p-4 backdrop-blur-sm">
      <p className="text-sm text-muted-foreground mb-1">{title}</p>
      {subtitle && <p className="text-xs text-amber-400/90 mb-3">{subtitle}</p>}
      <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />
    </div>
  )
}
