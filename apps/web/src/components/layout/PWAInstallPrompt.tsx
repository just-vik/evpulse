'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Share } from 'lucide-react';
import { EVPulseMark } from '@/components/branding/EVPulseMark';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Don't show if already installed or dismissed
    if (
      typeof window === 'undefined' ||
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true
    ) return;

    const stored = localStorage.getItem('pwa-install-dismissed');
    if (stored && Date.now() - Number(stored) < 7 * 24 * 60 * 60 * 1000) return;

    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) &&
      !(window as any).MSStream;

    if (ios) {
      setIsIOS(true);
      // Show after a short delay on iOS Safari
      setTimeout(() => setShowPrompt(true), 3000);
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setTimeout(() => setShowPrompt(true), 2000);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setShowPrompt(false);
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    setShowPrompt(false);
    setDismissed(true);
    localStorage.setItem('pwa-install-dismissed', String(Date.now()));
  };

  if (dismissed || !showPrompt) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 80 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 80 }}
        className="fixed bottom-20 left-4 right-4 z-50 md:left-auto md:right-6 md:w-80"
      >
        <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-2xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl overflow-hidden border border-cyan-500/20 flex-shrink-0 bg-[#0a0f18] flex items-center justify-center p-0.5">
              <EVPulseMark size={36} variant="soft" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-white text-sm">Install EVPulse</p>
              {isIOS ? (
                <p className="text-slate-400 text-xs mt-0.5">
                  Tap <Share className="inline w-3 h-3" /> then "Add to Home Screen"
                </p>
              ) : (
                <p className="text-slate-400 text-xs mt-0.5">
                  Add to home screen for the best experience
                </p>
              )}
            </div>
            <button
              onClick={handleDismiss}
              className="text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {!isIOS && (
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleDismiss}
                className="flex-1 py-1.5 rounded-lg text-xs text-slate-400 border border-slate-600 hover:border-slate-500 transition-colors"
              >
                Not now
              </button>
              <button
                onClick={handleInstall}
                className="flex-1 py-1.5 rounded-lg text-xs text-white bg-blue-600 hover:bg-blue-500 transition-colors font-medium"
              >
                Install
              </button>
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
