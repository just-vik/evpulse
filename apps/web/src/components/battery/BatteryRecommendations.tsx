'use client';

import React from 'react';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';

interface HealthData {
  degradationPercent?: number;
  avgBatteryTempC?: number;
  sohPercent?: number;
}

interface Rec {
  id: string;
  status: 'ok' | 'warn' | 'info';
  title: string;
  detail: string;
}

interface Props {
  health: HealthData;
  defaultChargeLimit?: number | null;
  recentEndSoc?: number | null;
  className?: string;
}

const STATUS_ICON = {
  ok:   <CheckCircle2 size={14} className="text-emerald-400 shrink-0 mt-0.5" />,
  warn: <AlertCircle  size={14} className="text-amber-400  shrink-0 mt-0.5" />,
  info: <Info         size={14} className="text-sky-400    shrink-0 mt-0.5" />,
};

const STATUS_BG = {
  ok:   'bg-emerald-500/6  border-emerald-500/20',
  warn: 'bg-amber-500/6    border-amber-500/20',
  info: 'bg-sky-500/6      border-sky-500/20',
};

export function BatteryRecommendations({ health, defaultChargeLimit, recentEndSoc, className = '' }: Props) {
  const { t } = useTranslation();

  const recs: Rec[] = [];

  const effectiveLimit = defaultChargeLimit ?? recentEndSoc ?? null;
  if (effectiveLimit != null) {
    if (effectiveLimit > 90) {
      recs.push({
        id: 'chargeLimit',
        status: 'warn',
        title: t('battery.rec.chargeLimitTitle'),
        detail: t('battery.rec.chargeLimitDetail', { limit: Math.round(effectiveLimit) }),
      });
    } else if (effectiveLimit >= 70 && effectiveLimit <= 85) {
      recs.push({
        id: 'chargeLimit',
        status: 'ok',
        title: t('battery.rec.chargeLimitOkTitle'),
        detail: t('battery.rec.chargeLimitOkDetail', { limit: Math.round(effectiveLimit) }),
      });
    }
  } else {
    recs.push({
      id: 'chargeLimit',
      status: 'info',
      title: t('battery.rec.setChargeLimitTitle'),
      detail: t('battery.rec.setChargeLimitDetail'),
    });
  }

  if (health.avgBatteryTempC != null) {
    if (health.avgBatteryTempC < 5) {
      recs.push({
        id: 'temp',
        status: 'warn',
        title: t('battery.rec.coldTempTitle'),
        detail: t('battery.rec.coldTempDetail', { temp: health.avgBatteryTempC.toFixed(1) }),
      });
    } else if (health.avgBatteryTempC > 40) {
      recs.push({
        id: 'temp',
        status: 'warn',
        title: t('battery.rec.hotTempTitle'),
        detail: t('battery.rec.hotTempDetail', { temp: health.avgBatteryTempC.toFixed(1) }),
      });
    } else {
      recs.push({
        id: 'temp',
        status: 'ok',
        title: t('battery.rec.goodTempTitle'),
        detail: t('battery.rec.goodTempDetail', { temp: health.avgBatteryTempC.toFixed(1) }),
      });
    }
  }

  if (health.degradationPercent != null) {
    if (health.degradationPercent > 15) {
      recs.push({
        id: 'degradation',
        status: 'warn',
        title: t('battery.rec.highDegTitle'),
        detail: t('battery.rec.highDegDetail', { pct: health.degradationPercent.toFixed(1) }),
      });
    } else if (health.degradationPercent > 8) {
      recs.push({
        id: 'degradation',
        status: 'info',
        title: t('battery.rec.moderateDegTitle'),
        detail: t('battery.rec.moderateDegDetail', { pct: health.degradationPercent.toFixed(1) }),
      });
    } else {
      recs.push({
        id: 'degradation',
        status: 'ok',
        title: t('battery.rec.goodDegTitle'),
        detail: t('battery.rec.goodDegDetail', { pct: health.degradationPercent.toFixed(1) }),
      });
    }
  }

  if (recs.length === 0) return null;

  return (
    <div className={`space-y-2 ${className}`}>
      {recs.map((rec, i) => (
        <motion.div
          key={rec.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          className={`flex items-start gap-2.5 p-3 rounded-xl border ${STATUS_BG[rec.status]}`}
        >
          {STATUS_ICON[rec.status]}
          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground leading-snug">{rec.title}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{rec.detail}</p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
