'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useOfflineStatus } from '@/hooks/useOfflineStatus'

export function OfflineBanner() {
  const isOffline = useOfflineStatus()
  const { t } = useTranslation()

  return (
    <AnimatePresence>
      {isOffline && (
        <motion.div
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          className="fixed top-0 inset-x-0 z-[60] flex items-center justify-center gap-2 px-4 py-2
                     bg-amber-500/15 backdrop-blur-md border-b border-amber-500/25
                     text-amber-400 text-xs font-medium pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <WifiOff size={12} className="shrink-0" />
          {t('common.offlineBanner', { defaultValue: 'Offline — showing cached data' })}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
