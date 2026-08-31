'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { Car, Settings, Battery, Gauge, Eye, EyeOff } from 'lucide-react'
import { useVehicles } from '@/hooks/useVehicles'
import { useLayoutStore } from '@/stores/layout.store'
import { formatRelativeTime } from '@/lib/utils'
import { EmptyState } from '@/shared/ui/EmptyState'
import { ErrorState } from '@/shared/ui/ErrorState'

function Skel({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />
}

function VinDisplay({ vin }: { vin: string }) {
  const [revealed, setRevealed] = useState(false)
  const masked = `···${vin.slice(-7)}`
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); setRevealed(v => !v); }}
      className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      title={revealed ? 'Скрыть VIN' : 'Показать VIN'}
    >
      {revealed ? vin : masked}
      {revealed
        ? <EyeOff size={10} className="shrink-0 opacity-50" />
        : <Eye size={10} className="shrink-0 opacity-50" />}
    </button>
  )
}

export default function VehiclesPage() {
  const { data: vehicles, isLoading, error } = useVehicles()
  const { selectedVehicleId, setSelectedVehicleId } = useLayoutStore()
  const { t, i18n } = useTranslation()

  const hasVehicles = !!vehicles?.length

  return (
    <div className="px-4 pt-3 pb-6 max-w-2xl mx-auto lg:max-w-5xl">
      {/* Header */}
      <div className="py-1 mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">{t('pages.vehicles.title')}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isLoading
              ? t('common.loading')
              : hasVehicles
              ? t('pages.vehicles.subtitle')
              : t('pages.vehicles.connectHint')}
          </p>
        </div>

        <Link
          href="/settings"
          className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium
                     bg-[hsl(var(--card))] hover:bg-[hsl(var(--secondary)/0.6)] text-foreground border border-[hsl(var(--border)/0.8)]"
        >
          <Settings size={14} />
          {t('nav.settings')}
        </Link>
      </div>

      {/* Loading / error / empty */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[1, 2, 3].map(i => (
            <Skel key={i} className="h-36 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <ErrorState message={(error as Error).message} className="p-3" />
      ) : !hasVehicles ? (
        <EmptyState
          icon={<Car size={28} className="text-blue-400" />}
          title={t('pages.vehicles.noVehicles')}
          description={t('pages.vehicles.connectHint')}
          action={
            <Link
              href="/settings"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[hsl(var(--brand-h)_var(--brand-s)_var(--brand-l-500))] hover:brightness-110
                         text-white text-sm font-medium transition-colors"
            >
              <Settings size={15} />
              {t('nav.settings')}
            </Link>
          }
          className="card py-16"
        />
      ) : (
        <>
          <div className={`grid gap-3 ${vehicles!.length === 1 ? 'grid-cols-1 max-w-xl' : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'}`}>
            {vehicles!.map((v: any, i: number) => {
              const selected = selectedVehicleId === v.id
              const online = v.status === 'active' || v.vehicleState === 'online'

              return (
                <motion.div
                  key={v.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                >
                  <Link
                    href={`/vehicles/${v.id}`}
                    onClick={() => setSelectedVehicleId(v.id)}
                    className={`block card card-press p-5 transition-all ${
                      selected
                        ? 'border-blue-500/40 shadow-[0_0_24px_-8px_rgba(59,130,246,0.35)]'
                        : 'hover:border-[hsl(var(--border))]'
                    }`}
                  >
                    {/* Top row */}
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-500/20 to-violet-500/15 border border-blue-500/20 flex items-center justify-center">
                          <Car size={18} className="text-blue-400" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">
                            {v.displayName ?? `${v.model} ${v.trim ?? ''}`}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-0.5 truncate flex items-center gap-1">
                            {v.year ? `${v.year}` : ''}
                            {v.year && v.vin ? ' · ' : ''}
                            {v.vin ? <><span>VIN:</span><VinDisplay vin={v.vin} /></> : ''}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span
                          className={`status-dot ${
                            online ? 'status-dot-online' : 'status-dot-offline'
                          }`}
                        />
                        <span
                          className={`text-[11px] font-medium ${
                            online ? 'text-emerald-400' : 'text-muted-foreground'
                          }`}
                        >
                          {online ? t('status.online') : v.vehicleState ?? t('status.offline')}
                        </span>
                      </div>
                    </div>

                    {/* Bottom stats */}
                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-[hsl(var(--border)/0.7)]">
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Battery size={12} className="text-emerald-400" />
                        {v.odometer != null ? (
                          <span>{Math.round(v.odometer).toLocaleString()} {t('common.km')}</span>
                        ) : (
                          <span>{t('common.odometerLabel')} —</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Gauge size={11} className="text-muted-foreground" />
                        <span>{v.lastUpdate ? formatRelativeTime(v.lastUpdate, i18n.language) : t('common.noData')}</span>
                      </div>
                    </div>
                  </Link>
                </motion.div>
              )
            })}
          </div>

        </>
      )}
    </div>
  )
}
