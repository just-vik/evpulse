import type { DataQuality } from '@/features/vehicles/useVehicleSummary';

/**
 * Pure, dependency-free rule engine for Home's critical-alert slot and
 * one-actionable-insight slot. Deliberately a *subset* of web's real
 * `apps/web/src/lib/insights.ts` engine — same threshold values, ported
 * only where mobile already fetches the underlying data (vehicle status,
 * most recent trip). Not a reinvention: `SOC_CRITICAL`/`SOC_LOW` and the
 * cold-weather multi-condition gate mirror that file's real constants
 * (`BATTERY_SOC.CRITICAL=15/LOW=25`, `outsideTemp<5 && efficiencyWhKm>200
 * && distanceKm>2`), not new numbers invented for mobile.
 */

export interface HomeInsightInput {
  soc: number | null;
  dataQuality: DataQuality;
  outsideTemp: number | null;
  recentTrip: { efficiencyWhkm: number | null; distanceKm: number | null } | null;
}

export interface HomeAlert {
  severity: 'danger' | 'warning';
  titleKey: string;
  messageKey: string;
  messageParams?: Record<string, unknown>;
}

export interface HomeInsight {
  severity: 'info' | 'success' | 'neutral';
  titleKey: string;
  messageKey: string;
  messageParams?: Record<string, unknown>;
}

const SOC_CRITICAL = 15;
const SOC_LOW = 25;
const COLD_OUTSIDE_TEMP_C = 5;
const COLD_MIN_EFFICIENCY_WHKM = 200;
const MIN_RELIABLE_DISTANCE_KM = 2;

// Never fire the cold-weather/all-good rules on stale/offline data — matches
// web's `freshForInsights` gate (dataQuality REALTIME|DELAYED only), so a
// claim about "right now" is never made from a reading that's actually
// minutes old. DELAYED still counts as fresh here deliberately: a 1-4 minute
// gap is routine (P1.2.1 — real parked-vehicle telemetry gaps run 50s-6m+)
// and must not read as an incident.
function isFresh(quality: DataQuality): boolean {
  return quality === 'REALTIME' || quality === 'DELAYED';
}

export function computeCriticalAlert(input: HomeInsightInput): HomeAlert | null {
  if (!isFresh(input.dataQuality) || input.soc == null) return null;

  if (input.soc <= SOC_CRITICAL) {
    return {
      severity: 'danger',
      titleKey: 'home.alerts.criticalSocTitle',
      messageKey: 'home.alerts.criticalSocMessage',
      messageParams: { soc: Math.round(input.soc) },
    };
  }
  if (input.soc <= SOC_LOW) {
    return {
      severity: 'warning',
      titleKey: 'home.alerts.lowSocTitle',
      messageKey: 'home.alerts.lowSocMessage',
      messageParams: { soc: Math.round(input.soc) },
    };
  }
  return null;
}

/** Always returns a card — the "all good" fallback is a designed calm state
 *  (states what was checked), never decorative praise. Critically: "all
 *  good" is itself a claim that requires fresh data to back it up — on
 *  stale/offline data it must not be shown, since that would assert
 *  something was verified when it wasn't.
 *
 *  P1.2.1: STALE and OFFLINE get distinct copy, not a single shared "haven't
 *  heard from your vehicle" message. STALE (5-15 min silence) is routine
 *  parked/sleeping behavior and must read as calm and expected — never as an
 *  incident, never claiming the vehicle is definitely unreachable (EVPulse
 *  doesn't wake it to check, so "asleep" and "actually offline" are
 *  indistinguishable from here). OFFLINE (15+ min) gets a slightly stronger
 *  but still non-alarming message — it still never asserts the car is
 *  offline, only that EVPulse hasn't heard from it recently. */
export function computeInsight(input: HomeInsightInput): HomeInsight {
  if (input.dataQuality === 'STALE') {
    return {
      severity: 'neutral',
      titleKey: 'home.insight.staleTitle',
      messageKey: 'home.insight.staleMessage',
    };
  }
  if (input.dataQuality === 'OFFLINE') {
    return {
      severity: 'neutral',
      titleKey: 'home.insight.offlineTitle',
      messageKey: 'home.insight.offlineMessage',
    };
  }

  const { recentTrip, outsideTemp } = input;

  if (
    outsideTemp != null &&
    outsideTemp < COLD_OUTSIDE_TEMP_C &&
    recentTrip?.efficiencyWhkm != null &&
    recentTrip.efficiencyWhkm > COLD_MIN_EFFICIENCY_WHKM &&
    recentTrip.distanceKm != null &&
    recentTrip.distanceKm > MIN_RELIABLE_DISTANCE_KM
  ) {
    return {
      severity: 'info',
      titleKey: 'home.insight.coldWeatherTitle',
      messageKey: 'home.insight.coldWeatherMessage',
      messageParams: { temp: Math.round(outsideTemp) },
    };
  }

  return {
    severity: 'success',
    titleKey: 'home.insight.allGoodTitle',
    messageKey: 'home.insight.allGoodMessage',
  };
}
