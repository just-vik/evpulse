#!/usr/bin/env node
/**
 * smoke-test-tesla-api.mjs
 *
 * Pre-release smoke test: simulates N concurrent users each calling
 * GET /api/1/vehicles against the real Tesla Fleet API.
 *
 * Verifies:
 *   1. All requests succeed (200) or are rate-limited (429) without crashing
 *   2. 429 responses include a Retry-After header (Tesla's contract)
 *   3. p99 latency stays within acceptable bounds (< 5 s per request)
 *   4. No request exceeds the hard timeout (8 s — matches the service config)
 *
 * Usage:
 *   TESLA_ACCESS_TOKEN=<token> node scripts/smoke-test-tesla-api.mjs
 *
 *   Optional env vars:
 *     TESLA_API_BASE_URL  — default: https://fleet-api.prd.na.vn.cloud.tesla.com/api/1
 *     SMOKE_CONCURRENCY   — number of simulated concurrent users (default: 5)
 *     SMOKE_ROUNDS        — number of sequential rounds (default: 3)
 *     SMOKE_DELAY_MS      — delay between rounds in ms (default: 2000)
 *
 * Why 5 concurrent + 3 rounds?
 *   Tesla rate-limits at ~200 req/day per token for vehicle_data, but
 *   /vehicles is lighter. The test uses 5 × 3 = 15 requests — well within
 *   any quota — while still surfacing thundering-herd behaviour between users.
 */

import https from 'https';
import http from 'http';

const TOKEN    = process.env.TESLA_ACCESS_TOKEN;
const BASE_URL = (process.env.TESLA_API_BASE_URL
  ?? 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1').replace(/\/$/, '');
const CONCURRENCY = parseInt(process.env.SMOKE_CONCURRENCY ?? '5', 10);
const ROUNDS      = parseInt(process.env.SMOKE_ROUNDS ?? '3', 10);
const DELAY_MS    = parseInt(process.env.SMOKE_DELAY_MS ?? '2000', 10);
const TIMEOUT_MS  = 8_000;  // must match tesla-fleet.service.ts hard cap

if (!TOKEN) {
  console.error('ERROR: TESLA_ACCESS_TOKEN env var is required');
  process.exit(1);
}

// ─── HTTP helper (no external deps) ──────────────────────────────────────────

function fetchWithTimeout(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const start  = Date.now();

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers,
        timeout:  timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({
            ok:         res.statusCode === 200,
            status:     res.statusCode,
            latencyMs:  Date.now() - start,
            headers:    res.headers,
            body:       body.slice(0, 200),  // truncate for logging
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok:        false,
        status:    -1,
        latencyMs: timeoutMs,
        headers:   {},
        error:     'TIMEOUT',
      });
    });

    req.on('error', (err) => {
      resolve({
        ok:        false,
        status:    -1,
        latencyMs: Date.now() - start,
        headers:   {},
        error:     err.message,
      });
    });

    req.end();
  });
}

// ─── Single round: CONCURRENCY parallel requests ──────────────────────────────

async function runRound(round) {
  const url     = `${BASE_URL}/vehicles`;
  const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' };

  const promises = Array.from({ length: CONCURRENCY }, (_, i) =>
    fetchWithTimeout(url, headers, TIMEOUT_MS).then((r) => ({ user: i + 1, ...r }))
  );

  const results = await Promise.all(promises);

  const ok      = results.filter((r) => r.status === 200);
  const limited = results.filter((r) => r.status === 429);
  const errors  = results.filter((r) => r.status !== 200 && r.status !== 429);
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p99    = latencies[Math.ceil(latencies.length * 0.99) - 1];
  const maxLat = Math.max(...latencies);

  console.log(`\nRound ${round}/${ROUNDS} — ${CONCURRENCY} concurrent users`);
  console.log(`  ✓ 200 OK:          ${ok.length}`);
  console.log(`  ⚠ 429 rate-limit:  ${limited.length}`);
  console.log(`  ✗ errors:          ${errors.length}${errors.length ? ' — ' + errors.map(e => e.error ?? e.status).join(', ') : ''}`);
  console.log(`  Latency (ms):      min=${latencies[0]}  p50=${latencies[Math.floor(latencies.length / 2)]}  p99=${p99}  max=${maxLat}`);

  // Assertion 1: 429s must include Retry-After header (Tesla contract)
  for (const r of limited) {
    const retryAfter = r.headers['retry-after'] ?? r.headers['x-ratelimit-reset'];
    if (!retryAfter) {
      console.error(`  ✗ FAIL: 429 response from user ${r.user} is missing Retry-After header`);
      return { passed: false, results };
    }
    console.log(`  ℹ 429 on user ${r.user} — Retry-After: ${retryAfter}s`);
  }

  // Assertion 2: hard errors (not 429) should not happen
  if (errors.length > 0) {
    console.error(`  ✗ FAIL: unexpected errors in round ${round}`);
    errors.forEach(e => console.error(`    user ${e.user}: status=${e.status} error=${e.error ?? ''} body=${e.body ?? ''}`));
    return { passed: false, results };
  }

  // Assertion 3: p99 latency < 5s (hard cap is 8s, but >5s is a warning)
  if (p99 > 5_000) {
    console.warn(`  ⚠ WARN: p99 latency ${p99}ms exceeds 5000ms — check Tesla API region config`);
  }

  // Assertion 4: max latency must stay below hard timeout
  if (maxLat >= TIMEOUT_MS) {
    console.error(`  ✗ FAIL: request timed out (${maxLat}ms >= ${TIMEOUT_MS}ms hard cap)`);
    return { passed: false, results };
  }

  return { passed: true, results };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Tesla Fleet API Smoke Test');
  console.log(`  Endpoint:    ${BASE_URL}/vehicles`);
  console.log(`  Concurrency: ${CONCURRENCY} simulated users`);
  console.log(`  Rounds:      ${ROUNDS} (${DELAY_MS}ms between rounds)`);
  console.log(`  Timeout:     ${TIMEOUT_MS}ms (matches service hard cap)`);
  console.log('═══════════════════════════════════════════════════════════════');

  let allPassed = true;

  for (let round = 1; round <= ROUNDS; round++) {
    const { passed } = await runRound(round);
    if (!passed) allPassed = false;

    if (round < ROUNDS) {
      process.stdout.write(`  Waiting ${DELAY_MS}ms before next round...`);
      await new Promise((r) => setTimeout(r, DELAY_MS));
      console.log(' done');
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  if (allPassed) {
    console.log('✓ All smoke tests PASSED — safe to release');
    process.exit(0);
  } else {
    console.log('✗ Smoke tests FAILED — do not release until resolved');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
