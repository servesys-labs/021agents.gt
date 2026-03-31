/**
 * Tests for cloud-specific patterns (Sprints C1-C4)
 * Covers: idempotency, DO lifecycle, result storage, WS dedup, session counter
 */
import { describe, it, expect } from "vitest";

// ── C1: Idempotency ────────────────────────────────────────────────

import { stepIdempotencyKey, hashArgs, isDuplicateWrite, writeUUID } from "../src/runtime/idempotency";

describe("stepIdempotencyKey", () => {
  it("produces deterministic keys", () => {
    const k1 = stepIdempotencyKey("sess1", 3, "bash", "abc123");
    const k2 = stepIdempotencyKey("sess1", 3, "bash", "abc123");
    expect(k1).toBe(k2);
  });

  it("different args produce different keys", () => {
    const k1 = stepIdempotencyKey("sess1", 3, "bash", "abc");
    const k2 = stepIdempotencyKey("sess1", 3, "bash", "xyz");
    expect(k1).not.toBe(k2);
  });

  it("includes session, turn, tool in key", () => {
    const k = stepIdempotencyKey("sess1", 3, "grep", "hash");
    expect(k).toContain("sess1");
    expect(k).toContain("t3");
    expect(k).toContain("grep");
  });
});

describe("hashArgs", () => {
  it("produces consistent hashes", () => {
    expect(hashArgs('{"query":"test"}')).toBe(hashArgs('{"query":"test"}'));
  });

  it("different inputs produce different hashes", () => {
    expect(hashArgs("abc")).not.toBe(hashArgs("xyz"));
  });

  it("returns a base36 string", () => {
    const h = hashArgs("test input");
    expect(h).toMatch(/^[0-9a-z]+$/);
  });
});

describe("isDuplicateWrite", () => {
  it("returns false for new UUIDs", () => {
    expect(isDuplicateWrite("unique-uuid-" + Date.now(), "test-session")).toBe(false);
  });

  it("returns true for seen UUIDs within same session", () => {
    const sid = "dup-session-" + Date.now();
    const uuid = "dup-test-" + Date.now();
    isDuplicateWrite(uuid, sid); // first call
    expect(isDuplicateWrite(uuid, sid)).toBe(true); // duplicate
  });

  it("different sessions have independent dedup sets", () => {
    const uuid = "cross-session-" + Date.now();
    isDuplicateWrite(uuid, "session-A");
    // Same UUID in different session is NOT a duplicate
    expect(isDuplicateWrite(uuid, "session-B")).toBe(false);
  });
});

describe("writeUUID", () => {
  it("is deterministic from session + turn + type", () => {
    expect(writeUUID("s1", 3, "session")).toBe(writeUUID("s1", 3, "session"));
  });

  it("different types produce different UUIDs", () => {
    expect(writeUUID("s1", 3, "session")).not.toBe(writeUUID("s1", 3, "turn"));
  });
});

// ── C1.3 + C2.1: DO Lifecycle ──────────────────────────────────────

import { prioritizedFlush } from "../src/runtime/do-lifecycle";

describe("prioritizedFlush", () => {
  it("executes tasks in priority order", async () => {
    const order: string[] = [];
    const result = await prioritizedFlush([
      { name: "low", priority: 3, timeoutMs: 1000, fn: async () => { order.push("low"); } },
      { name: "high", priority: 1, timeoutMs: 1000, fn: async () => { order.push("high"); } },
      { name: "mid", priority: 2, timeoutMs: 1000, fn: async () => { order.push("mid"); } },
    ]);
    expect(order).toEqual(["high", "mid", "low"]);
    expect(result.completed).toEqual(["high", "mid", "low"]);
    expect(result.failed.length).toBe(0);
  });

  it("handles task failures without stopping others", async () => {
    const result = await prioritizedFlush([
      { name: "ok1", priority: 1, timeoutMs: 1000, fn: async () => {} },
      { name: "fail", priority: 2, timeoutMs: 1000, fn: async () => { throw new Error("boom"); } },
      { name: "ok2", priority: 3, timeoutMs: 1000, fn: async () => {} },
    ]);
    expect(result.completed).toContain("ok1");
    expect(result.completed).toContain("ok2");
    expect(result.failed).toContain("fail");
  });

  it("respects total budget timeout", async () => {
    const result = await prioritizedFlush([
      { name: "slow", priority: 1, timeoutMs: 5000, fn: () => new Promise(r => setTimeout(r, 100)) },
      { name: "slower", priority: 2, timeoutMs: 5000, fn: () => new Promise(r => setTimeout(r, 100)) },
    ], 150); // 150ms total budget — only first task completes
    expect(result.completed.length).toBeGreaterThanOrEqual(1);
  });

  it("handles task timeout within budget", async () => {
    const result = await prioritizedFlush([
      { name: "hangs", priority: 1, timeoutMs: 50, fn: () => new Promise(() => {}) }, // never resolves
      { name: "fast", priority: 2, timeoutMs: 1000, fn: async () => {} },
    ], 5000);
    expect(result.timedOut).toContain("hangs");
    expect(result.completed).toContain("fast");
  });
});

