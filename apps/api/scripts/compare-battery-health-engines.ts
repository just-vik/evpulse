/**
 * Read-only comparison: BatteryHealthService (Engine A, charging-only) vs.
 * BatteryAnalyticsService (Engine B, 3-signal weighted blend) — both
 * currently write to the same `BatteryHealth` table via independent cron
 * schedules (03:30 UTC / 03:00 UTC) and event triggers, with
 * `getBatteryHealth()` simply reading whichever wrote last
 * (`orderBy: { timestamp: 'desc' }`). See docs/calculations/battery-health.md.
 *
 * Purpose: run BOTH engines' real, unmodified public methods
 * (`estimateCapacityFromCharging` / `updateBatteryMetrics`) against the same
 * live historical data for a set of vehicles, and report the resulting SOH,
 * confidence, and method — to make an evidence-based canonical-engine
 * decision instead of a paper comparison.
 *
 * NEVER writes to the database. Both services' actual write calls
 * (`vehicle.update`, `batteryHealth.create`, `$executeRaw` — the baseline
 * lock) are intercepted by a Proxy that logs + captures what WOULD have
 * been written and returns a synthesized result, instead of touching
 * Postgres. All reads (`findMany`, `findUnique`, `$queryRaw`) go straight to
 * the real database, unmodified — this is what gives the comparison real
 * numbers instead of reimplemented (and possibly drifted) formulas.
 *
 * Usage (inside the api container, where DATABASE_URL resolves):
 *   npx ts-node --transpile-only --compiler-options '{"experimentalDecorators":true}' \
 *     scripts/compare-battery-health-engines.ts [vehicleId1 vehicleId2 ...]
 *
 * With no vehicle IDs given, auto-selects up to 5 active vehicles that have
 * at least 5 completed charging sessions with known energy (the minimum
 * either engine needs to produce a result at all).
 */

import { PrismaClient } from '@prisma/client';
import { BatteryHealthService } from '../src/battery/battery-health.service';
import { BatteryAnalyticsService } from '../src/battery/battery-analytics.service';

let prisma: PrismaClient;

interface CapturedWrite {
  engine: 'A' | 'B';
  vehicleId: string;
  table: 'vehicle' | 'batteryHealth' | 'executeRaw';
  data: any;
}

/**
 * Wraps a real PrismaClient so every read passes through untouched, but
 * `vehicle.update`, `batteryHealth.create`, and `$executeRaw` (the only
 * three write operations either engine's relevant code path performs) are
 * intercepted: logged, captured into `captured`, and answered with a
 * synthesized value instead of reaching Postgres.
 */
function makeWriteGuardedPrisma(real: PrismaClient, captured: CapturedWrite[], tag: { engine: 'A' | 'B'; vehicleId: string }) {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === '$executeRaw' || prop === '$executeRawUnsafe') {
        return async (..._args: any[]) => {
          captured.push({ engine: tag.engine, vehicleId: tag.vehicleId, table: 'executeRaw', data: '(baseline lock UPDATE — blocked)' });
          return 0;
        };
      }
      if (prop === 'vehicle') {
        const realDelegate: any = (target as any).vehicle;
        return new Proxy(realDelegate, {
          get(t2, p2) {
            if (p2 === 'update') {
              return async (args: any) => {
                captured.push({ engine: tag.engine, vehicleId: tag.vehicleId, table: 'vehicle', data: args.data });
                return null;
              };
            }
            const v = (t2 as any)[p2];
            return typeof v === 'function' ? v.bind(t2) : v;
          },
        });
      }
      if (prop === 'batteryHealth') {
        const realDelegate: any = (target as any).batteryHealth;
        return new Proxy(realDelegate, {
          get(t2, p2) {
            if (p2 === 'create') {
              return async (args: any) => {
                captured.push({ engine: tag.engine, vehicleId: tag.vehicleId, table: 'batteryHealth', data: args.data });
                // Synthesize what a real create() would return: the row as written.
                return { id: `dry-run-${tag.engine}`, timestamp: new Date(), createdAt: new Date(), ...args.data };
              };
            }
            const v = (t2 as any)[p2];
            return typeof v === 'function' ? v.bind(t2) : v;
          },
        });
      }
      const value = (target as any)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

