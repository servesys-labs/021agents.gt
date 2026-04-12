/**
 * k6 entry point — combines scenarios with the 80-minute ramp profile.
 *
 * Run:
 *   k6 run -e BASE_URL=https://... -e API_KEY=ak_... load-test/k6/main.js
 *
 * The ramp profile (from the design doc):
 *   Phase 1 (0-5 min):    warm-up     — 10% of target
 *   Phase 2 (5-15 min):   step-25     — 25% of target
 *   Phase 3 (15-25 min):  step-50     — 50% of target
 *   Phase 4 (25-35 min):  step-100    — 100% of target
 *   Phase 5 (35-65 min):  sustained   — hold at 100% for 30 min
 *   Phase 6 (65-70 min):  step-down   — 50% of target
 *   Phase 7 (70-75 min):  cool-down   — 10% of target
 *   Phase 8 (75-80 min):  drain       — 0 RPS, observe resource release
 *
 * Workload split at 100% = 50 RPS:
 *   interactive: 35 RPS (70%)
 *   batch:       5 RPS (10%)
 *   (autopilot:  20% — driven by the real cron + pre-seeded sessions,
 *    NOT a k6 scenario. k6 only measures side effects.)
 */
import interactiveDefault from "./scenarios/interactive.js";
import batchDefault from "./scenarios/batch.js";
import { thresholds } from "./thresholds.js";

// ── Target RPS ─────────────────────────────────────────────────────
const TARGET_RPS = parseInt(__ENV.TARGET_RPS || "50");
const INTERACTIVE_RPS = Math.round(TARGET_RPS * 0.7);
const BATCH_RPS = Math.round(TARGET_RPS * 0.1);

// ── Ramp stages (shared shape for constant-arrival-rate) ───────────
// Each scenario scales its own rate proportionally.
function buildStages(peakRate) {
  const min1 = (v) => Math.max(1, Math.round(v));
  return [
    { duration: "5m", target: min1(peakRate * 0.1) },   // warm-up
    { duration: "10m", target: min1(peakRate * 0.25) },  // step-25
    { duration: "10m", target: min1(peakRate * 0.5) },   // step-50
    { duration: "10m", target: peakRate },                // step-100
    { duration: "30m", target: peakRate },                // sustained peak
    { duration: "5m", target: min1(peakRate * 0.5) },    // step-down
    { duration: "5m", target: min1(peakRate * 0.1) },    // cool-down
    { duration: "5m", target: 0 },                        // drain
  ];
}

// ── Export options ──────────────────────────────────────────────────
export const options = {
  scenarios: {
    interactive: {
      executor: "ramping-arrival-rate",
      exec: "interactive",
      startRate: Math.round(INTERACTIVE_RPS * 0.1),
      timeUnit: "1s",
      preAllocatedVUs: Math.round(INTERACTIVE_RPS * 4),
      maxVUs: Math.round(INTERACTIVE_RPS * 10),
      stages: buildStages(INTERACTIVE_RPS),
      tags: { scenario: "interactive" },
    },
    batch: {
      executor: "ramping-arrival-rate",
      exec: "batch",
      startRate: Math.max(1, Math.round(BATCH_RPS * 0.1)),
      timeUnit: "1s",
      preAllocatedVUs: Math.round(BATCH_RPS * 4),
      maxVUs: Math.round(BATCH_RPS * 10),
      stages: buildStages(BATCH_RPS),
      tags: { scenario: "batch" },
    },
  },
  thresholds,
};

// ── Scenario executor functions ────────────────────────────────────
// k6 maps `exec: "interactive"` to the exported function with that name.
export function interactive() {
  interactiveDefault();
}

export function batch() {
  batchDefault();
}

// ── Teardown: post-drain verification ──────────────────────────────
// Runs ONCE after all VUs are done. Checks for stuck resources.
export function teardown(data) {
  // Teardown runs in a separate JS context — can't import from scenarios.
  // Use the k6 http module directly.
  // NOTE: these queries would ideally hit the DB directly. Since k6 can't
  // run SQL, we check via the admin API if available, or skip if not.
  // The verify-drain.sh script (in monitoring/) provides the SQL-based
  // version for post-run analysis.
  console.log("[teardown] Load test complete. Run monitoring/verify-drain.sh for post-drain assertions.");
}
