'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  LayoutDashboard, Navigation, BatteryCharging, Zap,
  Settings, Car, Search, ChevronRight,
} from 'lucide-react';
import { useCommandStore } from './useCommandStore';
import { useLayoutStore } from '@/stores/layout.store';
import { useAuthStore } from '@/stores/authStore';
import { apiClient } from '@/lib/api';

interface Command {
  id: string;
  label: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  group: string;
  action: (ctx: { router: ReturnType<typeof useRouter>; vehicleId: string | null; token: string | null }) => void | Promise<void>;
}

const COMMANDS: Command[] = [
  { id: 'nav-dashboard',  label: 'Dashboard',      description: 'Go to overview',           icon: LayoutDashboard,  group: 'Navigate', action: ({ router }) => router.push('/dashboard') },
  { id: 'nav-trips',      label: 'Trips',           description: 'View trip history',         icon: Navigation,       group: 'Navigate', action: ({ router }) => router.push('/trips') },
  { id: 'nav-charging',   label: 'Charging',        description: 'Charging sessions',         icon: BatteryCharging,  group: 'Navigate', action: ({ router }) => router.push('/charging') },
  { id: 'nav-battery',    label: 'Battery',         description: 'Battery health analytics',  icon: Zap,              group: 'Navigate', action: ({ router }) => router.push('/battery') },
  { id: 'nav-settings',   label: 'Settings',        description: 'App preferences',           icon: Settings,         group: 'Navigate', action: ({ router }) => router.push('/settings') },
  { id: 'nav-vehicles',   label: 'Vehicles',        description: 'Manage vehicles',           icon: Car,              group: 'Navigate', action: ({ router }) => router.push('/vehicles') },
  { id: 'cmd-wake',       label: 'Wake vehicle',    description: 'Send wake command',         icon: Zap,              group: 'Vehicle',  action: async ({ vehicleId, token }) => { if (vehicleId && token) await apiClient.sendCommand(vehicleId, 'wake', token) } },
];

export function CommandPalette() {
  const router = useRouter();
  const { open, query, closePalette, setQuery } = useCommandStore();
  const selectedVehicleId = useLayoutStore((s) => s.selectedVehicleId);
  const { accessToken } = useAuthStore();
  const [selected, setSelected] = React.useState(0);

  // Register ⌘K / Ctrl+K
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        useCommandStore.getState().openPalette();
      }
      if (e.key === 'Escape') {
        useCommandStore.getState().closePalette();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const filtered = React.useMemo(() => {
    const q = query.toLowerCase();
    return q ? COMMANDS.filter(c =>
      c.label.toLowerCase().includes(q) ||
      (c.description ?? '').toLowerCase().includes(q)
    ) : COMMANDS;
  }, [query]);

  // Group filtered commands
  const groups = React.useMemo(() => {
    const map = new Map<string, Command[]>();
    for (const cmd of filtered) {
      const list = map.get(cmd.group) ?? [];
      list.push(cmd);
      map.set(cmd.group, list);
    }
    return map;
  }, [filtered]);

  // Keyboard navigation
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, filtered.length - 1)); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
      if (e.key === 'Enter') {
        const cmd = filtered[selected];
        if (cmd) { cmd.action({ router, vehicleId: selectedVehicleId, token: accessToken }); closePalette(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, filtered, selected, router, selectedVehicleId, accessToken, closePalette]);

  React.useEffect(() => setSelected(0), [query]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
            onClick={closePalette}
          />

          {/* Palette */}
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ duration: 0.15 }}
            className="fixed top-[15vh] left-1/2 -translate-x-1/2 w-full max-w-lg z-50 mx-4"
          >
            <div className="bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden">
              {/* Input */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800">
                <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search commands…"
                  className="flex-1 bg-transparent outline-none text-white text-sm placeholder-slate-500"
                />
                <kbd className="text-[10px] text-slate-500 border border-slate-700 rounded px-1.5 py-0.5">ESC</kbd>
              </div>

              {/* Results */}
              <div className="max-h-72 overflow-y-auto py-2">
                {filtered.length === 0 ? (
                  <p className="text-center text-sm text-slate-500 py-8">No commands found</p>
                ) : (
                  (() => {
                    let flatIndex = 0;
                    return Array.from(groups.entries()).map(([group, cmds]) => (
                      <div key={group}>
                        <p className="px-4 py-1 text-[10px] uppercase tracking-widest text-slate-600">{group}</p>
                        {cmds.map((cmd) => {
                          const idx = flatIndex++;
                          const Icon = cmd.icon;
                          const isSelected = idx === selected;
                          return (
                            <button
                              key={cmd.id}
                              onMouseEnter={() => setSelected(idx)}
                              onClick={() => { cmd.action({ router, vehicleId: selectedVehicleId, token: accessToken }); closePalette(); }}
                              className={`
                                w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors
                                ${isSelected ? 'bg-slate-800' : 'hover:bg-slate-800/50'}
                              `}
                            >
                              <div className="w-7 h-7 rounded-lg bg-slate-800/80 flex items-center justify-center flex-shrink-0">
                                <Icon className="w-3.5 h-3.5 text-slate-400" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm text-white">{cmd.label}</p>
                                {cmd.description && <p className="text-xs text-slate-500">{cmd.description}</p>}
                              </div>
                              {isSelected && <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    ));
                  })()
                )}
              </div>

              {/* Footer hint */}
              <div className="px-4 py-2 border-t border-slate-800 flex items-center gap-3 text-[10px] text-slate-600">
                <span><kbd className="border border-slate-700 rounded px-1">↑↓</kbd> navigate</span>
                <span><kbd className="border border-slate-700 rounded px-1">↵</kbd> open</span>
                <span><kbd className="border border-slate-700 rounded px-1">⌘K</kbd> toggle</span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
