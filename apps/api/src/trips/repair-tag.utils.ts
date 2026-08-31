/**
 * Structured repair/audit tags for trips.
 *
 * Each tag records WHAT happened (tag), WHO decided it (source), and WHEN (ts).
 * Stored as JSONB in the `repair_tags` column on trips, indexed with GIN for fast
 * queries like "find all trips closed by the watchdog in the last 7 days".
 *
 * Migration path: `repairReason` (legacy pipe-delimited String) is kept for
 * backward compat. Both are written simultaneously until a full cutover.
 */

export type RepairTagSource =
  | 'watchdog'        // trip-cleanup.service.ts cron
  | 'engine'          // telemetry-event-engine.service.ts (DRIVING→CHARGING transition)
  | 'post-processor'  // trip-post-processor.service.ts
  | 'gap-recovery'    // gap-recovery or DLQ replay
  | 'reconciler'      // trip-reconciler.service.ts
  | 'backfill'        // historical backfill pipeline
  | 'endtime_repair'; // trip-cleanup.service.ts repairBloatedEndTimes

export interface RepairTag {
  tag:     string;
  source:  RepairTagSource;
  ts:      string; // ISO-8601 UTC
  /**
   * Schema version — increment when the tag semantics change.
   * v1 = initial structured format (2026-04-02).
   * Having version lets future migrations distinguish "old" tags from "new" ones
   * without relying on ts alone.
   */
  version: 1 | number;
}

/**
 * Append a tag to an existing array — idempotent (no-op if tag already present).
 * Returns a new array; never mutates the input.
 */
export function appendRepairTag(
  existing: RepairTag[] | null | undefined,
  tag:      string,
  source:   RepairTagSource,
): RepairTag[] {
  const arr = Array.isArray(existing) ? existing : [];
  if (arr.some(t => t.tag === tag)) return arr;
  return [...arr, { tag, source, ts: new Date().toISOString(), version: 1 as const }];
}

/**
 * Append multiple tags at once.
 */
export function appendRepairTags(
  existing: RepairTag[] | null | undefined,
  tags:     Array<{ tag: string; source: RepairTagSource }>,
): RepairTag[] {
  let arr = Array.isArray(existing) ? [...existing] : [];
  for (const { tag, source } of tags) {
    if (!arr.some(t => t.tag === tag)) {
      arr = [...arr, { tag, source, ts: new Date().toISOString(), version: 1 as const }];
    }
  }
  return arr;
}

/**
 * Migrate a legacy pipe-delimited `repairReason` string to the structured format.
 * Used during the transition period and for backfilling existing rows.
 *
 * Source is set to 'watchdog' as a best-effort guess for legacy data.
 */
export function parseLegacyRepairReason(
  reason: string | null | undefined,
): RepairTag[] {
  if (!reason) return [];
  return reason
    .split('|')
    .filter(Boolean)
    .map(tag => ({ tag, source: 'watchdog' as RepairTagSource, ts: new Date(0).toISOString(), version: 1 as const }));
}

/**
 * Merge structured tags with a legacy pipe string.
 * Useful when updating a trip that may have either format populated.
 */
export function mergeWithLegacy(
  existing:      RepairTag[] | null | undefined,
  legacyReason:  string | null | undefined,
  newTag:        string,
  newSource:     RepairTagSource,
): RepairTag[] {
  const fromLegacy = parseLegacyRepairReason(legacyReason);
  const base       = Array.isArray(existing) && existing.length ? existing : fromLegacy;
  return appendRepairTag(base, newTag, newSource);
}
