'use client';

import React, { useEffect, useState } from 'react';
import { CheckCircle2, Circle, ExternalLink, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/authStore';
import { motion, AnimatePresence } from 'framer-motion';

interface SetupStep {
  id: string;
  done: boolean;
  labelKey: string;
  descKey?: string;
  href?: string;
  hrefLabelKey?: string;
}

interface Props {
  /** Show the wizard (e.g. after Tesla OAuth redirect with ?tesla=connected) */
  show: boolean;
  onDismiss: () => void;
}

export function SetupWizard({ show, onDismiss }: Props) {
  const { t } = useTranslation();
  const { accessToken } = useAuthStore();
  const [expanded, setExpanded] = useState(true);
  const [steps, setSteps] = useState<SetupStep[]>([
    {
      id: 'connected',
      done: true, // if we're showing this wizard, Tesla OAuth completed
      labelKey: 'setup.stepConnected',
      descKey: 'setup.stepConnectedDesc',
    },
    {
      id: 'streaming',
      done: false,
      labelKey: 'setup.stepStreaming',
      descKey: 'setup.stepStreamingDesc',
      href: 'https://tesla.com/_ak/evpulse.app',
      hrefLabelKey: 'setup.stepStreamingAction',
    },
    {
      id: 'virtualkey',
      done: false,
      labelKey: 'setup.stepVirtualKey',
      descKey: 'setup.stepVirtualKeyDesc',
      href: 'https://tesla.com/_ak/evpulse.app',
      hrefLabelKey: 'setup.stepVirtualKeyAction',
    },
  ]);

  // Check which setup steps are actually done
  useEffect(() => {
    if (!accessToken || !show) return;
    fetch('/api/v1/auth/tesla/status', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then(r => r.json())
      .then(data => {
        setSteps(prev => prev.map(s => {
          if (s.id === 'streaming') return { ...s, done: !!data?.streamingEnabled };
          if (s.id === 'virtualkey') return { ...s, done: !!data?.virtualKeyPaired };
          return s;
        }));
      })
      .catch(() => {});
  }, [accessToken, show]);

  if (!show) return null;

  const doneCount = steps.filter(s => s.done).length;
  const allDone = doneCount === steps.length;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        className="rounded-2xl border border-amber-500/25 bg-amber-500/8 overflow-hidden"
      >
        {/* Header row */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-foreground">
                {allDone
                  ? t('setup.allDone', { defaultValue: 'Tesla setup complete!' })
                  : t('setup.title', { defaultValue: 'Finish Tesla setup' })}
              </p>
              <span className="text-[10px] text-muted-foreground">
                {doneCount}/{steps.length}
              </span>
            </div>
            {!allDone && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('setup.subtitle', { defaultValue: 'Complete these steps to enable real-time data.' })}
              </p>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => setExpanded(e => !e)}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            <button
              onClick={onDismiss}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-0.5 bg-amber-500/10 mx-4">
          <motion.div
            className="h-full bg-amber-500/60 rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${(doneCount / steps.length) * 100}%` }}
            transition={{ duration: 0.4 }}
          />
        </div>

        {/* Steps */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="px-4 py-3 space-y-2.5">
                {steps.map((step, i) => (
                  <div key={step.id} className="flex items-start gap-3">
                    <div className="shrink-0 mt-0.5">
                      {step.done ? (
                        <CheckCircle2 size={16} className="text-emerald-400" />
                      ) : (
                        <Circle size={16} className="text-muted-foreground/40" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-medium ${step.done ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                        {i + 1}. {t(step.labelKey, { defaultValue: step.labelKey })}
                      </p>
                      {!step.done && step.descKey && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {t(step.descKey, { defaultValue: '' })}
                        </p>
                      )}
                    </div>
                    {!step.done && step.href && (
                      <a
                        href={step.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 transition-colors"
                      >
                        <ExternalLink size={10} />
                        {t(step.hrefLabelKey!, { defaultValue: 'Open →' })}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  );
}
