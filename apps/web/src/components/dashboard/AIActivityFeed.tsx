'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, CheckCircle2, XCircle, Clock, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/authStore';
import { apiClient } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';

interface Props {
  vehicleId: string;
}

export function AIActivityFeed({ vehicleId }: Props) {
  const { accessToken } = useAuthStore();
  const { t } = useTranslation();

  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('ai-feed-collapsed') === 'true';
  });

  const { data, isLoading } = useQuery({
    queryKey: ['ai-activity', vehicleId],
    queryFn: () => apiClient.getAIActivity(vehicleId, accessToken!),
    enabled: !!vehicleId && !!accessToken,
    refetchInterval: 30_000,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: false,
  });

  if (isLoading || !data || data.length === 0) return null;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem('ai-feed-collapsed', String(next)); } catch {}
  };

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full text-xs uppercase tracking-widest text-muted-foreground mb-3 font-medium flex items-center gap-1.5 hover:text-foreground transition-colors"
      >
        <Bot className="w-3 h-3" />
        {t('dashboard.aiActivity')}
        <ChevronDown
          className={`w-3 h-3 ml-auto transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="feed"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="rounded-2xl bg-[hsl(var(--card))] border border-[hsl(var(--border)/0.6)] overflow-hidden">
              {data.slice(0, 5).map((item, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className={`flex items-center gap-3 px-4 py-2.5 ${i < data.length - 1 ? 'border-b border-[hsl(var(--border)/0.5)]' : ''}`}
                >
                  {item.success
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                    : <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
                  <p className="text-xs text-foreground flex-1">
                    {t(`aiCommands.${item.action}`, { defaultValue: item.action })}
                  </p>
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock className="w-2.5 h-2.5" />
                    {new Date(item.executedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
