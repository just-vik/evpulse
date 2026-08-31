'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, RefreshCw, X, WifiOff } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useOfflineStatus } from '@/hooks/useOfflineStatus';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';

type BannerKind = 'auth_expired' | 'telemetry_stale' | 'network_offline';

interface BannerConfig {
  kind: BannerKind;
  priority: number; // higher = more important
  icon: React.ElementType;
  classes: string;
  textKey: string;
  linkKey?: string;
  linkHref?: string;
}

const BANNER_CONFIGS: Record<BannerKind, BannerConfig> = {
  auth_expired: {
    kind: 'auth_expired',
    priority: 100,
    icon: AlertTriangle,
    classes: 'bg-red-600/95 text-white border-red-500/50',
    textKey: 'settings.vehicles.authExpiredBanner',
    linkKey: 'settings.vehicles.reauthAction',
    linkHref: '/settings',
  },
  telemetry_stale: {
    kind: 'telemetry_stale',
    priority: 50,
    icon: RefreshCw,
    classes: 'bg-amber-600/95 text-white border-amber-500/50',
    textKey: 'settings.vehicles.telemetryStaleBanner',
    linkKey: 'settings.vehicles.openSettingsAction',
    linkHref: '/settings',
  },
  network_offline: {
    kind: 'network_offline',
    priority: 80,
    icon: WifiOff,
    classes: 'bg-slate-700/98 text-white border-slate-600/50',
    textKey: 'system.networkOffline',
    linkKey: undefined,
    linkHref: undefined,
  },
};

const BANNER_H_PX = 36;

export function GlobalStatusBar() {
  const { accessToken } = useAuthStore();
  const { t } = useTranslation();
  const isOffline = useOfflineStatus();

  const [authBanner, setAuthBanner] = useState<'auth_expired' | 'telemetry_stale' | null>(null);
  const [dismissed, setDismissed] = useState<Set<BannerKind>>(new Set());

  // Fetch Tesla auth/telemetry status once on mount
  useEffect(() => {
    if (!accessToken) return;
    fetch('/api/v1/auth/tesla/status', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then(r => r.json())
      .then(data => {
        if (data?.authExpired) setAuthBanner('auth_expired');
        else if (data?.dataBlockedReason === 'telemetry_stale') setAuthBanner('telemetry_stale');
        else setAuthBanner(null);
      })
      .catch(() => {});
  }, [accessToken]);

  // Collect active banners by priority
  const activeBanners: BannerConfig[] = [];
  if (isOffline && !dismissed.has('network_offline')) {
    activeBanners.push(BANNER_CONFIGS.network_offline);
  }
  if (authBanner === 'auth_expired' && !dismissed.has('auth_expired')) {
    activeBanners.push(BANNER_CONFIGS.auth_expired);
  } else if (authBanner === 'telemetry_stale' && !dismissed.has('telemetry_stale')) {
    activeBanners.push(BANNER_CONFIGS.telemetry_stale);
  }

  // Show only the highest priority
  const top = activeBanners.sort((a, b) => b.priority - a.priority)[0] ?? null;

  // Manage CSS variable so main content can offset
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--status-bar-h',
      top ? `${BANNER_H_PX}px` : '0px',
    );
    return () => {
      document.documentElement.style.setProperty('--status-bar-h', '0px');
    };
  }, [top]);

  const dismiss = useCallback((kind: BannerKind) => {
    setDismissed(prev => new Set(prev).add(kind));
  }, []);

  if (!top) return null;

  const Icon = top.icon;

  return (
    <div
      className={`fixed inset-x-0 z-30 flex items-center gap-3 px-4 border-b backdrop-blur-sm ${top.classes}`}
      style={{ top: '3.5rem', height: `${BANNER_H_PX}px` }}
    >
      <Icon size={13} className="shrink-0" />
      <span className="flex-1 text-xs">
        {t(top.textKey, { defaultValue: top.textKey })}
      </span>
      {top.linkHref && top.linkKey && (
        <Link
          href={top.linkHref}
          className="text-xs font-semibold underline underline-offset-2 hover:no-underline shrink-0"
        >
          {t(top.linkKey, { defaultValue: 'Fix →' })} →
        </Link>
      )}
      {top.kind !== 'network_offline' && (
        <button
          onClick={() => dismiss(top.kind)}
          className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
