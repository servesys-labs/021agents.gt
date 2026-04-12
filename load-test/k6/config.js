/**
 * Load test configuration — environment-specific values.
 *
 * Set these via k6 environment variables:
 *   k6 run -e BASE_URL=https://... -e API_KEY_0=ak_... main.js
 *
 * Or export them before running:
 *   export K6_BASE_URL=https://agentos-control-plane.your-account.workers.dev
 */

// Target control-plane URL (no trailing slash)
export const BASE_URL = __ENV.BASE_URL || "https://agentos-control-plane.eprasad-servsys.workers.dev";

// Agent name that exists in the load-test org
export const AGENT_NAME = __ENV.AGENT_NAME || "load-test-agent";

// 10 API keys for 10 orgs — round-robin across VUs for multi-tenant realism.
// RLS plan-cache diversity requires distinct org_ids behind each key.
export const API_KEYS = [];
for (let i = 0; i < 10; i++) {
  const key = __ENV[`API_KEY_${i}`];
  if (key) API_KEYS.push(key);
}
// Fallback: single key for quick local runs
if (API_KEYS.length === 0 && __ENV.API_KEY) {
  API_KEYS.push(__ENV.API_KEY);
}

// Runtime mock latency (the mock worker adds uniform random delay)
export const MOCK_LATENCY_MS_MIN = parseInt(__ENV.MOCK_LATENCY_MIN || "50");
export const MOCK_LATENCY_MS_MAX = parseInt(__ENV.MOCK_LATENCY_MAX || "200");

// Credit seed: how much balance each load-test org starts with
export const SEED_BALANCE_USD = parseFloat(__ENV.SEED_BALANCE || "10000");

// Batch size for batch API submissions
export const BATCH_TASK_COUNT = parseInt(__ENV.BATCH_TASKS || "10");
