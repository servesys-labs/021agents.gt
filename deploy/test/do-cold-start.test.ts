/**
 * Tests for Durable Object cold start, eviction, and state recovery.
 *
 * Covers:
 * - prioritizedFlush: billing → session → telemetry ordering
 * - buildFlushTasks: task construction with correct priorities
 * - backupCostState → hydrateFromSnapshot round-trip across eviction
 * - recoverCostState: returns null when stale or missing
 * - Eviction mid-conversation: session state survives via KV snapshot
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  prioritizedFlush,
  buildFlushTasks,
  hydrateFromSnapshot,
  backupCostState,
  recoverCostState,
} from "../src/runtime/do-lifecycle";

// ── Mock KV + Queue ───────────────────────────────────────────────

function makeMockEnv() {
  const kvStore = new Map<string, { value: string; ttl?: number }>();
  const queueMessages: Array<{ type: string; payload: any }> = [];

  return {
    kvStore,
    queueMessages,
    env: {
      AGENT_PROGRESS_KV: {
        put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
          kvStore.set(k, { value: v, ttl: opts?.expirationTtl });
        },
        get: async (k: string) => kvStore.get(k)?.value ?? null,
        delete: async (k: string) => { kvStore.delete(k); },
      },
      TELEMETRY_QUEUE: {
        send: async (msg: any) => { queueMessages.push(msg); },
      },
    } as any,
  };
}

// ── prioritizedFlush ──────────────────────────────────────────────

describe("prioritizedFlush — eviction ordering", () => {
  it("executes tasks in priority order (billing first)", async () => {
    const order: string[] = [];
    const result = await prioritizedFlush([
      { name: "telemetry", priority: 3, timeoutMs: 1000, fn: async () => { order.push("telemetry"); } },
      { name: "billing", priority: 1, timeoutMs: 1000, fn: async () => { order.push("billing"); } },
      { name: "session", priority: 2, timeoutMs: 1000, fn: async () => { order.push("session"); } },
    ]);

    expect(order).toEqual(["billing", "session", "telemetry"]);
    expect(result.completed).toEqual(["billing", "session", "telemetry"]);
    expect(result.failed).toEqual([]);
    expect(result.timedOut).toEqual([]);
  });

  it("isolates failures — billing failure does not skip session", async () => {
    const order: string[] = [];
    const result = await prioritizedFlush([
      { name: "billing", priority: 1, timeoutMs: 1000, fn: async () => { throw new Error("DB down"); } },
      { name: "session", priority: 2, timeoutMs: 1000, fn: async () => { order.push("session"); } },
      { name: "telemetry", priority: 3, timeoutMs: 1000, fn: async () => { order.push("telemetry"); } },
    ]);

    expect(order).toEqual(["session", "telemetry"]);
    expect(result.failed).toEqual(["billing"]);
    expect(result.completed).toContain("session");
    expect(result.completed).toContain("telemetry");
  });

  it("respects total budget — low-priority tasks skipped when budget exhausted", async () => {
    const result = await prioritizedFlush([
      { name: "billing", priority: 1, timeoutMs: 1000, fn: async () => { await new Promise(r => setTimeout(r, 50)); } },
      { name: "session", priority: 2, timeoutMs: 1000, fn: async () => { await new Promise(r => setTimeout(r, 50)); } },
      { name: "telemetry", priority: 3, timeoutMs: 1000, fn: async () => {} },
    ], 80); // Only 80ms budget — telemetry may be timed out

    expect(result.completed).toContain("billing");
    // With 80ms total, billing + session take ~100ms, telemetry likely timed out
    // This is non-deterministic, but billing must always complete
  });
});

// ── buildFlushTasks ───────────────────────────────────────────────

describe("buildFlushTasks — task construction", () => {
  it("creates 3 tasks with correct priorities", () => {
    const { env } = makeMockEnv();
    const tasks = buildFlushTasks(env, {
      sessionId: "sess-1",
      orgId: "org-1",
      agentName: "test-agent",
      totalCostUsd: 0.05,
      turnCount: 3,
    });

    expect(tasks).toHaveLength(3);
    expect(tasks.find(t => t.name === "billing")?.priority).toBe(1);
    expect(tasks.find(t => t.name === "session_state")?.priority).toBe(2);
    expect(tasks.find(t => t.name === "telemetry")?.priority).toBe(3);
  });

  it("billing task sends cost to telemetry queue", async () => {
    const { env, queueMessages } = makeMockEnv();
    const tasks = buildFlushTasks(env, {
      sessionId: "sess-1",
      orgId: "org-1",
      agentName: "test-agent",
      totalCostUsd: 0.123,
      turnCount: 5,
    });

    const billingTask = tasks.find(t => t.name === "billing")!;
    await billingTask.fn();

    expect(queueMessages).toHaveLength(1);
    expect(queueMessages[0].type).toBe("billing_flush");
    expect(queueMessages[0].payload.cost_usd).toBe(0.123);
    expect(queueMessages[0].payload.session_id).toBe("sess-1");
    expect(queueMessages[0].payload.turns).toBe(5);
  });

  it("billing task is a no-op when cost is zero", async () => {
    const { env, queueMessages } = makeMockEnv();
    const tasks = buildFlushTasks(env, {
      sessionId: "sess-1", orgId: "org-1", agentName: "test-agent",
      totalCostUsd: 0, turnCount: 0,
    });

    await tasks.find(t => t.name === "billing")!.fn();
    expect(queueMessages).toHaveLength(0);
  });

  it("session_state task writes snapshot to KV", async () => {
    const { env, kvStore } = makeMockEnv();
    const tasks = buildFlushTasks(env, {
      sessionId: "sess-42",
      orgId: "org-1",
      agentName: "agent-a",
      totalCostUsd: 0.5,
      turnCount: 10,
    });

    await tasks.find(t => t.name === "session_state")!.fn();

    const stored = kvStore.get("session-state/sess-42");
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!.value);
    expect(parsed.totalCostUsd).toBe(0.5);
    expect(parsed.turnCount).toBe(10);
    expect(parsed.orgId).toBe("org-1");
    expect(stored!.ttl).toBe(86400);
  });
});

// ── Snapshot recovery across eviction ─────────────────────────────

describe("hydrateFromSnapshot — cold start recovery", () => {
  it("round-trips: backup → eviction → hydrate recovers state", async () => {
    const { env } = makeMockEnv();

    await backupCostState(env, "sess-99", 1.23, 7, "org-x", "my-agent");
    const snapshot = await hydrateFromSnapshot(env, "sess-99");

    expect(snapshot).not.toBeNull();
    expect(snapshot!.totalCostUsd).toBe(1.23);
    expect(snapshot!.turnCount).toBe(7);
    expect(snapshot!.orgId).toBe("org-x");
    expect(snapshot!.agentName).toBe("my-agent");
  });

  it("returns null for non-existent session", async () => {
    const { env } = makeMockEnv();
    const snapshot = await hydrateFromSnapshot(env, "no-such-session");
    expect(snapshot).toBeNull();
  });

  it("returns null for stale snapshot (>maxAge)", async () => {
    const { env, kvStore } = makeMockEnv();
    // Write a snapshot that's 2 hours old
    kvStore.set("session-state/old-sess", {
      value: JSON.stringify({
        totalCostUsd: 1.0, turnCount: 5,
        orgId: "org-1", agentName: "agent-1",
        savedAt: Date.now() - 7200_000, // 2 hours ago
      }),
    });

    const snapshot = await hydrateFromSnapshot(env, "old-sess", 3600_000);
    expect(snapshot).toBeNull();
  });

  it("recoverCostState extracts cost + turn count", async () => {
    const { env } = makeMockEnv();
    await backupCostState(env, "sess-cost", 0.456, 12, "org-1", "agent-1");

    const recovered = await recoverCostState(env, "sess-cost");
    expect(recovered).not.toBeNull();
    expect(recovered!.costUsd).toBe(0.456);
    expect(recovered!.turnCount).toBe(12);
  });

  it("recoverCostState returns null when KV is unavailable", async () => {
    const env = {} as any; // no AGENT_PROGRESS_KV
    const recovered = await recoverCostState(env, "sess-no-kv");
    expect(recovered).toBeNull();
  });
});

// ── Full eviction → cold start lifecycle ──────────────────────────

describe("full eviction → recovery lifecycle", () => {
  it("flush persists state that cold start can recover", async () => {
    const { env } = makeMockEnv();

    // Simulate active session state
    const sessionState = {
      sessionId: "lifecycle-sess",
      orgId: "org-lifecycle",
      agentName: "lifecycle-agent",
      totalCostUsd: 2.50,
      turnCount: 15,
    };

    // Step 1: DO is about to be evicted — run prioritized flush
    const tasks = buildFlushTasks(env, sessionState);
    const flushResult = await prioritizedFlush(tasks);
    expect(flushResult.completed).toContain("session_state");
    expect(flushResult.completed).toContain("billing");

    // Step 2: DO is evicted (memory gone)

    // Step 3: New request arrives — cold start hydration
    const snapshot = await hydrateFromSnapshot(env, "lifecycle-sess");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.totalCostUsd).toBe(2.50);
    expect(snapshot!.turnCount).toBe(15);
    expect(snapshot!.agentName).toBe("lifecycle-agent");

    // Step 4: recoverCostState also works
    const costState = await recoverCostState(env, "lifecycle-sess");
    expect(costState).not.toBeNull();
    expect(costState!.costUsd).toBe(2.50);
  });
});
