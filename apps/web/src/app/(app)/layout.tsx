'use client'

import { PropsWithChildren, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Container } from '@/components/layout'
import { CommandPalette } from '@/features/command/CommandPalette'
import { AIChat, useAIChatStore } from '@/features/ai/AIChat'
import { Sparkles, X } from 'lucide-react'
import { I18nProvider } from '@/providers/I18nProvider'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/authStore'
import { GlobalStatusBar } from '@/components/system/GlobalStatusBar'
import { ServiceWorkerRegister } from '@/components/system/ServiceWorkerRegister'
import { ErrorBoundary } from '@/components/system/ErrorBoundary'
import { UIStoreCrossTabSync } from '@/components/system/UIStoreCrossTabSync'

const AI_FAB_KEY = 'ai-fab-hidden'

function AIChatToggle() {
  const { open, openChat } = useAIChatStore()
  const { t } = useTranslation()
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    setHidden(localStorage.getItem(AI_FAB_KEY) === '1')
  }, [])

  if (open) return null

  const dismiss = (e: React.MouseEvent) => {
    e.stopPropagation()
    setHidden(true)
    localStorage.setItem(AI_FAB_KEY, '1')
  }

  const restore = () => {
    setHidden(false)
    localStorage.removeItem(AI_FAB_KEY)
  }

  if (hidden) {
    return (
      <button
        onClick={restore}
        className="fixed right-4 z-30 w-6 h-6 rounded-full border flex items-center justify-center shadow-sm transition-colors"
        style={{
          bottom: 'calc(var(--fab-offset) + env(safe-area-inset-bottom))',
          background: 'color-mix(in srgb, var(--a-500) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--a-500) 20%, transparent)', color: 'color-mix(in srgb, var(--a-500) 35%, transparent)',
        }}
        title={t('ai.askAnything')}
      >
        <Sparkles className="w-3 h-3" />
      </button>
    )
  }

  return (
    <div
      className="fixed right-4 z-30 flex flex-col items-end gap-1"
      style={{ bottom: 'calc(var(--fab-offset) + env(safe-area-inset-bottom))' }}
    >
      <button
        onClick={dismiss}
        className="lg:hidden w-5 h-5 rounded-full bg-white/8 hover:bg-white/15 border border-white/10 flex items-center justify-center text-white/35 hover:text-white/60 transition-colors"
        title="Скрыть"
      >
        <X className="w-2.5 h-2.5" />
      </button>
      <button
        onClick={() => openChat()}
        className="w-11 h-11 rounded-full bg-brand-500/20 hover:bg-brand-500/30 border border-brand-500/30 flex items-center justify-center text-brand-500 shadow-lg transition-colors"
        title={t('ai.askAnything')}
        aria-label={t('ai.askAnything')}
      >
        <Sparkles className="w-5 h-5" />
      </button>
    </div>
  )
}

function readCookieToken(): string | null {
  if (typeof document === 'undefined') return null
  return (
    document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('access_token='))
      ?.slice('access_token='.length) ?? null
  )
}

export default function AppLayout({ children }: PropsWithChildren) {
  const { isAuthenticated, login } = useAuthStore()
  const router = useRouter()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (isAuthenticated) {
      // Zustand already hydrated from localStorage — all good
      setReady(true)
      return
    }

    // iOS PWA: localStorage is isolated from Safari, so Zustand may be empty
    // even though the session cookie is valid. Try to recover via /auth/me.
    const token = readCookieToken()
    if (!token) {
      // No cookie at all — genuinely unauthenticated
      router.replace('/login')
      return
    }

    fetch('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    })
      .then(async (r) => {
        if (r.ok) {
          const user = await r.json()
          login(token, '', user)
          setReady(true)
        } else {
          router.replace('/login')
        }
      })
      .catch(() => router.replace('/login'))
  }, [isAuthenticated]) // eslint-disable-line react-hooks/exhaustive-deps

  // Show dark splash until we know auth state (prevents white/blank flash in PWA)
  if (!ready && !isAuthenticated) {
    return <div className="min-h-dvh" style={{ background: 'var(--s-base)' }} />
  }

  return (
    <I18nProvider>
      <UIStoreCrossTabSync />
      <ServiceWorkerRegister />
      <GlobalStatusBar />
      <Container>
        <ErrorBoundary>{children}</ErrorBoundary>
      </Container>
      <CommandPalette />
      <AIChat />
      <AIChatToggle />
    </I18nProvider>
  )
}
