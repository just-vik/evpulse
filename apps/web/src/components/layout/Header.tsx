'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Sun,
  Moon,
  ChevronDown,
  LogOut,
  User,
  Car,
  Menu,
  Bell,
} from 'lucide-react';
import { EVPulseLogo } from '@/components/branding/EVPulseLogo';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { useLayoutStore } from '@/stores/layout.store';
import { useAuthStore } from '@/stores/authStore';
import { apiClient } from '@/lib/api';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useVehicles } from '@/hooks/useVehicles';

interface HeaderProps {
  onMenuClick?: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  const [mounted, setMounted] = useState(false);
  const [vehicleMenuOpen, setVehicleMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  const { accessToken, user, logout } = useAuthStore();
  const router = useRouter();

  const selectedVehicleId = useLayoutStore((s) => s.selectedVehicleId);
  const setSelectedVehicleId = useLayoutStore((s) => s.setSelectedVehicleId);

  // Use shared React Query cache — same queryKey ['vehicles'] as the rest of the app
  const { data: vehiclesData } = useVehicles();
  const vehicles = (vehiclesData ?? []) as Array<{ id: string; model?: string; trim?: string; year?: number; status?: string }>;

  const selectedVehicle =
    vehicles.find((v) => v.id === selectedVehicleId) ?? vehicles[0] ?? null;

  const { data: unreadData, refetch: refetchUnread } = useQuery({
    queryKey: ['notifications-unread'],
    queryFn: () => apiClient.getUnreadNotificationsCount(accessToken!),
    enabled: !!accessToken,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const unreadCount = unreadData?.count ?? 0;

  const { data: notifData, isLoading: notifLoading } = useQuery({
    queryKey: ['notifications-recent'],
    queryFn: () => apiClient.getNotifications(1, 10, accessToken!),
    enabled: !!accessToken && notifOpen,
    staleTime: 30_000,
  });

  useEffect(() => {
    setMounted(true);
  }, []);

  /* close menus on outside click */

  useEffect(() => {
    function closeMenus() {
      setUserMenuOpen(false);
      setVehicleMenuOpen(false);
      setNotifOpen(false);
    }

    window.addEventListener('click', closeMenus);

    return () => window.removeEventListener('click', closeMenus);
  }, []);

  /* auto-select first vehicle when list becomes available */

  useEffect(() => {
    if (vehicles.length > 0 && !selectedVehicleId) {
      setSelectedVehicleId(vehicles[0].id);
    }
  }, [vehicles, selectedVehicleId, setSelectedVehicleId]);

  const handleLogout = async () => {
    // Call the server-side signout route — it clears the httpOnly cookie
    // server-to-server and returns a proper Set-Cookie expiry header.
    try {
      await fetch('/api/auth/signout', { method: 'POST' });
    } catch {
      // ignore — still clear local state and navigate away
    }
    logout(); // clears Zustand state + JS-accessible cookie
    // Hard redirect so the browser sends a fresh request and the middleware
    // sees no cookie — router.push (soft nav) can be intercepted mid-flight
    // by the still-present httpOnly cookie before it is cleared.
    window.location.replace('/login');
  };

  const vehicleLabel = selectedVehicle
    ? `${selectedVehicle.model}${selectedVehicle.trim ? ` ${selectedVehicle.trim}` : ''}`
    : t('header.noVehicle');

  return (
    <header
      className="fixed top-0 left-0 right-0 z-40 bg-[#0B0B0F]/90 backdrop-blur-xl border-b border-white/[0.06]"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="h-14 flex items-center justify-between px-3 lg:px-6">
        {/* Left: hamburger + logo */}
        <div className="flex items-center gap-2">
          {/* Mobile menu */}
          <button
            onClick={e => {
              e.stopPropagation();
              onMenuClick?.();
            }}
            className="lg:hidden w-8 h-8 flex items-center justify-center rounded-lg text-white/40 hover:text-white/80 hover:bg-white/[0.05] transition-colors"
          >
            <Menu size={18} />
          </button>

          <EVPulseLogo markSize={40} className="brightness-110" />
        </div>

        {/* Vehicle selector */}

        <div className="flex-1 flex justify-center mx-2 lg:mx-8">
          {vehicles.length > 0 ? (
            <div className="relative w-32 sm:w-44 lg:w-64">

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setVehicleMenuOpen(!vehicleMenuOpen);
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08] transition-all text-white/80"
              >

                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className={clsx(
                      'w-2 h-2 rounded-full shrink-0',
                      selectedVehicle?.status === 'active'
                        ? 'bg-green-400'
                        : 'bg-slate-500'
                    )}
                  />
                  <span className="text-sm font-medium truncate" title={vehicleLabel}>
                    {vehicleLabel}
                  </span>
                </div>

                <ChevronDown
                  size={14}
                  className={clsx(
                    'shrink-0 ml-1 transition-transform text-slate-400',
                    vehicleMenuOpen && 'rotate-180'
                  )}
                />
              </button>

              {vehicleMenuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute top-full mt-2 w-full bg-[#0f1118]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl z-50"
                >

                  {vehicles.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => {
                        setSelectedVehicleId(v.id);
                        setVehicleMenuOpen(false);
                        router.refresh();
                      }}
                      className={clsx(
                        'w-full flex items-center gap-3 px-4 py-3 border-b border-white/[0.05] last:border-0 text-left',
                        selectedVehicle?.id === v.id
                          ? 'bg-blue-500/10 text-blue-400'
                          : 'text-white/70 hover:bg-white/[0.04] hover:text-white/90'
                      )}
                    >

                      <div
                        className={clsx(
                          'w-2 h-2 rounded-full',
                          v.status === 'active'
                            ? 'bg-green-500'
                            : 'bg-slate-500'
                        )}
                      />

                      <div className="min-w-0">
                        <div className="font-semibold text-sm truncate" title={`${v.model}${v.trim ? ` ${v.trim}` : ''}`}>
                          {v.model}
                          {v.trim && ` ${v.trim}`}
                        </div>

                        {v.year && (
                          <div className="text-xs text-slate-400">
                            {v.year}
                          </div>
                        )}
                      </div>

                    </button>
                  ))}

                </motion.div>
              )}
            </div>
          ) : (
            <Link
              href="/settings"
              className="text-sm text-slate-400 hover:text-slate-200 flex items-center gap-2"
            >
              <Car size={16} />
              {t('header.connectTesla')}
            </Link>
          )}
        </div>

