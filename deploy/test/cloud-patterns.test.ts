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

// ── C2.1+C4.2: Snapshot Hydration + Cost Recovery (integration) ──

import { hydrateFromSnapshot, backupCostState, recoverCostState } from "../src/runtime/do-lifecycle";

describe("snapshot hydration + cost recovery", () => {
  it("hydrateFromSnapshot returns null when KV unavailable", async () => {
    expect(await hydrateFromSnapshot({} as any, "sess-1")).toBeNull();
  });

  it("recoverCostState returns null when no snapshot exists", async () => {
    expect(await recoverCostState({} as any, "nonexistent")).toBeNull();
  });

  it("backupCostState does not throw when KV unavailable", async () => {
    await expect(backupCostState({} as any, "s1", 1.5, 10)).resolves.toBeUndefined();
  });

  it("round-trips cost state through mock KV", async () => {
    const store = new Map<string, string>();
    const mockEnv = {
      AGENT_PROGRESS_KV: {
        put: async (k: string, v: string) => { store.set(k, v); },
        get: async (k: string) => store.get(k) ?? null,
      },
    };
    await backupCostState(mockEnv as any, "sess-rt", 2.5, 7, "org-1", "assistant");
    const snapshot = await hydrateFromSnapshot(mockEnv as any, "sess-rt");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.totalCostUsd).toBe(2.5);
    expect(snapshot!.turnCount).toBe(7);

    const recovered = await recoverCostState(mockEnv as any, "sess-rt");
    expect(recovered!.costUsd).toBe(2.5);
  });

  it("rejects stale snapshots beyond maxAge", async () => {
    const store = new Map<string, string>();
    store.set("session-state/stale", JSON.stringify({
      totalCostUsd: 1.0, turnCount: 3, orgId: "org", agentName: "a",
      savedAt: Date.now() - 7200_000,
    }));
    const mockEnv = {
      AGENT_PROGRESS_KV: { get: async (k: string) => store.get(k) ?? null, put: async () => {} },
    };
    expect(await hydrateFromSnapshot(mockEnv as any, "stale", 3600_000)).toBeNull();
  });
});

// ── C3.3: Event Compaction (integration) ──────────────────────────

import { compactProgressEvents } from "../src/runtime/ws-dedup";

describe("compactProgressEvents", () => {
  it("returns zero counts when KV unavailable", async () => {
    const result = await compactProgressEvents(null, "key");
    expect(result).toEqual({ before: 0, after: 0 });
  });

  it("removes intermediate events from mock KV", async () => {
    const events = [
      { type: "session_start" }, { type: "turn_start" },
      { type: "tool_progress" }, { type: "tool_progress" }, { type: "heartbeat" },
      { type: "tool_call" }, { type: "tool_result" },
      { type: "turn_end" }, { type: "done" },
    ];
    const store = new Map<string, string>();
    store.set("pk", JSON.stringify(events));
    const mockKv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
    };
    const result = await compactProgressEvents(mockKv, "pk");
    expect(result.before).toBe(9);
    expect(result.after).toBe(6);
  });
});

// ── C2.2: Version-based cache invalidation ────────────────────────

import { isEnabled, setFlag, listFlags } from "../src/runtime/features";

describe("feature flags version cache", () => {
  it("returns defaults when KV unavailable", async () => {
    expect(await isEnabled({} as any, "concurrent_tools", "org-1")).toBe(true);
  });

  it("returns false for unknown flags", async () => {
    expect(await isEnabled({} as any, "nonexistent", "org-1")).toBe(false);
  });

  it("setFlag bumps version key", async () => {
    const store = new Map<string, string>();
    const mockEnv = {
      AGENT_PROGRESS_KV: {
        put: async (k: string, v: string) => { store.set(k, v); },
        get: async (k: string) => store.get(k) ?? null,
      },
    };
    await setFlag(mockEnv as any, "test_flag", "org-v", true);
    const v1 = Number(store.get("features-version/org-v"));
    expect(v1).toBeGreaterThan(0);

    await setFlag(mockEnv as any, "test_flag", "org-v", false);
    expect(Number(store.get("features-version/org-v"))).toBe(v1 + 1);
  });
});

// ── C3.1: R2 result persistence (mock R2) ─────────────────────────

describe("processToolResult with mock R2", () => {
  it("persists large results and supports retrieval", async () => {
    const r2 = new Map<string, { body: string; meta: any }>();
    const mockEnv = {
      STORAGE: {
        put: async (key: string, body: string, opts: any) => { r2.set(key, { body, meta: opts?.customMetadata }); },
        get: async (key: string) => { const e = r2.get(key); return e ? { text: async () => e.body } : null; },
      },
    };
    const big = "x".repeat(50_000);
    const result = await processToolResult(mockEnv as any, big, { sessionId: "s1", toolCallId: "tc1", toolName: "grep" });
    expect(result.persisted).toBe(true);
    expect(result.content).toContain("retrieve-result");
    expect(result.content.length).toBeLessThan(big.length);

    const full = await retrieveToolResult(mockEnv as any, result.r2Key!);
    expect(full).toBe(big);
  });
});

// ── C1.2: Write dedup lifecycle ───────────────────────────────────

import { clearSessionDedup } from "../src/runtime/idempotency";

describe("write dedup lifecycle", () => {
  it("clears dedup set on session end", () => {
    const sid = "cleanup-" + Date.now();
    const uuid = "uuid-" + Date.now();
    isDuplicateWrite(uuid, sid);
    expect(isDuplicateWrite(uuid, sid)).toBe(true);
    clearSessionDedup(sid);
    expect(isDuplicateWrite(uuid, sid)).toBe(false);
  });
});
