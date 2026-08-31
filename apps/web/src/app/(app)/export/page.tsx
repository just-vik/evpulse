'use client'

import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { Page } from '@/components/layout'
import { useAuthStore } from '@/stores/authStore'
import { useLayoutStore } from '@/stores/layout.store'
import { apiClient } from '@/lib/api'
import {
  Download, FileText, Map, Database,
  CheckCircle2, AlertCircle, Loader2,
} from 'lucide-react'

type ExportEntity = 'trips' | 'charging' | 'telemetry'
type ExportFormat = 'csv' | 'json' | 'gpx'
type DownloadState = 'idle' | 'loading' | 'done' | 'error'

interface ExportCard {
  entity: ExportEntity
  icon: React.ElementType
  color: string
  titleKey: string
  descKey: string
  formats: ExportFormat[]
}

const EXPORTS: ExportCard[] = [
  {
    entity: 'trips',
    icon: Map,
    color: '#8b5cf6',
    titleKey: 'export.trips.title',
    descKey: 'export.trips.desc',
    formats: ['csv', 'gpx', 'json'],
  },
  {
    entity: 'charging',
    icon: Database,
    color: '#34d399',
    titleKey: 'export.charging.title',
    descKey: 'export.charging.desc',
    formats: ['csv', 'json'],
  },
  {
    entity: 'telemetry',
    icon: FileText,
    color: '#38bdf8',
    titleKey: 'export.telemetry.title',
    descKey: 'export.telemetry.desc',
    formats: ['csv', 'json'],
  },
]

const FORMAT_LABELS: Record<ExportFormat, string> = {
  csv: 'CSV',
  json: 'JSON',
  gpx: 'GPX',
}

const DATE_PRESETS = [
  { label: '7 days',  days: 7  },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year',  days: 365 },
]

function toIsoDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

export default function ExportPage() {
  const { t } = useTranslation()
  const { accessToken } = useAuthStore()
  const vehicleId = useLayoutStore(s => s.selectedVehicleId)

  const [formats,  setFormats]  = useState<Record<ExportEntity, ExportFormat>>({
    trips: 'csv', charging: 'csv', telemetry: 'csv',
  })
  const [endDate,   setEndDate]   = useState(toIsoDate(new Date()))
  const [startDate, setStartDate] = useState(toIsoDate(new Date(Date.now() - 30 * 86_400_000)))
  const [states,    setStates]    = useState<Record<ExportEntity, DownloadState>>({
    trips: 'idle', charging: 'idle', telemetry: 'idle',
  })
  const [errors,    setErrors]    = useState<Record<ExportEntity, string>>({
    trips: '', charging: '', telemetry: '',
  })

  function applyPreset(days: number) {
    const end   = new Date()
    const start = new Date(end.getTime() - days * 86_400_000)
    setEndDate(toIsoDate(end))
    setStartDate(toIsoDate(start))
  }

  async function download(entity: ExportEntity) {
    if (!accessToken || !vehicleId) return
    setStates(s => ({ ...s, [entity]: 'loading' }))
    setErrors(e => ({ ...e, [entity]: '' }))
    try {
      await apiClient.downloadExport(entity, {
        vehicleId,
        format: formats[entity],
        startDate,
        endDate,
      }, accessToken)
      setStates(s => ({ ...s, [entity]: 'done' }))
      setTimeout(() => setStates(s => ({ ...s, [entity]: 'idle' })), 3000)
    } catch (err: any) {
      setStates(s => ({ ...s, [entity]: 'error' }))
      setErrors(e => ({ ...e, [entity]: err.message ?? 'Download failed' }))
    }
  }

  return (
    <Page title={t('nav.export', { defaultValue: 'Export' })}>
      <div className="max-w-2xl mx-auto space-y-5 pb-8">

        {/* Date range */}
        <motion.div
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          className="p-4 rounded-2xl bg-[hsl(var(--card))] border border-[hsl(var(--border)/0.7)] space-y-3"
        >
          <p className="text-sm font-semibold text-foreground">
            {t('export.dateRange', { defaultValue: 'Date Range' })}
          </p>

          {/* Quick presets */}
          <div className="flex gap-2 flex-wrap">
            {DATE_PRESETS.map(p => (
              <button
                key={p.days}
                onClick={() => applyPreset(p.days)}
                className="px-3 py-1.5 rounded-xl text-xs font-medium border border-[hsl(var(--border)/0.6)]
                           text-muted-foreground hover:text-foreground hover:border-[hsl(var(--border)/0.9)]
                           transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-muted-foreground font-medium block mb-1">
                {t('export.from', { defaultValue: 'From' })}
              </label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="w-full px-3 py-2 rounded-xl text-sm bg-[hsl(var(--secondary)/0.5)]
                           border border-[hsl(var(--border)/0.6)] text-foreground
                           focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring)/0.5)]"
              />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground font-medium block mb-1">
                {t('export.to', { defaultValue: 'To' })}
              </label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="w-full px-3 py-2 rounded-xl text-sm bg-[hsl(var(--secondary)/0.5)]
                           border border-[hsl(var(--border)/0.6)] text-foreground
                           focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring)/0.5)]"
              />
            </div>
          </div>
        </motion.div>

        {/* Export cards */}
        {EXPORTS.map((card, idx) => {
          const Icon  = card.icon
          const state = states[card.entity]
          const err   = errors[card.entity]
          return (
            <motion.div
              key={card.entity}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.06 }}
              className="p-4 rounded-2xl bg-[hsl(var(--card))] border border-[hsl(var(--border)/0.7)] space-y-3"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: `${card.color}18` }}>
                  <Icon size={17} style={{ color: card.color }} />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {t(card.titleKey, { defaultValue: card.entity.charAt(0).toUpperCase() + card.entity.slice(1) })}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {t(card.descKey, { defaultValue: '' })}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 justify-between">
                {/* Format selector */}
                <div className="flex gap-1">
                  {card.formats.map(fmt => (
                    <button
                      key={fmt}
                      onClick={() => setFormats(f => ({ ...f, [card.entity]: fmt }))}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        formats[card.entity] === fmt
                          ? 'text-foreground border'
                          : 'text-muted-foreground border border-transparent hover:border-[hsl(var(--border)/0.6)]'
                      }`}
                      style={formats[card.entity] === fmt ? {
                        background: `${card.color}18`,
                        borderColor: `${card.color}44`,
                        color: card.color,
                      } : {}}
                    >
                      {FORMAT_LABELS[fmt]}
                    </button>
                  ))}
                </div>

                {/* Download button */}
                <button
                  onClick={() => download(card.entity)}
                  disabled={state === 'loading' || !vehicleId}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium
                             transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: `${card.color}18`,
                    color: card.color,
                    border: `1px solid ${card.color}33`,
                  }}
                >
                  {state === 'loading' ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : state === 'done' ? (
                    <CheckCircle2 size={14} />
                  ) : state === 'error' ? (
                    <AlertCircle size={14} />
                  ) : (
                    <Download size={14} />
                  )}
                  {state === 'done'
                    ? t('export.downloaded', { defaultValue: 'Downloaded!' })
                    : state === 'error'
                    ? t('export.error', { defaultValue: 'Error' })
                    : t('export.download', { defaultValue: 'Download' })}
                </button>
              </div>

              {state === 'error' && err && (
                <p className="text-xs text-red-400">{err}</p>
              )}
            </motion.div>
          )
        })}

        {!vehicleId && (
          <p className="text-center text-sm text-muted-foreground py-4">
            {t('export.noVehicle', { defaultValue: 'Select a vehicle to export data.' })}
          </p>
        )}
      </div>
    </Page>
  )
}
