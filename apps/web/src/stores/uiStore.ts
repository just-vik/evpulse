'use client'

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { applyLanguagePreference } from '@/lib/i18n-sync'

type Theme = 'light' | 'dark' | 'auto'
type Units = 'imperial' | 'metric'
export type TempUnits = 'celsius' | 'fahrenheit'
export type AccentColor = 'blue' | 'teal' | 'violet' | 'emerald' | 'amber' | 'sky' | 'rose' | 'indigo' | 'lime'

export interface AppPreferences {
  language:     string   // 'en' | 'de' | 'fr' | 'ru' ...
  dateFormat:   'dmy' | 'mdy' | 'ymd'
  timeFormat:   '24h' | '12h'
  energyRate:   number   // rate per kWh in baseCurrency
  currency:     string   // ISO 4217 display currency ('EUR' | 'USD' | 'GBP' ...)
  /**
   * The currency in which stored cost values were computed.
   * Defaults to 'EUR'. Updated when the user explicitly re-enters their
   * energy rate in a new currency (via the "Apply suggestion" action).
   * Used by useCurrency to apply exchange-rate conversion before display.
   */
  baseCurrency: string
}

type ToastType = 'success' | 'error' | 'info' | 'warning'

interface Toast {
  id: string
  type: ToastType
  message: string
  duration?: number
}

interface UIState {

  /* SETTINGS (persisted) */

  theme: Theme
  setTheme: (theme: Theme) => void

  units: Units
  setUnits: (units: Units) => void

  tempUnits: TempUnits
  setTempUnits: (tempUnits: TempUnits) => void

  accent: AccentColor
  setAccent: (accent: AccentColor) => void

  preferences: AppPreferences
  setPreferences: (prefs: Partial<AppPreferences>) => void

  /* RUNTIME STATE */

  modals: Record<string, any>

  openModal: (modalId: string, data?: any) => void
  closeModal: (modalId: string) => void
  closeAllModals: () => void

  /* TOASTS */

  toasts: Toast[]

  addToast: (
    type: ToastType,
    message: string,
    duration?: number
  ) => void

  removeToast: (id: string) => void
  clearToasts: () => void

  /* LOADING */

  loading: Record<string, boolean>

  setLoading: (key: string, value: boolean) => void

  /* WEBSOCKET */

  wsConnected: boolean
  setWsConnected: (connected: boolean) => void
}

/* ------------------------------------------------ */

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({

      /* SETTINGS */

      theme: 'auto',

      setTheme: (theme) =>
        set({ theme }),

      units: 'metric',

      setUnits: (units) =>
        set({ units }),

      tempUnits: 'celsius',

      setTempUnits: (tempUnits) =>
        set({ tempUnits }),

      accent: 'blue',

      setAccent: (accent) =>
        set({ accent }),

      preferences: {
        language:     'en',
        dateFormat:   'dmy',
        timeFormat:   '24h',
        energyRate:   0.30,
        currency:     'EUR',
        baseCurrency: 'EUR',
      },

      setPreferences: (prefs) => {
        const norm: Partial<AppPreferences> = { ...prefs }
        if (typeof norm.currency === 'string') {
          norm.currency = norm.currency.trim().toUpperCase()
        }
        if (typeof norm.baseCurrency === 'string') {
          norm.baseCurrency = norm.baseCurrency.trim().toUpperCase()
        }
        set((state) => ({
          preferences: { ...state.preferences, ...norm },
        }))
        if (typeof prefs.language === 'string') {
          applyLanguagePreference(prefs.language)
        }
      },

      /* MODALS */

      modals: {},

      openModal: (modalId, data = {}) =>
        set((state) => ({
          modals: {
            ...state.modals,
            [modalId]: data
          }
        })),

      closeModal: (modalId) =>
        set((state) => {

          const modals = { ...state.modals }

          delete modals[modalId]

          return { modals }

        }),

      closeAllModals: () =>
        set({ modals: {} }),

      /* TOASTS */

      toasts: [],

      addToast: (type, message, duration = 4000) => {

        const id = crypto.randomUUID()

        set((state) => ({
          toasts: [
            ...state.toasts,
            { id, type, message, duration }
          ]
        }))

        if (duration) {

          setTimeout(() => {

            const { removeToast } = get()

            removeToast(id)

          }, duration)

        }

      },

      removeToast: (id) =>
        set((state) => ({
          toasts: state.toasts.filter(t => t.id !== id)
        })),

      clearToasts: () =>
        set({ toasts: [] }),

      /* LOADING */

      loading: {},

      setLoading: (key, value) =>
        set((state) => ({
          loading: {
            ...state.loading,
            [key]: value
          }
        })),

      /* WEBSOCKET */

      wsConnected: false,

      setWsConnected: (connected) =>
        set({ wsConnected: connected })

    }),
    {
      name: 'ui-storage',
      version: 1,
      storage: createJSONStorage(() => localStorage),

      /* persist only settings */

      partialize: (state) => ({
        theme:       state.theme,
        units:       state.units,
        tempUnits:   state.tempUnits,
        accent:      state.accent,
        preferences: state.preferences,
      }),
    }
  )
)