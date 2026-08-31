'use client'

import { useEffect } from 'react'

/** Registers `/sw.js` so push + offline caching work without opening Settings. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
  }, [])
  return null
}
