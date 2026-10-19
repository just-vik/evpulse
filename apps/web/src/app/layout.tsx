import type { Metadata } from 'next'
import type React from 'react'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'ROVIQEN',
  description: 'Premium EV intelligence — real-time analytics, trip tracking and fleet management',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'ROVIQEN',
  },
  icons: {
    icon: [
      { url: '/favicon.ico',           sizes: '16x16 32x32 48x48', type: 'image/x-icon' },
      { url: '/icons/favicon-32.png',  sizes: '32x32',  type: 'image/png' },
      { url: '/icons/icon-192.png',    sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png',    sizes: '512x512', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    apple: [
      { url: '/icons/apple-touch-icon.png', sizes: '180x180' },
    ],
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
        {/* Theme color: dark default, light override for light-scheme browsers */}
        <meta name="theme-color" content="#0C0F11" media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content="#F1F5EE" media="(prefers-color-scheme: light)" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        {/* Apple touch icons — dark is default, light for iOS 18 light mode */}
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" sizes="180x180" />
        {/* Favicon SVG — modern browsers pick this up automatically */}
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
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