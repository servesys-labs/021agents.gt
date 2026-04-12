import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { SignalCoordinatorDO } from "../src/runtime/signal-coordinator-do";
import {
  buildSignalCoordinatorKey,
  deriveSignalEnvelopes,
  signalEnvelopeMessage,
  type SignalEnvelope,
} from "../src/runtime/signals";

const NOW = 1_700_000_000_000;

function makeEnvelope(overrides: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    id: overrides.id || randomUUID(),
    feature: "memory",
    signal_type: overrides.signal_type || "tool_failure",
    source_type: overrides.source_type || "runtime_event",
    org_id: overrides.org_id || "org-1",
    agent_name: overrides.agent_name || "personal-agent",
    session_id: overrides.session_id || "sess-1",
    created_at_ms: overrides.created_at_ms || NOW,
    signature: overrides.signature || "sig-1",
    topic: overrides.topic || "billing outage",
    summary: overrides.summary || "Repeated billing outage failures",
    severity: overrides.severity ?? 0.9,
    entities: overrides.entities || ["Stripe"],
    metadata: overrides.metadata || {},
  };
}

class FakeCursor<T extends Record<string, any>> {
  readonly columnNames: string[];
  constructor(
    private readonly rows: T[],
    private readonly written: number,
  ) {
    this.columnNames = rows[0] ? Object.keys(rows[0]) : [];
  }

  toArray(): T[] {
    return [...this.rows];
  }

  one(): T {
    if (!this.rows.length) throw new Error("No rows");
    return this.rows[0];
  }

  raw<U extends any[]>(): IterableIterator<U> {
    return ([] as U[])[Symbol.iterator]();
  }

  get rowsRead(): number {
    return this.rows.length;
  }

  get rowsWritten(): number {
    return this.written;
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.rows[Symbol.iterator]();
  }
}

type EventRow = {
  id: string;
  feature: string;
  signal_type: string;
  session_id: string;
  created_at_ms: number;
  signature: string;
  topic: string;
  severity: number;
  summary: string;
  entities_json: string;
  metadata_json: string;
};

type ClusterRow = {
  feature: string;
  signature: string;
  signal_type: string;
  topic: string;
  count: number;
  first_seen_ms: number;
  last_seen_ms: number;
  max_severity: number;
  last_session_id: string;
  sample_summary: string;
  entities_json: string;
};

type CooldownRow = {
  feature: string;
  dedupe_key: string;
  until_ms: number;
  last_fire_id: string;
  updated_at_ms: number;
};

type WorkflowFireRow = {
  fire_id: string;
  feature: string;
  signature: string;
  workflow_kind: string;
  workflow_instance_id: string;
  fired_at_ms: number;
  org_id: string;
  agent_name: string;
  signal_briefing: string;
};

class FakeSqlStorage {
  readonly events = new Map<string, EventRow>();
  readonly clusters = new Map<string, ClusterRow>();
  readonly cooldowns = new Map<string, CooldownRow>();
  readonly fires = new Map<string, WorkflowFireRow>();
  readonly state = new Map<string, { value_text: string; updated_at_ms: number }>();

  exec<T extends Record<string, any>>(query: string, ...bindings: any[]): FakeCursor<T> {
    const q = normalize(query);

    if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) {
      return new FakeCursor<T>([], 0);
    }

    if (q.includes("INSERT OR IGNORE INTO signal_events")) {
      const [id, feature, signalType, sessionId, createdAtMs, signature, topic, severity, summary, entitiesJson, metadataJson] = bindings;
      if (this.events.has(id)) return new FakeCursor<T>([], 0);
      this.events.set(String(id), {
        id: String(id),
        feature: String(feature),
        signal_type: String(signalType),
        session_id: String(sessionId),
        created_at_ms: Number(createdAtMs),
        signature: String(signature),
        topic: String(topic),
        severity: Number(severity),
        summary: String(summary),
        entities_json: String(entitiesJson),
        metadata_json: String(metadataJson),
      });
      return new FakeCursor<T>([], 1);
    }

