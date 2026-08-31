import type { Metadata } from 'next'
import type React from 'react'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'EVPulse',
  description: 'Real-time Tesla analytics, trip tracking and fleet management',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'EVPulse',
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48', type: 'image/x-icon' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    apple: '/icons/apple-touch-icon.png',
  },
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#a855f7" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" sizes="180x180" />
      </head>

      <body suppressHydrationWarning>
        {/* Remove stale SWs from old versions (only those NOT matching /sw.js) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistrations().then(function(regs) {
                  regs.forEach(function(r) {
                    var url = (r.active || r.installing || r.waiting || {}).scriptURL || '';
                    if (url && !url.endsWith('/sw.js')) r.unregister();
                  });
                });
              }
            `,
          }}
        />

        <Providers>
          {children}
        </Providers>

      </body>

    </html>
  )

}