// ── C3.1: Result Storage ───────────────────────────────────────────

import { processToolResult, retrieveToolResult } from "../src/runtime/result-storage";

describe("processToolResult", () => {
  it("returns small results unchanged", async () => {
    const result = await processToolResult({} as any, "short result", {
      sessionId: "s1", toolCallId: "tc1", toolName: "grep",
    });
    expect(result.content).toBe("short result");
    expect(result.persisted).toBe(false);
  });

  it("truncates large results when R2 unavailable", async () => {
    const largeResult = "x".repeat(50_000);
    const result = await processToolResult({} as any, largeResult, {
      sessionId: "s1", toolCallId: "tc1", toolName: "grep",
    });
    expect(result.persisted).toBe(false);
    expect(result.content.length).toBeLessThan(largeResult.length);
    expect(result.content).toContain("truncated");
  });
});

// ── C3.2: WebSocket Dedup ──────────────────────────────────────────

import { BoundedUUIDSet, EventSequencer } from "../src/runtime/ws-dedup";

describe("BoundedUUIDSet", () => {
  it("tracks added UUIDs", () => {
    const set = new BoundedUUIDSet(100);
    set.add("uuid-1");
    expect(set.has("uuid-1")).toBe(true);
    expect(set.has("uuid-2")).toBe(false);
  });

  it("evicts oldest when over capacity", () => {
    const set = new BoundedUUIDSet(3);
    set.add("a");
    set.add("b");
    set.add("c");
    set.add("d"); // evicts "a"
    expect(set.has("a")).toBe(false);
    expect(set.has("d")).toBe(true);
    expect(set.size).toBe(3);
  });
});

describe("EventSequencer", () => {
  it("assigns monotonic sequence numbers", () => {
    const seq = new EventSequencer();
    const e1 = seq.push("token", { content: "a" });
    const e2 = seq.push("token", { content: "b" });
    expect(e2.seq).toBeGreaterThan(e1.seq);
  });

  it("getAfter returns only events after cursor", () => {
    const seq = new EventSequencer();
    seq.push("turn_start", { turn: 1 });
    seq.push("token", { content: "hello" });
    const cursor = seq.getLatestSeq();
    seq.push("turn_end", { turn: 1 });

    const { events, resyncRequired } = seq.getAfter(cursor);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("turn_end");
    expect(resyncRequired).toBe(false);
  });

  it("signals resync when requested seq was evicted", () => {
    const seq = new EventSequencer(5);
    for (let i = 0; i < 10; i++) seq.push("token", { i });
    // Requesting seq 1 which was evicted
    const { resyncRequired } = seq.getAfter(1);
    expect(resyncRequired).toBe(true);
  });

  it("evicts oldest events when over capacity", () => {
    const seq = new EventSequencer(10);
    for (let i = 0; i < 20; i++) {
      seq.push("token", { i });
    }
    expect(seq.getCount()).toBeLessThanOrEqual(10);
  });

  it("getLatestSeq returns 0 when empty", () => {
    const seq = new EventSequencer();
    expect(seq.getLatestSeq()).toBe(0);
  });
});

// ── C4.1: Session Counter ──────────────────────────────────────────

import { isSessionLimitReached } from "../src/runtime/session-counter";

describe("isSessionLimitReached", () => {
  it("returns not limited when KV unavailable", async () => {
    const result = await isSessionLimitReached({} as any, "org-1", 10);
    expect(result.limited).toBe(false);
    expect(result.active).toBe(0);
  });
});
