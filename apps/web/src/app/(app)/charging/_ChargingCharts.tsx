'use client';

import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Zap, BarChart2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactECharts from 'echarts-for-react';
import { useCurrency } from '@/hooks/useCurrency';
import {
  ECHARTS_AXIS,
  ECHARTS_AXIS_LABEL,
  ECHARTS_BG,
  ECHARTS_SPLIT,
  ECHARTS_TEXT,
  ECHARTS_TOOLTIP_BG,
  ECHARTS_TOOLTIP_BORDER,
} from '@/widgets/charts/echartsTheme';

interface TimelineEntry {
  date: string;
  home: number;
  sc: number;
  dc: number;
  public: number;
  cost: number;
}

interface StackTotal {
  key: string;
  label: string;
  color: string;
  total: number;
}

interface MonthlyCostEntry {
  month: string;
  totalCost: number;
  energyKwh: number;
  sessions: number;
}

interface Props {
  timelineData: TimelineEntry[];
  stackTotals: StackTotal[];
  monthlyCosts: MonthlyCostEntry[];
}

const CHARGER_STACKS = [
  { key: 'home',   label: 'Home',         color: '#10b981' },
  { key: 'sc',     label: 'Supercharger', color: '#f43f5e' },
  { key: 'dc',     label: 'DC Fast',      color: '#f59e0b' },
  { key: 'public', label: 'AC Public',    color: '#0ea5e9' },
] as const;