    if (q.includes("INSERT INTO signal_clusters")) {
      const [feature, signature, signalType, topic, firstSeenMs, lastSeenMs, maxSeverity, lastSessionId, sampleSummary, entitiesJson] = bindings;
      const existing = this.clusters.get(String(signature));
      if (!existing) {
        this.clusters.set(String(signature), {
          feature: String(feature),
          signature: String(signature),
          signal_type: String(signalType),
          topic: String(topic),
          count: 1,
          first_seen_ms: Number(firstSeenMs),
          last_seen_ms: Number(lastSeenMs),
          max_severity: Number(maxSeverity),
          last_session_id: String(lastSessionId),
          sample_summary: String(sampleSummary),
          entities_json: String(entitiesJson),
        });
      } else {
        existing.count += 1;
        existing.last_seen_ms = Number(lastSeenMs);
        if (String(topic).length > existing.topic.length) existing.topic = String(topic);
        existing.max_severity = Math.max(existing.max_severity, Number(maxSeverity));
        existing.last_session_id = String(lastSessionId);
        if (!existing.sample_summary) existing.sample_summary = String(sampleSummary);
        if (existing.entities_json === "[]") existing.entities_json = String(entitiesJson);
      }
      return new FakeCursor<T>([], 1);
    }

    if (q.includes("INSERT INTO signal_state")) {
      if (q.includes("VALUES('pending_reason', ?, ?)")) {
        const [valueText, updatedAtMs] = bindings;
        this.state.set("pending_reason", {
          value_text: String(valueText),
          updated_at_ms: Number(updatedAtMs),
        });
      } else if (q.includes("VALUES('pending', '1', ?)")) {
        const [updatedAtMs] = bindings;
        this.state.set("pending", {
          value_text: "1",
          updated_at_ms: Number(updatedAtMs),
        });
      } else if (q.includes("VALUES('pending', '0', ?)")) {
        const [updatedAtMs] = bindings;
        this.state.set("pending", {
          value_text: "0",
          updated_at_ms: Number(updatedAtMs),
        });
      } else {
        const [key, valueText, updatedAtMs] = bindings;
        this.state.set(String(key), {
          value_text: String(valueText),
          updated_at_ms: Number(updatedAtMs),
        });
      }
      return new FakeCursor<T>([], 1);
    }

    if (q.includes("SELECT value_text FROM signal_state WHERE key = 'pending'")) {
      const row = this.state.get("pending");
      return new FakeCursor<T>(row ? ([{ value_text: row.value_text }] as unknown as T[]) : [], 0);
    }

    if (q.includes("SELECT COUNT(*) AS value FROM signal_clusters")) {
      return new FakeCursor<T>([{ value: this.clusters.size }] as unknown as T[], 0);
    }

    if (q.includes("SELECT COUNT(*) AS value FROM signal_events")) {
      return new FakeCursor<T>([{ value: this.events.size }] as unknown as T[], 0);
    }

    if (q.includes("SELECT COUNT(*) AS value FROM signal_cooldowns WHERE until_ms > ?")) {
      const [nowMs] = bindings;
      const count = [...this.cooldowns.values()].filter((row) => row.until_ms > Number(nowMs)).length;
      return new FakeCursor<T>([{ value: count }] as unknown as T[], 0);
    }

    if (q.includes("SELECT COUNT(*) AS value FROM workflow_fires")) {
      return new FakeCursor<T>([{ value: this.fires.size }] as unknown as T[], 0);
    }

    if (q.includes("FROM signal_clusters") && q.includes("WHERE") && q.includes("feature = 'memory'")) {
      // Handles both the old simple query and the new optimized query with GROUP_CONCAT
      const cutoff = Number(bindings[bindings.length - 1] || 0); // last binding is the cutoff
      const rows = [...this.clusters.values()]
        .filter((row) => row.feature === "memory" && row.last_seen_ms >= cutoff)
        .sort((a, b) => b.last_seen_ms - a.last_seen_ms)
        .map((row) => {
          // Compute distinct_sessions and recent_summaries inline (mirrors the correlated subqueries)
          const sessionSet = new Set(
            [...this.events.values()]
              .filter((e) => e.signature === row.signature && e.created_at_ms >= cutoff)
              .map((e) => e.session_id),
          );
          const summaries = [...this.events.values()]
            .filter((e) => e.signature === row.signature)
            .sort((a, b) => b.created_at_ms - a.created_at_ms)
            .slice(0, 3)
            .map((e) => e.summary);
          return {
            ...row,
            distinct_sessions: sessionSet.size,
            recent_summaries: summaries.join("|||"),
          };
        }) as unknown as T[];
      return new FakeCursor<T>(rows, 0);
    }

    if (q.includes("SELECT feature, signature, signal_type, topic, count, first_seen_ms, last_seen_ms") && q.includes("LIMIT 20")) {
      const rows = [...this.clusters.values()]
        .sort((a, b) => b.last_seen_ms - a.last_seen_ms)
        .slice(0, 20) as unknown as T[];
      return new FakeCursor<T>(rows, 0);
    }