        {/* Right side */}

        <div className="flex items-center gap-2">

          {/* Notification bell */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setNotifOpen(!notifOpen);
                setUserMenuOpen(false);
                setVehicleMenuOpen(false);
              }}
              className="relative w-8 h-8 flex items-center justify-center rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-white/45 hover:text-white/80 transition-colors"
            >
              <Bell size={16} />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-0.5">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {notifOpen && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                className="absolute right-0 mt-2 w-80 bg-[#0f1118]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl shadow-2xl overflow-hidden z-50"
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.07]">
                  <span className="text-sm font-semibold text-white/80">{t('header.notifications')}</span>
                  {unreadCount > 0 && (
                    <button
                      onClick={() => {
                        if (accessToken) {
                          apiClient.markAllNotificationsRead(accessToken).then(() => refetchUnread());
                        }
                      }}
                      className="text-xs text-blue-400 hover:text-blue-300 transition"
                    >
                      {t('header.markAllRead')}
                    </button>
                  )}
                </div>

                <div className="max-h-80 overflow-y-auto">
                  {notifLoading && (
                    <div className="flex items-center justify-center py-8">
                      <div className="w-5 h-5 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
                    </div>
                  )}
                  {!notifLoading && (!notifData?.data || notifData.data.length === 0) && (
                    <p className="text-sm text-slate-400 text-center py-8">{t('header.noNotifications')}</p>
                  )}
                  {notifData?.data?.map((n) => (
                    <div
                      key={n.id}
                      className={clsx(
                        'px-4 py-3 border-b border-white/[0.05] last:border-0',
                        !n.read && 'bg-blue-500/[0.05]'
                      )}
                    >
                      <div className="flex items-start gap-2">
                        {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 shrink-0 shadow-[0_0_6px_rgba(59,130,246,0.8)]" />}
                        <div className={clsx('flex-1 min-w-0', n.read && 'pl-3.5')}>
                          <p className="text-xs font-semibold text-white/85 truncate">{n.title}</p>
                          <p className="text-xs text-white/40 mt-0.5 line-clamp-2">{n.message}</p>
                          <p className="text-[10px] text-white/25 mt-1">
                            {new Date(n.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="px-4 py-2.5 border-t border-white/[0.06]">
                  <Link
                    href="/settings?tab=notifications"
                    onClick={() => setNotifOpen(false)}
                    className="text-xs text-blue-400 hover:text-blue-300 transition"
                  >
                    {t('header.notificationSettings')} →
                  </Link>
                </div>
              </motion.div>
            )}
          </div>

          {mounted && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() =>
                setTheme(theme === 'dark' ? 'light' : 'dark')
              }
              className="hidden sm:flex w-8 h-8 items-center justify-center rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-white/45 hover:text-white/80"
            >
              {theme === 'dark' ? (
                <Moon size={16} />
              ) : (
                <Sun size={16} />
              )}
            </motion.button>
          )}

          {/* User menu */}

          <div className="relative">

            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                setUserMenuOpen(!userMenuOpen);
              }}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-white/45 hover:text-white/80"
            >

              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center">
                <User size={14} className="text-white" />
              </div>

              {user && (
                <span className="text-sm font-medium text-white/70 hidden sm:inline max-w-[100px] truncate">
                  {user.firstName || user.email?.split('@')[0]}
                </span>
              )}

              <ChevronDown size={16} />

            </motion.button>

            {userMenuOpen && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="absolute right-0 mt-2 w-56 bg-[#0f1118]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl"
              >

                <Link
                  href="/settings"
                  className="flex items-center gap-2 px-4 py-3 text-white/60 hover:text-white/90 hover:bg-white/[0.04] border-b border-white/[0.05]"
                >
                  <User size={16} />
                  {t('header.profile')}
                </Link>

                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-4 py-3 text-white/60 hover:text-white/90 hover:bg-white/[0.04]"
                >
                  <LogOut size={16} />
                  {t('header.signOut')}
                </button>

              </motion.div>
            )}
          </div>

        </div>
      </div>
    </header>
  );
}