const noopRedis: any = {
  get: async () => null,
  set: async () => 'OK',
  scan: async () => ['0', []],
  del: async () => 0,
};

async function pickSampleVehicles(limit = 5): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string; n: bigint }>>`
    SELECT v.id, COUNT(cs.id) AS n
    FROM vehicles v
    JOIN charging_sessions cs
      ON cs."vehicleId" = v.id
     AND cs."endTime" IS NOT NULL
     AND cs."energyAddedKwh" > 0
    WHERE v.status = 'active'
    GROUP BY v.id
    HAVING COUNT(cs.id) >= 5
    ORDER BY COUNT(cs.id) DESC
    LIMIT ${limit}
  `;
  return rows.map(r => r.id);
}

async function compareVehicle(vehicleId: string, captured: CapturedWrite[]) {
  // Engine A — BatteryHealthService.estimateCapacityFromCharging (real method, guarded writes)
  const prismaA = makeWriteGuardedPrisma(prisma, captured, { engine: 'A', vehicleId });
  const engineA = new BatteryHealthService(prismaA as any, noopRedis);
  let resultA: any = null;
  let errorA: string | null = null;
  try {
    resultA = await engineA.estimateCapacityFromCharging(vehicleId);
  } catch (e: any) {
    errorA = e.message;
  }

  // Engine B — BatteryAnalyticsService.updateBatteryMetrics (real method, guarded writes)
  // updateBatteryMetrics returns void — the comparison reads back what it
  // WOULD have written from the captured batteryHealth.create() call.
  const beforeCount = captured.length;
  const prismaB = makeWriteGuardedPrisma(prisma, captured, { engine: 'B', vehicleId });
  const engineB = new BatteryAnalyticsService(prismaB as any, noopRedis);
  let errorB: string | null = null;
  try {
    await engineB.updateBatteryMetrics(vehicleId);
  } catch (e: any) {
    errorB = e.message;
  }
  const resultB = captured.slice(beforeCount).find(c => c.table === 'batteryHealth')?.data ?? null;

  return {
    vehicleId,
    A_sohPercent: resultA?.sohPercent ?? (errorA ? `ERROR: ${errorA}` : 'no result (insufficient data)'),
    A_confidence: resultA?.confidenceScore ?? '-',
    A_method: resultA?.method ?? '-',
    A_sampleCount: resultA?.sampleCount ?? '-',
    B_sohPercent: resultB?.sohPercent ?? (errorB ? `ERROR: ${errorB}` : 'no result (insufficient data)'),
    B_confidence: resultB?.confidenceScore ?? '-',
    B_method: resultB?.method ?? '-',
    B_sampleCount: resultB?.sampleCount ?? '-',
    deltaPct: (typeof resultA?.sohPercent === 'number' && typeof resultB?.sohPercent === 'number')
      ? Math.round((resultA.sohPercent - resultB.sohPercent) * 100) / 100
      : '-',
  };
}

async function main() {
  prisma = new PrismaClient();

  const explicitIds = process.argv.slice(2);
  const vehicleIds = explicitIds.length ? explicitIds : await pickSampleVehicles();

  if (!vehicleIds.length) {
    console.log('No vehicles found with >=5 completed charging sessions — nothing to compare.');
    await prisma.$disconnect();
    return;
  }

  console.log(`\nComparing Engine A (BatteryHealthService) vs Engine B (BatteryAnalyticsService) for ${vehicleIds.length} vehicle(s).`);
  console.log('READ-ONLY — vehicle.update / batteryHealth.create / $executeRaw are intercepted, not executed.\n');

  const captured: CapturedWrite[] = [];
  const rows = [];
  for (const id of vehicleIds) {
    rows.push(await compareVehicle(id, captured));
  }

  console.table(rows);

  console.log(`\nBlocked write attempts (proof neither engine touched the DB): ${captured.length}`);
  for (const c of captured) {
    console.log(`  [${c.engine}] ${c.table} — vehicle ${c.vehicleId}`);
  }

  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
}
