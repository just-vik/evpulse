'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  DashboardIcon,
  VehicleIcon,
  TripIcon,
  ChargingIcon,
  BatteryIcon,
  ExportIcon,
  SettingsIcon,
} from '@/components/icons/NavIcons';
import { EVPulseLogo } from '@/components/branding/EVPulseLogo';
import { useLayoutStore } from '@/stores/layout.store';

interface NavItem {
  key: string;
  href: string;
  icon: React.ReactNode;
  badge?: number;
}

const navItems: NavItem[] = [
  { key: 'dashboard', href: '/dashboard', icon: <DashboardIcon size={20} /> },
  { key: 'trips',     href: '/trips',     icon: <TripIcon size={20} /> },
  { key: 'charging',  href: '/charging',  icon: <ChargingIcon size={20} /> },
  { key: 'battery',   href: '/battery',   icon: <BatteryIcon size={20} /> },
  { key: 'vehicles',  href: '/vehicles',  icon: <VehicleIcon size={20} /> },
];

const utilityItems: NavItem[] = [
  { key: 'export',    href: '/export',    icon: <ExportIcon size={18} /> },
  { key: 'settings',  href: '/settings',  icon: <SettingsIcon size={18} /> },
];

function NavLink({ item, index, pathname, t, onNavigate }: {
  item: NavItem;
  index: number;
  pathname: string;
  t: (k: string) => string;
  onNavigate: () => void;
}) {
  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
  return (
    <motion.div
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.04, ease: 'easeOut' }}
    >
      <Link href={item.href} onClick={onNavigate}>
        <div
          className={clsx(
            'relative flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 group cursor-pointer',
            !isActive && 'text-white/40 hover:text-white/80 hover:bg-white/[0.05]',
          )}
          style={isActive ? {
            background: 'linear-gradient(90deg, color-mix(in srgb, var(--a-500) 13%, transparent) 0%, color-mix(in srgb, var(--a-500) 4%, transparent) 60%, transparent 100%)',
            boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--a-500) 10%, transparent)',
          } : undefined}
        >
          {/* Left glow indicator */}
          {isActive && (
            <motion.div
              layoutId="activeIndicator"
              className="absolute left-0 inset-y-[6px] w-[3px] rounded-r-full"
              style={{ background: 'var(--a-500)', boxShadow: '0 0 12px 3px var(--a-glow)' }}
              transition={{ type: 'spring', stiffness: 400, damping: 35 }}
            />
          )}

          {/* Icon */}
          <div
            className={clsx(
              'shrink-0 transition-all duration-150',
              isActive ? 'scale-110' : 'group-hover:scale-105 group-hover:text-white/70'
            )}
            style={isActive ? { color: 'var(--a-500)' } : undefined}
          >
            {item.icon}
          </div>

          {/* Label */}
          <span className={clsx(
            'font-medium text-sm flex-1 transition-colors duration-150',
            isActive ? 'text-white/95' : 'text-white/42 group-hover:text-white/78'
          )}>
            {t(`nav.${item.key}`)}
          </span>

          {/* Badge */}
          {item.badge && (
            <span
              className="text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none"
              style={{ background: 'color-mix(in srgb, var(--a-500) 80%, transparent)' }}
            >
              {item.badge}
            </span>
          )}

          {/* Active pulse dot */}
          {isActive && (
            <div className="relative shrink-0 w-1.5 h-1.5">
              <div className="absolute inset-0 rounded-full animate-ping" style={{ background: 'color-mix(in srgb, var(--a-500) 40%, transparent)' }} />
              <div className="relative w-full h-full rounded-full" style={{ background: 'color-mix(in srgb, var(--a-500) 70%, transparent)' }} />
            </div>
          )}
        </div>
      </Link>
    </motion.div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useTranslation();
  const setMobileSidebarOpen = useLayoutStore((s) => s.setMobileSidebarOpen);

  const handleNavClick = () => {
    setMobileSidebarOpen(false);
  };

  return (
    <aside className="
      w-64 h-full flex flex-col
      bg-gradient-to-b from-[#0d1018] via-[#0a0c14] to-[#080b12]
      border-r border-white/[0.055]
      overflow-y-auto scrollbar-hide
    ">
      {/* Brand */}
      <div className="px-5 pb-3" style={{ paddingTop: 'calc(1.25rem + env(safe-area-inset-top))' }}>
        <EVPulseLogo markSize={42} onNavigate={handleNavClick} className="brightness-110" />
      </div>

      {/* Divider */}
      <div className="mx-4 mb-3 h-px bg-gradient-to-r from-transparent via-white/[0.07] to-transparent" />

      {/* Primary nav */}
      <nav className="flex flex-col gap-0.5 px-3 flex-1">
        {navItems.map((item, index) => (
          <NavLink key={item.href} item={item} index={index} pathname={pathname} t={t} onNavigate={handleNavClick} />
        ))}

        {/* Utility section label */}
        <div className="px-1 pt-4 pb-1.5">
          <div className="h-px bg-gradient-to-r from-transparent via-white/[0.065] to-transparent mb-3" />
          <p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-white/20 px-2">
            {t('nav.manage', { defaultValue: 'Управление' })}
          </p>
        </div>

        {/* Utility nav */}
        {utilityItems.map((item, index) => (
          <NavLink key={item.href} item={item} index={navItems.length + 1 + index} pathname={pathname} t={t} onNavigate={handleNavClick} />
        ))}
      </nav>

      {/* Bottom safe area */}
      <div className="h-4" />
    </aside>
  );
}
