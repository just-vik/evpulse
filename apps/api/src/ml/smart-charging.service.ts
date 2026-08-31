import { Injectable } from '@nestjs/common';

export interface PriceSlot {
  hour: number;       // 0–23
  pricePerKwh: number; // €/kWh
}

export interface ChargingPlanSlot {
  hour:        number;
  pricePerKwh: number;
  chargeKwh:   number;
  costEur:     number;
}

export interface SmartChargingSuggestion {
  plan:                ChargingPlanSlot[];
  totalCostEur:        number;
  savedVsImmediateEur: number;
  neededKwh:           number;
  recommendation:      string;
  cappedAt80Pct:       boolean; // whether target was reduced for battery protection
  tempDelayed:         boolean; // whether charging should be delayed due to cold battery
  lfpFullCharge:       boolean; // whether this is a LFP weekly 100% cycle
}

/**
 * SmartChargingService
 *
 * Produces an optimal charging schedule from a 24-hour electricity price
 * forecast (e.g. from Tibber, Nordpool, or a manual tariff).
 *
 * Constraints:
 *   - Default daily SOC cap of 80% (protects Li-ion longevity)
 *   - LFP batteries: allow 100% weekly full charge (keeps BMS calibrated)
 *   - Battery temp < 5°C → flag delayed start (cold charging damages cells)
 *   - Degradation-aware: if already at / above cap, no charging needed
 *   - Skips slots priced above 140% of the average (peak avoidance)
 *   - Night hours (22–06) are tie-broken first among equal-priced slots
 *   - Remaining demand after exhausting cheap slots falls back to
 *     the cheapest remaining slot (never leaves the car under-charged)
 */
@Injectable()
export class SmartChargingService {
  suggest(params: {
    currentSoc:       number;
    targetSoc:        number;
    priceSchedule:    PriceSlot[];
    batteryKwh?:      number;
    maxDailySocPct?:  number;   // battery protection cap (default 80)
    chargingSpeedKw?: number;   // AC home charger speed (default 11 kW)
    batteryTempC?:    number;   // current battery temperature
    batteryType?:     'NMC' | 'LFP'; // NMC default; LFP allows 100% weekly
    dayOfWeek?:       number;   // 0=Sun…6=Sat — for LFP weekly full charge
  }): SmartChargingSuggestion {
    const {
      currentSoc,
      priceSchedule,
      batteryKwh      = 75,
      maxDailySocPct  = 80,
      chargingSpeedKw = 11,
      batteryTempC,
      batteryType     = 'NMC',
      dayOfWeek,
    } = params;

    // ── Temperature guard ─────────────────────────────────────────────
    // Charging a cold Li-ion battery causes lithium plating → permanent damage.
    const COLD_LIMIT_C  = 5;
    const tempDelayed   = batteryTempC != null && batteryTempC < COLD_LIMIT_C;

    // ── LFP weekly full charge ────────────────────────────────────────
    // LFP cells need a full charge periodically to keep BMS cell balancing accurate.
    // Allow 100% on Sunday (dayOfWeek = 0) for LFP batteries.
    const isLfpFullChargeDay = batteryType === 'LFP' && dayOfWeek === 0;
    const lfpFullCharge      = isLfpFullChargeDay && currentSoc < 95;

    // Effective cap: LFP full charge day → 100%; otherwise honour maxDailySocPct
    const effectiveCap    = lfpFullCharge ? 100 : maxDailySocPct;
    const cappedAt80Pct   = params.targetSoc > effectiveCap;
    const effectiveTarget = Math.min(params.targetSoc, effectiveCap);
    const neededSoc       = Math.max(0, effectiveTarget - currentSoc);
    const neededKwh       = batteryKwh * (neededSoc / 100);

    if (tempDelayed) {
      return {
        plan: [], totalCostEur: 0, savedVsImmediateEur: 0,
        neededKwh: Math.round(neededKwh * 10) / 10,
        recommendation: `Battery temperature is ${batteryTempC?.toFixed(0)}°C — delay charging until battery warms above ${COLD_LIMIT_C}°C to prevent cell damage`,
        cappedAt80Pct,
        tempDelayed: true,
        lfpFullCharge,
      };
    }

    if (neededSoc <= 0 || !priceSchedule.length) {
      return {
        plan: [], totalCostEur: 0, savedVsImmediateEur: 0,
        neededKwh: 0,
        recommendation: currentSoc >= effectiveTarget
          ? `Already at ${currentSoc}% — no charging needed`
          : 'No price data available',
        cappedAt80Pct,
        tempDelayed: false,
        lfpFullCharge,
      };
    }

    const avgPrice = priceSchedule.reduce((s, p) => s + p.pricePerKwh, 0) / priceSchedule.length;
    const isNight  = (h: number) => h >= 22 || h <= 6;

    // Sort: cheapest first; within ±€0.02 band, prefer night slots
    const sorted = [...priceSchedule].sort((a, b) => {
      const diff = a.pricePerKwh - b.pricePerKwh;
      if (Math.abs(diff) > 0.02) return diff;
      return (isNight(a.hour) ? 0 : 1) - (isNight(b.hour) ? 0 : 1);
    });

    let remaining = neededKwh;
    const plan: ChargingPlanSlot[] = [];

    // Pass 1: use cheap slots (≤ 140% of average)
    for (const slot of sorted) {
      if (remaining <= 0) break;
      if (slot.pricePerKwh > avgPrice * 1.4) continue;

      const chargeKwh = Math.min(remaining, chargingSpeedKw);
      plan.push({
        hour:        slot.hour,
        pricePerKwh: slot.pricePerKwh,
        chargeKwh:   Math.round(chargeKwh * 10) / 10,
        costEur:     Math.round(chargeKwh * slot.pricePerKwh * 100) / 100,
      });
      remaining -= chargeKwh;
    }

    // Pass 2: if still insufficient (all slots expensive), fill from cheapest remaining
    if (remaining > 0.1) {
      for (const slot of sorted) {
        if (remaining <= 0) break;
        if (plan.some(p => p.hour === slot.hour)) continue;

        const chargeKwh = Math.min(remaining, chargingSpeedKw);
        plan.push({
          hour:        slot.hour,
          pricePerKwh: slot.pricePerKwh,
          chargeKwh:   Math.round(chargeKwh * 10) / 10,
          costEur:     Math.round(chargeKwh * slot.pricePerKwh * 100) / 100,
        });
        remaining -= chargeKwh;
      }
    }

    // Sort by hour for human readability
    plan.sort((a, b) => a.hour - b.hour);

    const totalCostEur        = Math.round(plan.reduce((s, p) => s + p.costEur, 0) * 100) / 100;
    const immediateCostEur    = Math.round(neededKwh * avgPrice * 100) / 100;
    const savedVsImmediateEur = Math.round((immediateCostEur - totalCostEur) * 100) / 100;

    const firstSlot   = plan[0];
    const lfpNote     = lfpFullCharge ? ' (LFP full-calibration charge)' : '';
    const recommendation = firstSlot
      ? `Start at ${String(firstSlot.hour).padStart(2, '0')}:00 — €${firstSlot.pricePerKwh.toFixed(2)}/kWh (saves €${savedVsImmediateEur} vs immediate)${lfpNote}`
      : 'Charge now — no cheaper window found';

    return {
      plan,
      totalCostEur,
      savedVsImmediateEur,
      neededKwh:   Math.round(neededKwh * 10) / 10,
      recommendation,
      cappedAt80Pct,
      tempDelayed: false,
      lfpFullCharge,
    };
  }
}