    if (q.includes("SELECT dedupe_key FROM signal_cooldowns")) {
      const [nowMs] = bindings;
      const rows = [...this.cooldowns.values()]
        .filter((row) => row.until_ms > Number(nowMs))
        .map((row) => ({ dedupe_key: row.dedupe_key })) as unknown as T[];
      return new FakeCursor<T>(rows, 0);
    }

    if (q.includes("SELECT COUNT(DISTINCT session_id) AS value")) {
      const [signature, cutoff] = bindings;
      const count = new Set(
        [...this.events.values()]
          .filter((row) => row.signature === String(signature) && row.created_at_ms >= Number(cutoff))
          .map((row) => row.session_id),
      ).size;
      return new FakeCursor<T>([{ value: count }] as unknown as T[], 0);
    }

    if (q.includes("SELECT summary FROM signal_events")) {
      const [signature] = bindings;
      const rows = [...this.events.values()]
        .filter((row) => row.signature === String(signature))
        .sort((a, b) => b.created_at_ms - a.created_at_ms)
        .slice(0, 3)
        .map((row) => ({ summary: row.summary })) as unknown as T[];
      return new FakeCursor<T>(rows, 0);
    }

    if (q.includes("SELECT session_id, summary, entities_json FROM signal_events")) {
      const [signature] = bindings;
      const rows = [...this.events.values()]
        .filter((row) => row.signature === String(signature))
        .sort((a, b) => b.created_at_ms - a.created_at_ms)
        .slice(0, 8)
        .map((row) => ({
          session_id: row.session_id,
          summary: row.summary,
          entities_json: row.entities_json,
        })) as unknown as T[];
      return new FakeCursor<T>(rows, 0);
    }

    if (q.includes("SELECT session_id FROM signal_events")) {
      const [signature] = bindings;
      const row = [...this.events.values()]
        .filter((entry) => entry.signature === String(signature))
        .sort((a, b) => b.created_at_ms - a.created_at_ms)[0];
      return new FakeCursor<T>(row ? ([{ session_id: row.session_id }] as unknown as T[]) : [], 0);
    }

    if (q.includes("SELECT feature FROM signal_clusters")) {
      const row = [...this.clusters.values()].sort((a, b) => b.last_seen_ms - a.last_seen_ms)[0];
      return new FakeCursor<T>(row ? ([{ feature: row.feature }] as unknown as T[]) : [], 0);
    }

    if (q.includes("SELECT feature FROM signal_events")) {
      const row = [...this.events.values()].sort((a, b) => b.created_at_ms - a.created_at_ms)[0];
      return new FakeCursor<T>(row ? ([{ feature: row.feature }] as unknown as T[]) : [], 0);
    }

    if (q.includes("SELECT metadata_json FROM signal_events")) {
      const row = [...this.events.values()].sort((a, b) => b.created_at_ms - a.created_at_ms)[0];
      return new FakeCursor<T>(row ? ([{ metadata_json: row.metadata_json }] as unknown as T[]) : [], 0);
    }

    if (q.includes("INSERT OR IGNORE INTO workflow_fires")) {
      const [fireId, signature, workflowKind, firedAtMs, orgId, agentName, briefing] = bindings;
      if (this.fires.has(String(fireId))) return new FakeCursor<T>([], 0);
      this.fires.set(String(fireId), {
        fire_id: String(fireId),
        feature: "memory",
        signature: String(signature),
        workflow_kind: String(workflowKind),
        workflow_instance_id: "",
        fired_at_ms: Number(firedAtMs),
        org_id: String(orgId),
        agent_name: String(agentName),
        signal_briefing: String(briefing),
      });
      return new FakeCursor<T>([], 1);
    }

    if (q.includes("DELETE FROM workflow_fires WHERE fire_id = ?")) {
      const [fireId] = bindings;
      const deleted = this.fires.delete(String(fireId)) ? 1 : 0;
      return new FakeCursor<T>([], deleted);
    }

    if (q.includes("UPDATE workflow_fires SET workflow_instance_id = ?")) {
      const [workflowId, fireId] = bindings;
      const row = this.fires.get(String(fireId));
      if (!row) return new FakeCursor<T>([], 0);
      row.workflow_instance_id = String(workflowId);
      return new FakeCursor<T>([], 1);
    }

    if (q.includes("INSERT INTO signal_cooldowns")) {
      const [dedupeKey, untilMs, lastFireId, updatedAtMs] = bindings;
      this.cooldowns.set(String(dedupeKey), {
        feature: "memory",
        dedupe_key: String(dedupeKey),
        until_ms: Number(untilMs),
        last_fire_id: String(lastFireId),
        updated_at_ms: Number(updatedAtMs),
      });
      return new FakeCursor<T>([], 1);
    }

