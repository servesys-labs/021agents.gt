/**
 * Pass/fail thresholds — automated from the design doc's Decision 6.
 *
 * k6 exits with code 99 if any threshold is breached.
 */
export const thresholds = {
  // ── Production-ready thresholds ──────────────────────────────────
  // Sync /run p99 < 5s
  "http_req_duration{endpoint:sync_run}": ["p(99)<5000"],
  // Stream time-to-first-byte p99 < 3s (approximated by TTFB metric)
  "http_req_waiting{endpoint:stream_run}": ["p(99)<3000"],
  // Conversation create p99 < 5s (same as sync)
  "http_req_duration{endpoint:conversation}": ["p(99)<5000"],
  // Batch submit p99 < 2s (just enqueues, no runtime call)
  "http_req_duration{endpoint:batch}": ["p(99)<2000"],
  // Error rate < 1% across all endpoints
  http_req_failed: ["rate<0.01"],
  // Global p99 < 10s (catch-all)
  http_req_duration: ["p(99)<10000"],
};
