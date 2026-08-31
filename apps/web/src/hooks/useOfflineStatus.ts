'use client'

import { useEffect, useState } from 'react'

/** True when the browser reports no network (tunnels, airplane mode, etc.). */
export function useOfflineStatus() {
  const [isOffline, setIsOffline] = useState(
    () => (typeof navigator !== 'undefined' ? !navigator.onLine : false),
  )

  useEffect(() => {
    const onOnline = () => setIsOffline(false)
    const onOffline = () => setIsOffline(true)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  return isOffline
}