    if (q.includes("DELETE FROM signal_events WHERE created_at_ms < ?")) {
      const [cutoff] = bindings;
      let deleted = 0;
      for (const [id, row] of this.events.entries()) {
        if (row.created_at_ms < Number(cutoff)) {
          this.events.delete(id);
          deleted++;
        }
      }
      return new FakeCursor<T>([], deleted);
    }

    if (q.includes("DELETE FROM workflow_fires WHERE fired_at_ms < ?")) {
      const [cutoff] = bindings;
      let deleted = 0;
      for (const [id, row] of this.fires.entries()) {
        if (row.fired_at_ms < Number(cutoff)) {
          this.fires.delete(id);
          deleted++;
        }
      }
      return new FakeCursor<T>([], deleted);
    }

    if (q.includes("DELETE FROM signal_cooldowns WHERE until_ms < ?")) {
      const [cutoff] = bindings;
      let deleted = 0;
      for (const [id, row] of this.cooldowns.entries()) {
        if (row.until_ms < Number(cutoff)) {
          this.cooldowns.delete(id);
          deleted++;
        }
      }
      return new FakeCursor<T>([], deleted);
    }

    // reconcile() cluster count recomputation — no-op in test (counts are already accurate)
    if (q.includes("UPDATE signal_clusters SET count")) {
      return new FakeCursor<T>([], 0);
    }
    // reconcile() prune zero-count clusters
    if (q.includes("DELETE FROM signal_clusters WHERE count = 0")) {
      return new FakeCursor<T>([], 0);
    }

    throw new Error(`Unhandled SQL in test harness: ${q}`);
  }
}

function createCoordinator() {
  const sql = new FakeSqlStorage();
  const storage = {
    sql,
    alarm: null as number | null,
    async getAlarm() {
      return this.alarm;
    },
    async setAlarm(value: number) {
      this.alarm = value;
    },
    async deleteAlarm() {
      this.alarm = null;
    },
  };
  const ctx = {
    storage,
    blockConcurrencyWhile(fn: () => Promise<void>) {
      return fn();
    },
  };
  const env = {
    AGENT_RUN_WORKFLOW: {
      create: vi.fn(async ({ params }: { params: any }) => ({ id: `wf-${params.progress_key}` })),
    },
    TELEMETRY_QUEUE: {
      send: vi.fn(async () => {}),
    },
    SIGNAL_ANALYTICS: {
      writeDataPoint: vi.fn(),
    },
  };

  return {
    coordinator: new SignalCoordinatorDO(ctx as any, env as any),
    sql,
    storage,
    env,
  };
}

