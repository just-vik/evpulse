'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { User } from '@/types/api';

/* ------------------------------------------------ */
/* COOKIE HELPERS (sync with middleware) */
/* ------------------------------------------------ */

function setAuthCookie(token: string) {
  if (typeof document === 'undefined') return;

  const expires = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000
  ).toUTCString();

  document.cookie = [
    `access_token=${token}`,
    'path=/',
    `expires=${expires}`,
    'SameSite=Lax',
    location.protocol === 'https:' ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function clearAuthCookie() {
  if (typeof document === 'undefined') return;

  document.cookie =
    'access_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

/* ------------------------------------------------ */
/* STATE */
/* ------------------------------------------------ */

interface AuthState {
  accessToken: string | null
  refreshToken: string | null
  user: User | null

  isAuthenticated: boolean
  isLoading: boolean
  error: string | null

  login: (
    accessToken: string,
    refreshToken: string,
    user: User
  ) => void

  logout: () => void

  setUser: (user: User | null) => void
  setTokens: (access: string, refresh: string) => void

  setLoading: (value: boolean) => void
  setError: (error: string | null) => void
  clearError: () => void

  reset: () => void
}

/* ------------------------------------------------ */
/* STORE */
/* ------------------------------------------------ */

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({

      accessToken: null,
      refreshToken: null,
      user: null,

      isAuthenticated: false,
      isLoading: false,
      error: null,

      /* LOGIN */

      login: (accessToken, refreshToken, user) => {

        setAuthCookie(accessToken)

        set({
          accessToken,
          refreshToken,
          user,
          isAuthenticated: true,
          error: null,
        })
      },

      /* LOGOUT */

      logout: () => {

        clearAuthCookie()

        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          isAuthenticated: false,
          error: null,
        })
      },

      /* TOKENS */

      setTokens: (accessToken, refreshToken) => {

        setAuthCookie(accessToken)

        set({
          accessToken,
          refreshToken,
          isAuthenticated: true,
        })
      },

      /* USER */

      setUser: (user) => set({ user }),

      /* STATE HELPERS */

      setLoading: (value) => set({ isLoading: value }),

      setError: (error) => set({ error }),

      clearError: () => set({ error: null }),

      /* RESET */

      reset: () => {

        clearAuthCookie()

        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          isAuthenticated: false,
          isLoading: false,
          error: null,
        })
      },

    }),
    {
      name: 'auth-storage',

      storage: createJSONStorage(() => localStorage),

      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)