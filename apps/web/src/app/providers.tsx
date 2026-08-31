'use client'

import type React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { useEffect, useState } from 'react'
import { useUIStore } from '@/stores/uiStore'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      gcTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false
    },
    mutations: {
      retry: 1
    }
  }
})

function AccentApplier() {
  const accent = useUIStore((s) => s.accent)
  useEffect(() => {
    document.documentElement.setAttribute('data-accent', accent)
  }, [accent])
  return null
}

export function Providers({ children }: { children: React.ReactNode }) {

  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={true}
      themes={['dark', 'light', 'system']}
    >
      <QueryClientProvider client={queryClient}>
        <AccentApplier />
        {children}
      </QueryClientProvider>
    </ThemeProvider>
  )

}