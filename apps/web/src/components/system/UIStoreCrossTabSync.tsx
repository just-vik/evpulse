'use client'

import { useEffect } from 'react'
import { useUIStore } from '@/stores/uiStore'

const STORAGE_KEY = 'ui-storage'

/**
 * When preferences change in another tab, Zustand persist does not rehydrate
 * this tab. Merge stored preferences so currency / theme updates apply everywhere.
 */
export function UIStoreCrossTabSync() {
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || e.newValue == null) return
      try {
        const parsed = JSON.parse(e.newValue) as { state?: { preferences?: Record<string, unknown> } }
        const prefs = parsed.state?.preferences
        if (!prefs || typeof prefs !== 'object') return
        useUIStore.setState((s) => ({
          preferences: { ...s.preferences, ...prefs } as typeof s.preferences,
        }))
      } catch {
        /* ignore corrupt storage */
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return null
}