export default function ChargingCharts({ timelineData, stackTotals, monthlyCosts }: Props) {
  const { t } = useTranslation();
  const { symbol: currSymbol, formatMoney: fmtMoney } = useCurrency();

  const sessionOption = useMemo(() => ({
    backgroundColor: ECHARTS_BG,
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: ECHARTS_TOOLTIP_BG,
      borderColor: ECHARTS_TOOLTIP_BORDER,
      textStyle: { color: ECHARTS_TEXT, fontSize: 12 },
      axisPointer: { type: 'shadow' as const },
      formatter: (params: any[]) => {
        const date = params[0]?.axisValue ?? '';
        const costEntry = timelineData.find((d) => d.date === date);
        const rows = params
          .filter((p) => Number(p.value) > 0)
          .map((p) => `<div style="display:flex;justify-content:space-between;gap:14px;margin-bottom:4px">
            <span style="display:flex;align-items:center;gap:5px;color:#9ca3af">
              <span style="width:8px;height:8px;border-radius:2px;background:${p.color};display:inline-block"></span>
              ${p.seriesName}
            </span>
            <span style="font-weight:600;color:#e5e7eb;font-variant-numeric:tabular-nums">${Number(p.value).toFixed(1)} kWh</span>
          </div>`)
          .join('');
        const total = params.reduce((s, p) => s + (Number(p.value) || 0), 0);
        const costHtml = costEntry && costEntry.cost > 0
          ? `<div style="display:flex;justify-content:space-between;margin-top:2px">
              <span style="color:#9ca3af">Cost</span>
              <span style="font-weight:700;color:#a78bfa;font-variant-numeric:tabular-nums">${fmtMoney(costEntry.cost)}</span>
            </div>`
          : '';
        return `<div style="min-width:160px">
          <div style="font-weight:600;margin-bottom:8px;color:#e5e7eb">${date}</div>
          ${rows}
          <div style="border-top:1px solid #2a2d36;margin-top:6px;padding-top:6px;display:flex;justify-content:space-between">
            <span style="color:#9ca3af">Total</span>
            <span style="font-weight:700;color:#34d399;font-variant-numeric:tabular-nums">${total.toFixed(1)} kWh</span>
          </div>
          ${costHtml}
        </div>`;
      },
    },
    grid: { top: 12, right: 12, bottom: 28, left: 52 },
    xAxis: {
      type: 'category' as const,
      data: timelineData.map((d) => d.date),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: ECHARTS_AXIS_LABEL, fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value' as const,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: ECHARTS_AXIS_LABEL, fontSize: 10, formatter: (v: number) => `${v} kWh` },
      splitLine: { lineStyle: { color: ECHARTS_SPLIT } },
    },
    series: CHARGER_STACKS.map((s) => ({
      name: s.label,
      type: 'bar' as const,
      stack: 'total',
      data: timelineData.map((d) => d[s.key as keyof TimelineEntry] as number),
      itemStyle: {
        color: {
          type: 'linear' as const,
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: s.color },
            { offset: 1, color: `${s.color}80` },
          ],
        },
      },
      barMaxWidth: 32,
    })),
  }), [timelineData, fmtMoney]);

  const monthlyOption = useMemo(() => ({
    backgroundColor: ECHARTS_BG,
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: ECHARTS_TOOLTIP_BG,
      borderColor: ECHARTS_TOOLTIP_BORDER,
      textStyle: { color: ECHARTS_TEXT, fontSize: 12 },
      axisPointer: { type: 'shadow' as const },
      formatter: (params: any[]) => {
        const month = params[0]?.axisValue ?? '';
        const rows = params.map((p) => {
          const isEnergy = p.seriesName === 'Energy';
          const val = isEnergy ? `${Number(p.value).toFixed(1)} kWh` : fmtMoney(Number(p.value));
          const color = isEnergy ? '#34d399' : '#a78bfa';
          return `<div style="display:flex;justify-content:space-between;gap:14px;margin-bottom:4px">
            <span style="display:flex;align-items:center;gap:5px;color:#9ca3af">
              <span style="width:8px;height:8px;border-radius:2px;background:${p.color};display:inline-block"></span>
              ${p.seriesName}
            </span>
            <span style="font-weight:600;color:${color};font-variant-numeric:tabular-nums">${val}</span>
          </div>`;
        }).join('');
        return `<div style="min-width:160px">
          <div style="font-weight:600;margin-bottom:8px;color:#e5e7eb">${month}</div>
          ${rows}
        </div>`;
      },
    },
    grid: { top: 12, right: 52, bottom: 28, left: 56 },
    xAxis: {
      type: 'category' as const,
      data: monthlyCosts.map((d) => d.month),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: ECHARTS_AXIS_LABEL, fontSize: 10 },
    },
    yAxis: [
      {
        type: 'value' as const,
        name: 'kWh',
        nameTextStyle: { color: ECHARTS_AXIS_LABEL, fontSize: 10 },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: ECHARTS_AXIS_LABEL, fontSize: 10, formatter: (v: number) => `${v}` },
        splitLine: { lineStyle: { color: ECHARTS_SPLIT } },
      },
      {
        type: 'value' as const,
        name: currSymbol,
        nameTextStyle: { color: ECHARTS_AXIS_LABEL, fontSize: 10 },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: ECHARTS_AXIS_LABEL, fontSize: 10, formatter: (v: number) => `${v}` },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'Energy',
        type: 'bar' as const,
        yAxisIndex: 0,
        data: monthlyCosts.map((d) => d.energyKwh),
        itemStyle: {
          color: {
            type: 'linear' as const,
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: '#10b981' },
              { offset: 1, color: '#10b98160' },
            ],
          },
          borderRadius: [4, 4, 1, 1],
        },
        barMaxWidth: 36,
      },
      {
        name: t('charging.cost'),
        type: 'line' as const,
        yAxisIndex: 1,
        data: monthlyCosts.map((d) => d.totalCost),
        lineStyle: { color: '#a78bfa', width: 2, type: 'dashed' as const },
        itemStyle: { color: '#a78bfa' },
        symbol: 'circle',
        symbolSize: 6,
        smooth: false,
      },
    ],
  }), [monthlyCosts, currSymbol, fmtMoney, t]);

  return (
    <>
      {timelineData.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] shadow-xl overflow-hidden mb-6"
        >
          <div className="px-5 pt-5 pb-3 border-b border-[hsl(var(--border)/0.45)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap size={16} className="text-emerald-400" />
              <span className="text-base font-semibold text-foreground">{t('charging.sessionHistoryTitle')}</span>
            </div>
            <div className="flex items-center gap-3 flex-wrap justify-end">
              {stackTotals.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
                  <span className="text-[11px] text-muted-foreground">{s.label}</span>
                  <span className="text-[11px] font-semibold text-foreground">{s.total.toFixed(1)} kWh</span>
                </div>
              ))}
            </div>
          </div>
          <div className="px-1 pt-3 pb-1">
            <ReactECharts option={sessionOption} style={{ height: 220 }} notMerge lazyUpdate />
          </div>
        </motion.div>
      )}

      {monthlyCosts.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card))] shadow-xl overflow-hidden mb-6"
        >
          <div className="px-5 pt-5 pb-3 border-b border-[hsl(var(--border)/0.45)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart2 size={16} className="text-violet-400" />
              <span className="text-base font-semibold text-foreground">Monthly Overview</span>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
                <span className="text-[11px] text-muted-foreground">Energy kWh</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 rounded-sm" style={{ background: '#a78bfa', borderTop: '2px dashed #a78bfa' }} />
                <span className="text-[11px] text-muted-foreground">{t('charging.cost')} {currSymbol}</span>
              </div>
            </div>
          </div>
          <div className="px-1 pt-3 pb-1">
            <ReactECharts option={monthlyOption} style={{ height: 200 }} notMerge lazyUpdate />
          </div>
        </motion.div>
      )}
    </>
  );
}
