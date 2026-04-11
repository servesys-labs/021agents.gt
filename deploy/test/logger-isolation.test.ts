/**
 * Regression tests for JsonlLogger per-instance isolation.
 *
 * The old module-level singleton in logger.ts was cross-tenant unsafe: two
 * concurrent workflows on the same Worker isolate called `logger.init(...)`
 * one after the other, and the second call overwrote the first's context,
 * so workflow A's log events would be tagged with workflow B's org_id /
 * session_id / trace_id and written to workflow B's KV key.
 *
 * The fix replaced the singleton with per-request instances. These tests
 * lock that in: creating two JsonlLogger instances at the same time must
 * keep their contexts and their KV flush targets completely separate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createJsonlLogger, JsonlLogger } from "../src/runtime/logger";

type KvEntry = { value: string; options?: { expirationTtl?: number } };

class FakeKv {
  store = new Map<string, KvEntry>();
  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    this.store.set(key, { value, options });
  }
  async get(key: string) {
    return this.store.get(key)?.value ?? null;
  }
  keys(): string[] {
    return [...this.store.keys()];
  }
  parseJsonl(key: string): Array<Record<string, unknown>> {
    const raw = this.store.get(key)?.value ?? "";
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

function envWith(kv: FakeKv): any {
  return { AGENT_PROGRESS_KV: kv };
}

describe("JsonlLogger per-instance isolation", () => {
  let kv: FakeKv;
  beforeEach(() => {
    kv = new FakeKv();
  });

  it("tags events with the instance's own context, not another instance's", async () => {
    const loggerA = createJsonlLogger(envWith(kv), {
      session_id: "sess_A", trace_id: "trace_A", org_id: "org_A", agent_name: "agent_A",
    });
    const loggerB = createJsonlLogger(envWith(kv), {
      session_id: "sess_B", trace_id: "trace_B", org_id: "org_B", agent_name: "agent_B",
    });

    // Interleave the way two concurrent workflows would.
    loggerA.info("event_1", { step: "a1" });
    loggerB.info("event_1", { step: "b1" });
    loggerA.warn("event_2", { step: "a2" });
    loggerB.warn("event_2", { step: "b2" });

    await loggerA.flush();
    await loggerB.flush();

    // Every key must land under the instance's own org_id
    const aKeys = kv.keys().filter((k) => k.startsWith("logs/org_A/"));
    const bKeys = kv.keys().filter((k) => k.startsWith("logs/org_B/"));
    expect(aKeys.length).toBeGreaterThan(0);
    expect(bKeys.length).toBeGreaterThan(0);
    expect(aKeys.length + bKeys.length).toBe(kv.keys().length);

    // Every entry in A's key must carry org_A / sess_A, and NOTHING from B
    for (const key of aKeys) {
      const entries = kv.parseJsonl(key);
      for (const e of entries) {
        expect(e.org_id).toBe("org_A");
        expect(e.session_id).toBe("sess_A");
        expect(e.trace_id).toBe("trace_A");
        expect(e.agent_name).toBe("agent_A");
      }
    }
    for (const key of bKeys) {
      const entries = kv.parseJsonl(key);
      for (const e of entries) {
        expect(e.org_id).toBe("org_B");
        expect(e.session_id).toBe("sess_B");
        expect(e.trace_id).toBe("trace_B");
        expect(e.agent_name).toBe("agent_B");
      }
    }
  });

  it("writes unique KV keys per flush — never clobbers via read-modify-write", async () => {
    // The old flush() did `existing = await kv.get(key); await kv.put(key, existing + jsonl)`
    // which is a race. The new flush writes to a unique per-batch key so
    // two concurrent flushes can't lose each other's entries.
    const logger = createJsonlLogger(envWith(kv), {
      session_id: "sess_race", org_id: "org_race",
    });

    // Trigger several flushes back-to-back
    logger.info("a");
    await logger.flush();
    logger.info("b");
    await logger.flush();
    logger.info("c");
    await logger.flush();

    const keys = kv.keys();
    expect(keys.length).toBe(3);
    // All three keys must be distinct
    expect(new Set(keys).size).toBe(3);
    // Every flushed entry must be recoverable
    const allEvents = keys.flatMap((k) => kv.parseJsonl(k).map((e) => e.event));
    expect(allEvents.sort()).toEqual(["a", "b", "c"]);
  });

  it("concurrent flushes on the same logger don't lose entries", async () => {
    const logger = createJsonlLogger(envWith(kv), {
      session_id: "sess_concurrent", org_id: "org_concurrent",
    });

    // Enqueue a batch, kick off a flush, enqueue more, kick off another flush.
    // Both flushes must succeed without dropping events.
    logger.info("e1");
    logger.info("e2");
    const p1 = logger.flush();
    logger.info("e3");
    logger.info("e4");
    const p2 = logger.flush();
    await Promise.all([p1, p2]);

    const allEvents = kv.keys().flatMap((k) => kv.parseJsonl(k).map((e) => e.event));
    // Every event that was logged must appear exactly once in KV
    expect(allEvents.sort()).toEqual(["e1", "e2", "e3", "e4"]);
  });

  it("does not leak context from sibling instances created later", async () => {
    // Create instance A, log some events, then create instance B with a
    // DIFFERENT context. Events already logged on A must not suddenly
    // inherit B's tags on flush.
    const loggerA = createJsonlLogger(envWith(kv), {
      session_id: "sess_A", org_id: "org_A",
    });
    loggerA.info("first");
    loggerA.info("second");

    // Spawn another logger between enqueue and flush
    createJsonlLogger(envWith(kv), {
      session_id: "sess_B", org_id: "org_B",
    });

    await loggerA.flush();

    const entries = kv.keys().flatMap((k) => kv.parseJsonl(k));
    expect(entries.length).toBe(2);
    for (const e of entries) {
      expect(e.org_id).toBe("org_A");
      expect(e.session_id).toBe("sess_A");
    }
  });

  it("is safe to construct with no env (env=null) — degrades gracefully without throwing", () => {
    const logger: JsonlLogger = createJsonlLogger(null, {
      session_id: "sess_noenv", org_id: "org_noenv",
    });
    expect(() => {
      logger.info("no_env_info");
      logger.warn("no_env_warn");
      logger.error("no_env_error");
    }).not.toThrow();
    // flush() must also be a no-op, not a crash
    return expect(logger.flush()).resolves.toBeUndefined();
  });

  it("flushes automatically when the buffer reaches the size threshold", async () => {
    const logger = createJsonlLogger(envWith(kv), {
      session_id: "sess_autoflush", org_id: "org_autoflush",
    });
    // MAX_BUFFER in logger.ts is 50
    for (let i = 0; i < 60; i++) {
      logger.info(`event_${i}`);
    }
    // Give the auto-flush a microtask to complete
    await new Promise((r) => setTimeout(r, 10));

    const keys = kv.keys();
    expect(keys.length).toBeGreaterThanOrEqual(1);
    const entries = keys.flatMap((k) => kv.parseJsonl(k));
    expect(entries.length).toBeGreaterThanOrEqual(50);
  });
});
