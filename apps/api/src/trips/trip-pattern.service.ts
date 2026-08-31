import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { PrismaService } from '../prisma/prisma.service';
import { isWorkerRole } from '../runtime/runtime-role';

/**
 * TripPatternService — Budget-Optimal Hazard-Scheduled Sleeping Poll
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MATHEMATICAL FOUNDATION
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Problem:
 *   When a vehicle is sleeping and fleet telemetry is offline, we must decide
 *   how often to issue a REST wake-check. Too often → wastes API budget.
 *   Too rarely → misses short trips from sleep (e.g., Diedenbergen→Wallau).
 *
 * Classical solution (all existing EV apps):
 *   Fixed interval per state — e.g. 60 min sleeping, 15 min idle.
 *   This is suboptimal: ignores that departure probability is ~0 at 3am
 *   but ~35% at 8am on a weekday.
 *
 * Optimal solution (this service):
 * ─────────────────────────────────
 *   Given daily poll budget B and hazard rate λ̂(t), minimise expected
 *   departure detection delay:
 *
 *     min  ∫₀²⁴ T(t)/2 · λ(t) dt
 *     s.t. ∫₀²⁴ 1/T(t) dt = B
 *
 *   Lagrangian: L = ∫ [ T·λ/2 − μ/T ] dt
 *   ∂L/∂T = λ/2 + μ/T² = 0  →  T*(t) = C / √λ(t)          (1)
 *
 *   Budget constraint: ∫₀²⁴ 1/T*(t) dt = B
 *     → ∫ √λ(t)/C dt = B
 *     → C = (1/B) × ∫₀²⁴ √λ(t) dt                           (2)
 *
 *   Discrete (7 days × 24 hours = 168 slots):
 *     C = Σᵢ √p̂ᵢ / (7 × B)                                  (3)
 *
 * Proof of optimality: (1) satisfies the first-order KKT conditions for
 * the convex cost ∫ T·λ/2 dt with constraint ∫ 1/T dt = B.  Since the
 * Lagrangian is strictly convex in T, this global minimum is unique.
 *
 * Hazard estimation — Jeffreys-prior Laplace smoothing:
 *   p̂(h, d) = [n(h,d) + α] / [N(d) + 24α]                   (4)
 *
 *   where n(h,d) = trips starting in UTC hour h on day-of-week d,
 *         N(d)   = total trips on day-of-week d,
 *         α      = 0.5  (Jeffreys prior, prevents p̂ = 0 / zero-divide)
 *
 * Secondary signal — Vampire Drain Anomaly (VDA):
 *   When a vehicle is sleeping, SOC should fall at ≈ IDLE_DRAIN_PCT_PER_H.
 *   If the measured drain rate exceeds this (Sentry Mode, climate pre-heat,
 *   brief key-on), something is running → departure is more likely soon.
 *
 *   Effective hazard: λ_eff = λ̂(h,d) × max(1, ΔSOCactual / ΔSOCexpected)
 *   Applied as a boost divisor to the computed interval:
 *
 *     T_final = clamp(T*(t) / √drainBoost, T_min, T_max)      (5)
 *
 *   Rationale: √ dampening prevents extreme boost from noisy SOC readings.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NUMERICAL EXAMPLE (typical commuter pattern)
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   Slots: 168 total, B = 80 polls/day
 *   Peak hour (Mon–Fri 07:00 UTC, p̂ = 0.38):
 *     T* = C / √0.38 ≈ (Σ√p / 560) / 0.616 ≈ 5.6 min
 *   Off-peak (03:00 UTC any day, p̂ = 0.006):
 *     T* = C / √0.006 ≈ (Σ√p / 560) / 0.077 ≈ 44 min → capped 90 min
 *   Budget verification: Σ(1/T*ᵢ) ≈ 80 polls/day  ✓
 *   vs. flat 60-min scheme: 24 polls/day, but ALL at wrong times
 *
 * ══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class TripPatternService implements OnModuleInit {
  private readonly logger = new Logger(TripPatternService.name);

  // ── Tunable parameters ────────────────────────────────────────────────
  /** REST polls per day allocated to sleeping-mode wake-checks (per vehicle) */
  private readonly DAILY_BUDGET_POLLS = 80;
  /** Hard floor — never faster than this even at peak departure hour */
  private readonly MIN_INTERVAL_MS = 3 * 60_000;   // 3 min
  /** Hard ceiling — never slower than this even at 3am */
  private readonly MAX_INTERVAL_MS = 90 * 60_000;  // 90 min
  /** In eco mode, multiply computed interval by this factor */
  // ECO_MULTIPLIER removed — eco mode is no longer used
  /** Jeffreys prior α for Laplace smoothing (prevents p̂ = 0) */
  private readonly ALPHA = 0.5;
  /** Expected idle SOC drain rate (%/h) — ~0.05 %/h for typical Tesla */
  private readonly IDLE_DRAIN_PCT_PER_H = 0.05;
  /** Redis key prefix for pattern tables */
  private readonly PATTERN_KEY = 'trip:pattern:v3:';
  /** Redis key prefix for SOC snapshots used in VDA */
  private readonly SOC_SNAP_KEY = 'trip:soc-snap:';
  /** Retain pattern tables for 2 days (refreshed nightly) */
  private readonly PATTERN_TTL_S = 2 * 86_400;
  // ──────────────────────────────────────────────────────────────────────

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit() {
    if (!isWorkerRole()) return;
    // Build patterns non-blocking at startup so the very first sleeping poll
    // uses real data rather than the flat fallback interval.
    void this.buildAllPatterns().catch(e =>
      this.logger.warn(`[Pattern] Pattern init failed (will use fallback): ${e.message}`),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Returns the budget-optimal sleeping poll interval in milliseconds.
   *
   * Applies formula (1): T*(t) = C / √p̂(h, d)
   * with optional Vampire Drain Anomaly boost: T_final = T*(t) / √drainBoost
   *
   * @param vehicleId   Vehicle to compute interval for
   * @param now         Current time (determines h and d for lookup)
   * @param currentSoc  SOC reading from the most recent REST poll (null if unknown)
   */
  async getSleepIntervalMs(
    vehicleId: string,
    now: Date,
    currentSoc: number | null = null,
  ): Promise<number> {
    const h = now.getUTCHours();
    const d = now.getUTCDay(); // 0=Sun … 6=Sat

    // ── 1. Load departure probability table from Redis ─────────────────
    const { p, C } = await this.getPatternData(vehicleId);
    const p_slot   = p[d * 24 + h] ?? this.defaultP();
    const C_hours  = C ?? this.defaultC();

    // ── 2. Vampire Drain Anomaly boost ─────────────────────────────────
    // If SOC fell faster than the idle baseline, something was running →
    // boost effective hazard → shorten next interval.
    const drainBoost = await this.computeVampireDrainBoost(vehicleId, currentSoc, now);

    // λ_eff = p_slot × drainBoost  →  applied as divisor of T via √ dampening
    // (formula 5): T_final = T*(t) / √drainBoost
    const T_hours = C_hours / Math.sqrt(Math.max(p_slot, 1e-8));
    const T_boosted_ms = (T_hours * 3_600_000) / Math.sqrt(drainBoost);

    const result = Math.max(
      this.MIN_INTERVAL_MS,
      Math.min(this.MAX_INTERVAL_MS, T_boosted_ms),
    );

    this.logger.debug(
      `[Pattern] ${vehicleId} h=${h} d=${d} p=${p_slot.toFixed(4)} ` +
      `C=${(C_hours * 60).toFixed(1)}min boost=${drainBoost.toFixed(2)} ` +
      `→ T=${Math.round(result / 60000)}min`,
    );

    return result;
  }

  /**
   * Record a SOC reading for Vampire Drain Anomaly tracking.
   * Call this whenever a fresh REST poll returns telemetry data.
   */
  async recordSocSnapshot(vehicleId: string, soc: number, ts: Date): Promise<void> {
    const payload = JSON.stringify({ soc, ts: ts.getTime() });
    await this.redis.set(this.SOC_SNAP_KEY + vehicleId, payload, 'EX', 7200);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Pattern build — runs nightly at 01:00 UTC
  // ═══════════════════════════════════════════════════════════════════════

  @Cron('0 1 * * *')
  async refreshAllPatterns(): Promise<void> {
    if (!isWorkerRole()) return;
    return this.buildAllPatterns();
  }

  /** Internal build — called from both onModuleInit and cron */
  private async buildAllPatterns(): Promise<void> {
    try {
      const vehicles = await this.prisma.vehicle.findMany({ select: { id: true } });
      await Promise.all(
        vehicles.map(v =>
          this.buildPatternForVehicle(v.id).catch(e =>
            this.logger.warn(`[Pattern] Build failed for ${v.id}: ${e.message}`),
          ),
        ),
      );
      this.logger.log(`[Pattern] Refreshed departure tables for ${vehicles.length} vehicle(s)`);
    } catch (e: any) {
      this.logger.error(`[Pattern] Refresh error: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Pattern build
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Builds the 7×24 hazard table for one vehicle and stores it in Redis.
   *
   * Estimator (formula 4):
   *   p̂(h, d) = [n(h,d) + α] / [N(d) + 24α]
   *
   * The normalisation constant C (formula 3):
   *   C = Σᵢ √p̂ᵢ / (7 × B)
   *
   * Uses the last 90 days of completed trips.
   * Requires ≥ 5 trips; falls back to flat distribution otherwise.
   */
  private async buildPatternForVehicle(vehicleId: string): Promise<void> {
    const since = new Date(Date.now() - 90 * 86_400_000);

    const trips = await this.prisma.trip.findMany({
      where: { vehicleId, startTime: { gte: since }, endTime: { not: null } },
      select: { startTime: true },
    });

    if (trips.length < 5) {
      // Not enough data yet — keep whatever is stored (or nothing, triggering fallback)
      return;
    }

    // ── Accumulate counts by (dow, hour) ─────────────────────────────
    // Using typed arrays for numerical stability + GC friendliness
    const nBySlot = new Float64Array(7 * 24);  // n(h, d)
    const NByDow  = new Float64Array(7);        // N(d)

    for (const { startTime } of trips) {
      const d = startTime.getUTCDay();
      const h = startTime.getUTCHours();
      nBySlot[d * 24 + h] += 1;
      NByDow[d]            += 1;
    }

    // ── Laplace-smoothed probability table (formula 4) ────────────────
    const pTable = new Float64Array(7 * 24);
    for (let d = 0; d < 7; d++) {
      const N_d = NByDow[d];
      const denom = N_d + 24 * this.ALPHA;
      for (let h = 0; h < 24; h++) {
        pTable[d * 24 + h] = (nBySlot[d * 24 + h] + this.ALPHA) / denom;
      }
    }

    // ── Normalisation constant C (formula 3) ─────────────────────────
    // C = Σᵢ √p̂ᵢ / (7 × B)
    // Interpretation: the budget constraint allocates each √p unit of
    // "hazard weight" to B/(7×Σ√p) polls.
    let sumSqrtP = 0;
    for (let i = 0; i < 168; i++) sumSqrtP += Math.sqrt(pTable[i]);
    const C_hours = sumSqrtP / (7 * this.DAILY_BUDGET_POLLS);

    // ── Persist ───────────────────────────────────────────────────────
    const payload = JSON.stringify({
      p:       Array.from(pTable),
      C:       C_hours,
      trips:   trips.length,
      builtAt: new Date().toISOString(),
    });
    await this.redis.set(this.PATTERN_KEY + vehicleId, payload, 'EX', this.PATTERN_TTL_S);

    this.logger.debug(
      `[Pattern] ${vehicleId}: ${trips.length} trips, C=${(C_hours * 60).toFixed(2)}min, ` +
      `p_max=${Math.max(...pTable).toFixed(3)}, Σ√p=${sumSqrtP.toFixed(2)}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: Vampire Drain Anomaly detector
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Vampire Drain Anomaly boost multiplier.
   *
   * Returns value ≥ 1.0 to multiply the effective hazard rate.
   * Formula (5): T_final = T*(t) / √boost
   *
   * When SOC drops faster than expected idle drain, the car was active
   * (Sentry Mode, climate, pre-conditioning, brief door-open) and departure
   * is more likely. √ dampening avoids overcorrection from noisy SOC values.
   *
   * Boost = max(1, ΔSOCactual / ΔSOCexpected)
   * Capped at 4.0 (squarerooted → max 2× interval reduction).
   */
  private async computeVampireDrainBoost(
    vehicleId: string,
    currentSoc: number | null,
    now: Date,
  ): Promise<number> {
    if (currentSoc == null) return 1.0;

    const raw = await this.redis.get(this.SOC_SNAP_KEY + vehicleId).catch(() => null);
    if (!raw) {
      // First reading — just record and return no boost
      await this.recordSocSnapshot(vehicleId, currentSoc, now);
      return 1.0;
    }

    const { soc: prevSoc, ts: prevTs } = JSON.parse(raw) as { soc: number; ts: number };
    const dtHours = (now.getTime() - prevTs) / 3_600_000;

    // Always update snapshot with the latest reading
    await this.recordSocSnapshot(vehicleId, currentSoc, now);

    // Too short to measure or SOC rose (charging / quantization noise)
    if (dtHours < 0.33 || prevSoc <= currentSoc) return 1.0;

    const actualDropPct   = prevSoc - currentSoc;
    const expectedDropPct = this.IDLE_DRAIN_PCT_PER_H * dtHours;

    if (expectedDropPct < 0.005) return 1.0; // too short, expected ≈ 0 — avoid div-by-zero

    const anomalyRatio = actualDropPct / expectedDropPct;
    // Cap at 4× (→ √4 = 2× interval reduction) to limit noise impact
    return Math.max(1.0, Math.min(4.0, anomalyRatio));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private: helpers
  // ═══════════════════════════════════════════════════════════════════════

  private async getPatternData(vehicleId: string): Promise<{ p: number[]; C: number | null }> {
    const raw = await this.redis.get(this.PATTERN_KEY + vehicleId).catch(() => null);
    if (!raw) return { p: [], C: null };
    const data = JSON.parse(raw) as { p: number[]; C: number };
    return { p: data.p, C: data.C };
  }

  /**
   * Fallback uniform prior when no pattern data exists.
   * Assumes trips are equally likely in all hours → uniform hazard rate.
   */
  private defaultP(): number {
    return 1 / 24; // uniform distribution over 24 hours
  }

  /**
   * Fallback C when no pattern data exists.
   * Targets T_default ≈ 18 min average interval at uniform p̂ = 1/24.
   *
   * At uniform distribution with B=80 polls/day:
   *   Σ√p̂ = 168 × √(1/24) = 168 / √24 ≈ 34.29
   *   C = 34.29 / (7 × 80) ≈ 0.0612 h ≈ 3.67 min
   *   T* = C / √(1/24) = 3.67 × √24 ≈ 18 min  ✓
   */
  private defaultC(): number {
    // Σ√p̂ over all 168 slots under the uniform prior p̂ = 1/24
    const sumSqrtP = 168 * Math.sqrt(1 / 24);
    return sumSqrtP / (7 * this.DAILY_BUDGET_POLLS);
  }
}
