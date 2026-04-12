import { describe, it, expect, vi, afterEach } from "vitest";
import { effectiveConfidence } from "../src/runtime/memory";

describe("effectiveConfidence — time-based decay", () => {
  const BASE_CONFIDENCE = 1.0;
  const NOW = 1712966400000; // 2024-04-13T00:00:00Z (stable reference)

  afterEach(() => { vi.useRealTimers(); });

  function msAgo(days: number) { return NOW - days * 86_400_000; }

  function withFixedNow(fn: () => void) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fn();
  }

  it("returns full confidence within 7 days", () => {
    withFixedNow(() => {
      expect(effectiveConfidence(BASE_CONFIDENCE, msAgo(0))).toBe(1.0);
      expect(effectiveConfidence(BASE_CONFIDENCE, msAgo(3))).toBe(1.0);
      expect(effectiveConfidence(BASE_CONFIDENCE, msAgo(7))).toBe(1.0);
    });
  });

  it("decays to 0.9x between 8-30 days", () => {
    withFixedNow(() => {
      expect(effectiveConfidence(BASE_CONFIDENCE, msAgo(15))).toBeCloseTo(0.9);
      expect(effectiveConfidence(BASE_CONFIDENCE, msAgo(30))).toBeCloseTo(0.9);
    });
  });

  it("decays to 0.7x between 31-90 days", () => {
    withFixedNow(() => {
      expect(effectiveConfidence(BASE_CONFIDENCE, msAgo(60))).toBeCloseTo(0.7);
      expect(effectiveConfidence(BASE_CONFIDENCE, msAgo(90))).toBeCloseTo(0.7);
    });
  });

  it("decays to 0.5x between 91-180 days", () => {
    withFixedNow(() => {
      expect(effectiveConfidence(BASE_CONFIDENCE, msAgo(120))).toBeCloseTo(0.5);
      expect(effectiveConfidence(BASE_CONFIDENCE, msAgo(180))).toBeCloseTo(0.5);
    });
  });

  it("returns 0 beyond 180 days (archive threshold)", () => {
    withFixedNow(() => {
      expect(effectiveConfidence(BASE_CONFIDENCE, msAgo(181))).toBe(0);
      expect(effectiveConfidence(BASE_CONFIDENCE, msAgo(365))).toBe(0);
    });
  });

  it("scales with input confidence", () => {
    withFixedNow(() => {
      expect(effectiveConfidence(0.8, msAgo(15))).toBeCloseTo(0.72); // 0.8 * 0.9
      expect(effectiveConfidence(0.6, msAgo(60))).toBeCloseTo(0.42); // 0.6 * 0.7
    });
  });

  it("handles future timestamps gracefully (no negative days)", () => {
    withFixedNow(() => {
      expect(effectiveConfidence(BASE_CONFIDENCE, NOW + 86_400_000)).toBe(1.0);
    });
  });
});