function normalize(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

describe("SignalCoordinatorDO", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dedupes identical envelopes and schedules a single alarm window", async () => {
    const { coordinator, storage } = createCoordinator();
    const envelope = makeEnvelope({ id: "env-1" });

    const first = await coordinator.ingest(envelope);
    const second = await coordinator.ingest(envelope);
    const snapshot = await coordinator.getSnapshot();

    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
    expect(snapshot.event_count).toBe(1);
    expect(snapshot.cluster_count).toBe(1);
    expect(snapshot.pending).toBe(true);
    expect(storage.alarm).not.toBeNull();
  });

  it("fires a passive memory workflow when tool-failure threshold is hit", async () => {
    const { coordinator, env } = createCoordinator();
    await coordinator.ingest(makeEnvelope({ id: "a", signature: "sig-1", session_id: "sess-1" }));
    await coordinator.ingest(makeEnvelope({ id: "b", signature: "sig-1", session_id: "sess-2", created_at_ms: NOW + 1 }));
    await coordinator.ingest(makeEnvelope({ id: "c", signature: "sig-1", session_id: "sess-3", created_at_ms: NOW + 2 }));

    const result = await coordinator.evaluateNow();
    const snapshot = await coordinator.getSnapshot();
    const create = env.AGENT_RUN_WORKFLOW.create as any;

    expect(result.fired).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].params.input).toContain("/memory-digest");
    expect(create.mock.calls[0][0].params.input).toContain("signal_briefing=");
    expect(create.mock.calls[0][0].params.input).toContain('signal_session_ids="sess-3,sess-2,sess-1"');
    expect(create.mock.calls[0][0].params.input).toContain('signal_entities="Stripe"');
    expect(snapshot.workflow_fire_count).toBe(1);
    expect(snapshot.cooldown_count).toBe(1);
    expect(snapshot.pending).toBe(false);
  });

  it("suppresses duplicate workflow launches while cooldown is active", async () => {
    const { coordinator, env } = createCoordinator();
    await coordinator.ingest(makeEnvelope({ id: "a", signature: "sig-dup", session_id: "sess-1" }));
    await coordinator.ingest(makeEnvelope({ id: "b", signature: "sig-dup", session_id: "sess-2", created_at_ms: NOW + 1 }));
    await coordinator.ingest(makeEnvelope({ id: "c", signature: "sig-dup", session_id: "sess-3", created_at_ms: NOW + 2 }));

    await coordinator.evaluateNow();
    const second = await coordinator.evaluateNow();
    const create = env.AGENT_RUN_WORKFLOW.create as any;

    expect(second.suppressed).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("drives a passive digest end to end from raw runtime telemetry", async () => {
    const { coordinator, env } = createCoordinator();
    const rawEvents = [
      {
        type: "runtime_event",
        payload: {
          org_id: "org-1",
          agent_name: "personal-agent",
          session_id: "sess-a",
          event_type: "tool_exec",
          status: "error",
          node_id: "browser-open",
          details: { tool: "browser-open", url: "https://acme.dev/incidents/billing-bug" },
          created_at: NOW,
        },
      },
      {
        type: "runtime_event",
        payload: {
          org_id: "org-1",
          agent_name: "personal-agent",
          session_id: "sess-b",
          event_type: "tool_exec",
          status: "error",
          node_id: "browser-open",
          details: { tool: "browser-open", url: "https://acme.dev/incidents/billing-bug" },
          created_at: NOW + 1,
        },
      },
      {
        type: "runtime_event",
        payload: {
          org_id: "org-1",
          agent_name: "personal-agent",
          session_id: "sess-c",
          event_type: "tool_exec",
          status: "error",
          node_id: "browser-open",
          details: { tool: "browser-open", url: "https://acme.dev/incidents/billing-bug" },
          created_at: NOW + 2,
        },
      },
    ];

    const queueMessages = rawEvents.flatMap((entry) =>
      deriveSignalEnvelopes(entry.type, entry.payload).map(signalEnvelopeMessage),
    );

    expect(buildSignalCoordinatorKey("memory", "org-1", "personal-agent")).toBe("org-1:personal-agent:memory");
    for (const message of queueMessages) {
      await coordinator.ingest(message.payload);
    }

    const result = await coordinator.evaluateNow();
    const create = env.AGENT_RUN_WORKFLOW.create as any;

    expect(result.fired).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].params.input).toContain("/memory-digest");
    expect(create.mock.calls[0][0].params.input).toContain("signal_briefing=");
    expect(create.mock.calls[0][0].params.input).toContain('signal_session_ids="sess-c,sess-b,sess-a"');
    expect(create.mock.calls[0][0].params.input).toContain('signal_type="tool_failure"');
    // Topic normalization extracts key tokens — verify meaningful parts are present
    const workflowInput = create.mock.calls[0][0].params.input;
    expect(workflowInput).toContain("signal_topic=");
    expect(workflowInput).toContain("acme");
    expect(workflowInput).toContain("incidents");
    expect(workflowInput).toContain("billing");
  });

  it("drives a passive consolidate trigger from repeated loop telemetry", async () => {
    const { coordinator, env } = createCoordinator();
    const loopSignals = [
      {
        org_id: "org-1",
        agent_name: "personal-agent",
        session_id: "sess-loop-1",
        tool: "memory-recall",
        repeat_count: 4,
        turn: 6,
        created_at: NOW,
      },
      {
        org_id: "org-1",
        agent_name: "personal-agent",
        session_id: "sess-loop-2",
        tool: "memory-recall",
        repeat_count: 5,
        turn: 7,
        created_at: NOW + 1,
      },
    ].flatMap((payload) => deriveSignalEnvelopes("loop_detected", payload));

    for (const envelope of loopSignals) {
      await coordinator.ingest(envelope);
    }

    const result = await coordinator.evaluateNow();
    const create = env.AGENT_RUN_WORKFLOW.create as any;

    expect(result.fired).toBe(1);
    expect(create.mock.calls[0][0].params.input).toContain("/memory-consolidate");
    expect(create.mock.calls[0][0].params.input).toContain("signal_briefing=");
    expect(create.mock.calls[0][0].params.input).toContain('signal_session_ids="sess-loop-2,sess-loop-1"');
    expect(create.mock.calls[0][0].params.input).toContain('signal_type="loop_detected"');
  });
});
