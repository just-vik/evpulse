'use client';

import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { PWAInstallPrompt } from './PWAInstallPrompt';
import { useLayoutStore } from '@/stores/layout.store';

interface ContainerProps {
  children: React.ReactNode;
}

export function Container({ children }: ContainerProps) {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useLayoutStore();
  const mainRef = useRef<HTMLElement>(null);

  // Close on Escape
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') setMobileSidebarOpen(false);
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setMobileSidebarOpen]);

  // Force layout recalc after orientation change to clear stale svh snapshot
  useEffect(() => {
    const handleOrientationChange = () => {
      requestAnimationFrame(() => {
        if (mainRef.current) {
          mainRef.current.style.overflow = 'hidden';
          requestAnimationFrame(() => {
            if (mainRef.current) mainRef.current.style.overflow = '';
          });
        }
      });
    };
    screen.orientation?.addEventListener('change', handleOrientationChange);
    return () => screen.orientation?.removeEventListener('change', handleOrientationChange);
  }, []);

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (mobileSidebarOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileSidebarOpen]);

  return (
    <div className="flex h-dvh bg-[hsl(var(--background))] overflow-hidden">

      {/* Desktop sidebar */}
      <div className="hidden lg:flex relative z-10 shrink-0">
        <Sidebar />
      </div>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileSidebarOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
              onClick={() => setMobileSidebarOpen(false)}
            />

            {/* Drawer panel */}
            <motion.div
              key="drawer"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              className="fixed inset-y-0 left-0 z-50 w-64 lg:hidden flex"
            >
              <div className="relative flex-1">
                <Sidebar />
                <button
                  onClick={() => setMobileSidebarOpen(false)}
                  className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/[0.06] transition-colors z-10"
                >
                  <X size={15} />
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative z-10">
        <Header onMenuClick={() => setMobileSidebarOpen(true)} />
        <main ref={mainRef} className="flex-1 overflow-y-auto bg-[hsl(var(--background))]">
          <div className="px-4 lg:px-6 max-w-6xl mx-auto"
               style={{
                 paddingTop: 'calc(3.5rem + var(--status-bar-h, 0px) + env(safe-area-inset-top))',
                 paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
               }}>
            {children}
          </div>
        </main>

        <PWAInstallPrompt />
      </div>
    </div>
  );
}