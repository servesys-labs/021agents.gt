import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { memoryFreshnessNote } from "../src/runtime/memory";

describe("memoryFreshnessNote", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty for memories from today", () => {
    const ts = new Date("2026-04-02T10:00:00Z").getTime();
    expect(memoryFreshnessNote(ts)).toBe("");
  });

  it("returns empty for yesterday", () => {
    const ts = new Date("2026-04-01T10:00:00Z").getTime();
    expect(memoryFreshnessNote(ts)).toBe("");
  });

  it("warns for entries older than ~1 day", () => {
    const ts = new Date("2026-03-30T10:00:00Z").getTime();
    const note = memoryFreshnessNote(ts);
    expect(note).toContain("memory is ~");
    expect(note).toContain("days old");
    expect(note).toContain("verify");
  });
});
