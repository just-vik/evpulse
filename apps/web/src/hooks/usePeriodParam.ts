'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { QuickPeriod, PeriodValue } from '@/shared/ui/PeriodFilterBar';

/**
 * Like useState<PeriodValue>, but persisted in the URL query string.
 * ?period=30 → QuickPeriod(30)
 * ?from=2024-01-01&to=2024-01-31 → DateRange
 * No params → defaultPeriod
 *
 * Replaces the URL on change (no new history entry), preserving other params.
 */
export function usePeriodParam(defaultPeriod: QuickPeriod = 30): [PeriodValue, (v: PeriodValue) => void] {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const value = useMemo((): PeriodValue => {
    const from = searchParams.get('from');
    const to   = searchParams.get('to');
    if (from && to) {
      return { from: new Date(`${from}T00:00:00`), to: new Date(`${to}T23:59:59.999`) };
    }
    const p = searchParams.get('period');
    if (p) {
      const n = parseInt(p, 10);
      if (n === 7 || n === 30 || n === 90) return n as QuickPeriod;
    }
    return defaultPeriod;
  }, [searchParams, defaultPeriod]);

  const setValue = useCallback((v: PeriodValue) => {
    const params = new URLSearchParams(searchParams.toString());
    const isDefault = typeof v === 'number' && v === defaultPeriod;

    if (v == null || isDefault) {
      params.delete('period');
      params.delete('from');
      params.delete('to');
    } else if (typeof v === 'number') {
      params.set('period', String(v));
      params.delete('from');
      params.delete('to');
    } else {
      params.set('from', v.from.toISOString().slice(0, 10));
      params.set('to',   v.to.toISOString().slice(0, 10));
      params.delete('period');
    }

    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [searchParams, router, pathname, defaultPeriod]);

  return [value, setValue];
}
