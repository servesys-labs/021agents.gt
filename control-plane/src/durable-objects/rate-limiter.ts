/**
 * Durable Object rate limiter — cross-isolate atomic counters.
 *
 * Replaces the per-isolate in-memory LRU at `middleware/api-key-rate-limit.ts`.
 * One DO instance per rate-limit key (org_id:subject:auth_method). All
 * isolates in all colos route to the same DO instance, so the counter is
 * globally consistent — no more N× overshoot from per-isolate counting.
 *
 * Uses RPC (not fetch) for sub-millisecond calls from the middleware.
 * No persistent storage needed — if the DO is evicted, counters reset
 * to zero, which is a LOOSER limit (fail-open on eviction). Acceptable
 * for rate limiting: the worst case is one extra burst window, not a
 * permanent bypass.
 */
import { DurableObject } from "cloudflare:workers";

export class RateLimiterDO extends DurableObject {
  private minuteBucket = 0;
  private minuteCount = 0;
  private dayBucket = 0;
  private dayCount = 0;

  /**
   * Atomically check + increment the rate counters.
   *
   * Called from the rate-limit middleware on every API-key-authenticated
   * request. Returns whether the request is allowed and the remaining
   * quota for response headers.
   *
   * The increment happens BEFORE the allow/deny decision — a denied
   * request still counts against the window. This prevents a pattern
   * where a client at the limit sends many concurrent requests that
   * all read "1 remaining" before any of them increment.
   */
  async check(rpm: number, rpd: number): Promise<{
    allowed: boolean;
    minuteCount: number;
    dayCount: number;
    minuteRemaining: number;
    dayRemaining: number;
    retryAfterSeconds: number;
  }> {
    const now = Date.now();
    const minBucket = Math.floor(now / 60_000);
    const dayBucket = Math.floor(now / 86_400_000);

    // Reset on new window
    if (this.minuteBucket !== minBucket) {
      this.minuteBucket = minBucket;
      this.minuteCount = 0;
    }
    if (this.dayBucket !== dayBucket) {
      this.dayBucket = dayBucket;
      this.dayCount = 0;
    }

    // Increment FIRST, then check
    this.minuteCount++;
    this.dayCount++;

    const minuteExceeded = this.minuteCount > rpm;
    const dayExceeded = this.dayCount > rpd;
    const allowed = !minuteExceeded && !dayExceeded;
    const retryAfterSeconds = minuteExceeded
      ? Math.ceil(60 - (now % 60_000) / 1000)
      : 0;

    return {
      allowed,
      minuteCount: this.minuteCount,
      dayCount: this.dayCount,
      minuteRemaining: Math.max(0, rpm - this.minuteCount),
      dayRemaining: Math.max(0, rpd - this.dayCount),
      retryAfterSeconds,
    };
  }
}
