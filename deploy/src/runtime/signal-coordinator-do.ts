import { createHash } from "node:crypto";

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";

import {
  buildPassiveMemoryWorkflowParams,
  type PassiveSignalWorkflowEvidence,
} from "./memory-digest";
import type { MemorySignalCluster } from "./signal-rules-memory";
import { getSignalRulePack, type SignalCluster } from "./signal-rule-packs";
import type { SignalEnvelope, SignalFeature } from "./signals";

const EVENT_RETENTION_MS = 7 * 24 * 3_600_000;
const FIRE_RETENTION_MS = 14 * 24 * 3_600_000;
const COALESCE_DELAY_MS = 45_000;

type SignalEnvelopeRecord = Omit<SignalEnvelope, "id">;

interface ClusterRow {
  feature: SignalFeature;
  signature: string;
  signal_type: SignalEnvelope["signal_type"];
  topic: string;
  count: number;
  first_seen_ms: number;
  last_seen_ms: number;
  max_severity: number;
  last_session_id: string;
  sample_summary: string;
  entities_json: string;
}

export interface SignalCoordinatorSnapshot {
  pending: boolean;
  cluster_count: number;
  event_count: number;
  cooldown_count: number;
  workflow_fire_count: number;
  clusters: Array<{
    signature: string;
    signal_type: string;
    topic: string;
    count: number;
    last_seen_ms: number;
  }>;
}

/** Max concurrent workflow fires per evaluation pass to prevent burst overload. */
const MAX_WORKFLOW_FIRES_PER_EVAL = 3;

export class SignalCoordinatorDO extends DurableObject<Env> {
  /** Cached from the DO name (orgId:agentName:feature). Avoids repeated JSON parsing. */
  private _cachedOrgId: string | null = null;
  private _cachedAgentName: string | null = null;
  private _cachedFeature: SignalFeature | null = null;

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    // DO name is "orgId:agentName:feature" — extract once in constructor
    const doName = String((ctx as any).id?.name || "");
    const parts = doName.split(":");
    if (parts.length >= 3) {
      this._cachedOrgId = parts[0] === "global" ? "" : parts[0];
      this._cachedAgentName = parts[1] === "agentos" ? "" : parts[1];
      this._cachedFeature = parts[2] as SignalFeature;
    }
    this.ctx.blockConcurrencyWhile(async () => {
      await this.ensureSchema();
    });
  }

  async ingest(envelope: SignalEnvelope): Promise<{ stored: boolean; scheduled: boolean }> {
    const sql = this.sql();
    const stored = this.exec(sql, `
      INSERT OR IGNORE INTO signal_events (
        id, feature, signal_type, session_id, created_at_ms, signature, topic,
        severity, summary, entities_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      envelope.id,
      envelope.feature,
      envelope.signal_type,
      envelope.session_id || "",
      envelope.created_at_ms,
      envelope.signature,
      envelope.topic || "",
      envelope.severity || 0,
      envelope.summary || "",
      JSON.stringify(envelope.entities || []),
      JSON.stringify({
        ...envelope.metadata,
        source_type: envelope.source_type,
        org_id: envelope.org_id,
        agent_name: envelope.agent_name,
      }),
    ]);

    if (stored.changes > 0) {
      this.exec(sql, `
        INSERT INTO signal_clusters (
          feature, signature, signal_type, topic, count, first_seen_ms, last_seen_ms,
          max_severity, last_session_id, sample_summary, entities_json
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(signature) DO UPDATE SET
          count = signal_clusters.count + 1,
          last_seen_ms = excluded.last_seen_ms,
          topic = CASE
            WHEN length(excluded.topic) > length(signal_clusters.topic) THEN excluded.topic
            ELSE signal_clusters.topic
          END,
          max_severity = MAX(signal_clusters.max_severity, excluded.max_severity),
          last_session_id = excluded.last_session_id,
          sample_summary = CASE
            WHEN signal_clusters.sample_summary = '' THEN excluded.sample_summary
            ELSE signal_clusters.sample_summary
          END,
          entities_json = CASE
            WHEN signal_clusters.entities_json = '[]' THEN excluded.entities_json
            ELSE signal_clusters.entities_json
          END
      `, [
        envelope.feature,
        envelope.signature,
        envelope.signal_type,
        envelope.topic || "",
        envelope.created_at_ms,
        envelope.created_at_ms,
        envelope.severity || 0,
        envelope.session_id || "",
        envelope.summary || "",
        JSON.stringify(envelope.entities || []),
      ]);
    }

    const scheduled = await this.scheduleEvaluation("ingest");
    this.emitSignalRuntimeEvent("signal_buffered", envelope, {
      signal_type: envelope.signal_type,
      signature: envelope.signature,
    });
    this.writeAnalytics("buffered", envelope, 1);
    return { stored: stored.changes > 0, scheduled };
  }

  async scheduleEvaluation(reason: string): Promise<boolean> {
    const sql = this.sql();
    const now = Date.now();
    this.exec(sql, `
      INSERT INTO signal_state(key, value_text, updated_at_ms)
      VALUES('pending_reason', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_text = excluded.value_text, updated_at_ms = excluded.updated_at_ms
    `, [reason, now]);
    this.exec(sql, `
      INSERT INTO signal_state(key, value_text, updated_at_ms)
      VALUES('pending', '1', ?)
      ON CONFLICT(key) DO UPDATE SET value_text = '1', updated_at_ms = excluded.updated_at_ms
    `, [now]);

    const storage: any = this.ctx.storage;
    const existingAlarm = typeof storage.getAlarm === "function" ? await storage.getAlarm() : null;
    const target = now + COALESCE_DELAY_MS;
    if (!existingAlarm || existingAlarm > target) {
      await storage.setAlarm(target);
      return true;
    }
    return false;
  }

  async evaluateNow(): Promise<{ fired: number; suppressed: number; clusters: number }> {
    const sql = this.sql();
    const now = Date.now();
    const feature = this.resolveFeature(sql);
    const pack = getSignalRulePack(feature);
    if (!pack) {
      await this.clearPending(sql, now);
      return { fired: 0, suppressed: 0, clusters: 0 };
    }

    // Cache org/agent once per evaluation — avoids repeated JSON parsing
    const orgId = this.resolveOrgId(sql);
    const agentName = this.resolveAgentName(sql);

    const clusters = this.loadClustersForFeature(feature, sql, now);
    const cooldowns = new Set(this.loadActiveCooldowns(sql, now));
    const actions = pack.evaluate({ nowMs: now, clusters, activeCooldowns: cooldowns });
    let fired = 0;
    let suppressed = 0;

    for (const action of actions) {
      // Backpressure: cap concurrent workflow fires per evaluation pass
      if (fired >= MAX_WORKFLOW_FIRES_PER_EVAL) {
        suppressed += actions.length - (fired + suppressed);
        break;
      }

      const clusterSignalType = clusters.find((c) => c.signature === action.signature)?.signal_type || "topic_recurrence";
      const lastSessionId = this.lookupLastSessionForSignature(sql, action.signature);

      const makeEnvelope = (severity: number): SignalEnvelopeRecord => ({
        feature: "memory",
        signal_type: clusterSignalType,
        source_type: "runtime_event",
        org_id: orgId,
        agent_name: agentName,
        session_id: lastSessionId,
        created_at_ms: now,
        signature: action.signature,
        topic: action.topic,
        summary: action.summary,
        severity,
        entities: [],
        metadata: {},
      });

      if (cooldowns.has(action.dedupe_key)) {
        suppressed++;
        this.emitSignalRuntimeEvent("signal_cooldown_suppressed", makeEnvelope(0), {
          workflow_kind: action.workflow_kind,
          dedupe_key: action.dedupe_key,
        });
        continue;
      }

      const evidence = this.loadWorkflowEvidence(sql, action.signature, {
        signalBriefing: action.briefing,
        signalType: clusterSignalType,
        signalTopic: action.topic,
      });

      const fireId = buildWorkflowFireId(action.signature, action.workflow_kind, now, action.cooldown_ms);
      const inserted = this.exec(sql, `
        INSERT OR IGNORE INTO workflow_fires(
          fire_id, feature, signature, workflow_kind, workflow_instance_id,
          fired_at_ms, org_id, agent_name, signal_briefing
        ) VALUES (?, 'memory', ?, ?, '', ?, ?, ?, ?)
      `, [fireId, action.signature, action.workflow_kind, now, orgId, agentName, action.briefing]);
      if (inserted.changes === 0) {
        suppressed++;
        continue;
      }

      const params = buildPassiveMemoryWorkflowParams(
        action.workflow_kind, agentName, lastSessionId, orgId, 0,
        Boolean(this.env.AGENT_RUN_WORKFLOW), evidence,
      );
      if (!params) {
        this.exec(sql, `DELETE FROM workflow_fires WHERE fire_id = ?`, [fireId]);
        suppressed++;
        continue;
      }

      let workflowId = "";
      try {
        const instance = await this.env.AGENT_RUN_WORKFLOW.create({ params });
        workflowId = String((instance as any)?.id || (instance as any)?.workflowId || "");
      } catch (error: any) {
        // Clean up the fire record but continue evaluating remaining actions
        // instead of aborting the entire evaluation pass.
        this.exec(sql, `DELETE FROM workflow_fires WHERE fire_id = ?`, [fireId]);
        console.error(`[signal-coordinator] workflow create failed for ${action.workflow_kind}:${action.signature}:`, error?.message || error);
        suppressed++;
        continue;
      }

      this.exec(sql, `UPDATE workflow_fires SET workflow_instance_id = ? WHERE fire_id = ?`, [workflowId, fireId]);
      this.exec(sql, `
        INSERT INTO signal_cooldowns(feature, dedupe_key, until_ms, last_fire_id, updated_at_ms)
        VALUES('memory', ?, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          until_ms = excluded.until_ms, last_fire_id = excluded.last_fire_id, updated_at_ms = excluded.updated_at_ms
      `, [action.dedupe_key, now + action.cooldown_ms, fireId, now]);

      fired++;
      this.emitSignalRuntimeEvent("signal_threshold_hit", makeEnvelope(1), {
        workflow_kind: action.workflow_kind, briefing: action.briefing,
      });
      this.emitSignalRuntimeEvent("signal_workflow_fired", makeEnvelope(1), {
        workflow_kind: action.workflow_kind, fire_id: fireId, workflow_id: workflowId,
      });
      this.writeAnalytics("workflow_fired", makeEnvelope(1), 1);
    }

    await this.clearPending(sql, now);
    await this.reconcile();
    const storage: any = this.ctx.storage;
    if (typeof storage.deleteAlarm === "function") await storage.deleteAlarm();
    return { fired, suppressed, clusters: clusters.length };
  }

  async getSnapshot(): Promise<SignalCoordinatorSnapshot> {
    const sql = this.sql();
    const pendingRow = this.first<{ value_text: string }>(sql, `SELECT value_text FROM signal_state WHERE key = 'pending'`);
    const clusterCount = this.scalar(sql, `SELECT COUNT(*) AS value FROM signal_clusters`);
    const eventCount = this.scalar(sql, `SELECT COUNT(*) AS value FROM signal_events`);
    const cooldownCount = this.scalar(sql, `SELECT COUNT(*) AS value FROM signal_cooldowns WHERE until_ms > ?`, [Date.now()]);
    const fireCount = this.scalar(sql, `SELECT COUNT(*) AS value FROM workflow_fires`);
    const clusters = this.rows<ClusterRow>(sql, `
      SELECT feature, signature, signal_type, topic, count, first_seen_ms, last_seen_ms,
             max_severity, last_session_id, sample_summary, entities_json
      FROM signal_clusters
      ORDER BY last_seen_ms DESC
      LIMIT 20
    `);
    return {
      pending: pendingRow?.value_text === "1",
      cluster_count: clusterCount,
      event_count: eventCount,
      cooldown_count: cooldownCount,
      workflow_fire_count: fireCount,
      clusters: clusters.map((row) => ({
        signature: row.signature,
        signal_type: row.signal_type,
        topic: row.topic,
        count: row.count,
        last_seen_ms: row.last_seen_ms,
      })),
    };
  }

  async listClusters(): Promise<SignalCluster[]> {
    const sql = this.sql();
    const feature = this.resolveFeature(sql);
    return this.loadClustersForFeature(feature, sql, Date.now());
  }

  async reconcile(): Promise<{ pruned_events: number; pruned_fires: number; pruned_cooldowns: number; pruned_clusters: number }> {
    const sql = this.sql();
    const now = Date.now();
    const prunedEvents = this.exec(sql, `DELETE FROM signal_events WHERE created_at_ms < ?`, [now - EVENT_RETENTION_MS]).changes;
    const prunedFires = this.exec(sql, `DELETE FROM workflow_fires WHERE fired_at_ms < ?`, [now - FIRE_RETENTION_MS]).changes;
    const prunedCooldowns = this.exec(sql, `DELETE FROM signal_cooldowns WHERE until_ms < ?`, [now]).changes;

    // Recompute cluster counts from surviving events to prevent ghost inflation.
    // Clusters with zero remaining events are deleted entirely.
    this.exec(sql, `
      UPDATE signal_clusters SET count = (
        SELECT COUNT(*) FROM signal_events WHERE signal_events.signature = signal_clusters.signature
      )
    `);
    const prunedClusters = this.exec(sql, `DELETE FROM signal_clusters WHERE count = 0`).changes;

    return {
      pruned_events: prunedEvents,
      pruned_fires: prunedFires,
      pruned_cooldowns: prunedCooldowns,
      pruned_clusters: prunedClusters,
    };
  }

  async alarm(): Promise<void> {
    try {
      await this.evaluateNow();
    } catch (err) {
      // Log but don't re-throw — prevents infinite alarm retries on persistent failures.
      // The next ingest() will schedule a fresh alarm.
      console.error("[signal-coordinator] alarm evaluation failed:", err);
    }
  }

  private async ensureSchema(): Promise<void> {
    const sql = this.sql();
    this.exec(sql, `
      CREATE TABLE IF NOT EXISTS signal_events (
        id TEXT PRIMARY KEY,
        feature TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        signature TEXT NOT NULL,
        topic TEXT NOT NULL,
        severity REAL NOT NULL,
        summary TEXT NOT NULL,
        entities_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      )
    `);
    this.exec(sql, `CREATE INDEX IF NOT EXISTS idx_signal_events_signature ON signal_events(signature, created_at_ms DESC)`);
    this.exec(sql, `
      CREATE TABLE IF NOT EXISTS signal_clusters (
        feature TEXT NOT NULL,
        signature TEXT PRIMARY KEY,
        signal_type TEXT NOT NULL,
        topic TEXT NOT NULL,
        count INTEGER NOT NULL,
        first_seen_ms INTEGER NOT NULL,
        last_seen_ms INTEGER NOT NULL,
        max_severity REAL NOT NULL,
        last_session_id TEXT NOT NULL,
        sample_summary TEXT NOT NULL,
        entities_json TEXT NOT NULL
      )
    `);
    this.exec(sql, `
      CREATE TABLE IF NOT EXISTS signal_cooldowns (
        feature TEXT NOT NULL,
        dedupe_key TEXT PRIMARY KEY,
        until_ms INTEGER NOT NULL,
        last_fire_id TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    this.exec(sql, `
      CREATE TABLE IF NOT EXISTS workflow_fires (
        fire_id TEXT PRIMARY KEY,
        feature TEXT NOT NULL,
        signature TEXT NOT NULL,
        workflow_kind TEXT NOT NULL,
        workflow_instance_id TEXT NOT NULL,
        fired_at_ms INTEGER NOT NULL,
        org_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        signal_briefing TEXT NOT NULL
      )
    `);
    this.exec(sql, `
      CREATE TABLE IF NOT EXISTS signal_state (
        key TEXT PRIMARY KEY,
        value_text TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
  }

  private loadMemoryClusters(sql: any, now: number): MemorySignalCluster[] {
    const cutoff = now - EVENT_RETENTION_MS;
    // Single query with correlated subqueries — replaces N+1 pattern (was 2 extra queries per cluster)
    const rows = this.rows<ClusterRow & { distinct_sessions: number; recent_summaries: string }>(sql, `
      SELECT
        c.feature, c.signature, c.signal_type, c.topic, c.count,
        c.first_seen_ms, c.last_seen_ms, c.max_severity,
        c.last_session_id, c.sample_summary, c.entities_json,
        COALESCE((
          SELECT COUNT(DISTINCT e.session_id)
          FROM signal_events e
          WHERE e.signature = c.signature AND e.created_at_ms >= ?
        ), 0) AS distinct_sessions,
        COALESCE((
          SELECT GROUP_CONCAT(sub.summary, '|||')
          FROM (
            SELECT summary FROM signal_events
            WHERE signature = c.signature
            ORDER BY created_at_ms DESC LIMIT 3
          ) sub
        ), '') AS recent_summaries
      FROM signal_clusters c
      WHERE c.feature = 'memory' AND c.last_seen_ms >= ?
      ORDER BY c.last_seen_ms DESC
    `, [cutoff, cutoff]);

    return rows.map((row) => ({
      feature: "memory" as const,
      signature: row.signature,
      signal_type: row.signal_type,
      topic: row.topic,
      count: row.count,
      distinct_sessions: Number(row.distinct_sessions) || 0,
      first_seen_ms: row.first_seen_ms,
      last_seen_ms: row.last_seen_ms,
      max_severity: row.max_severity,
      sample_summaries: row.recent_summaries ? row.recent_summaries.split("|||").filter(Boolean) : [],
      entities: parseStringArray(row.entities_json),
    }));
  }

  private loadClustersForFeature(feature: SignalFeature | null, sql: any, now: number): SignalCluster[] {
    if (feature === "memory") return this.loadMemoryClusters(sql, now);
    return [];
  }

  private loadWorkflowEvidence(
    sql: any,
    signature: string,
    base: { signalBriefing: string; signalType: string; signalTopic: string },
  ): PassiveSignalWorkflowEvidence {
    const rows = this.rows<{ session_id: string; summary: string; entities_json: string }>(sql, `
      SELECT session_id, summary, entities_json
      FROM signal_events
      WHERE signature = ?
      ORDER BY created_at_ms DESC
      LIMIT 8
    `, [signature]);

    const sessionIds: string[] = [];
    const sessionSeen = new Set<string>();
    const entitySeen = new Set<string>();
    const entities: string[] = [];

    for (const row of rows) {
      const sessionId = String(row.session_id || "");
      if (sessionId && !sessionSeen.has(sessionId)) {
        sessionSeen.add(sessionId);
        sessionIds.push(sessionId);
      }
      for (const entity of parseStringArray(row.entities_json || "[]")) {
        const normalized = entity.toLowerCase();
        if (!normalized || entitySeen.has(normalized)) continue;
        entitySeen.add(normalized);
        entities.push(entity);
      }
    }

    return {
      signalBriefing: base.signalBriefing,
      signalType: base.signalType,
      signalTopic: base.signalTopic,
      signalSessionIds: sessionIds,
      signalEntities: entities,
    };
  }

  /** Resolve feature — prefer cached from DO name, fall back to DB query. */
  private resolveFeature(sql: any): SignalFeature | null {
    if (this._cachedFeature) return this._cachedFeature;
    const row = this.first<{ feature: SignalFeature }>(sql, `
      SELECT feature FROM signal_clusters ORDER BY last_seen_ms DESC LIMIT 1
    `) || this.first<{ feature: SignalFeature }>(sql, `
      SELECT feature FROM signal_events ORDER BY created_at_ms DESC LIMIT 1
    `);
    if (row?.feature) this._cachedFeature = row.feature;
    return row?.feature || null;
  }

  private async clearPending(sql: any, now: number): Promise<void> {
    this.exec(sql, `
      INSERT INTO signal_state(key, value_text, updated_at_ms)
      VALUES('pending', '0', ?)
      ON CONFLICT(key) DO UPDATE SET value_text = '0', updated_at_ms = excluded.updated_at_ms
    `, [now]);
  }

  private loadActiveCooldowns(sql: any, now: number): string[] {
    return this.rows<{ dedupe_key: string }>(sql, `
      SELECT dedupe_key
      FROM signal_cooldowns
      WHERE until_ms > ?
    `, [now]).map((row) => row.dedupe_key);
  }

  private lookupLastSessionForSignature(sql: any, signature: string): string {
    const row = this.first<{ session_id: string }>(sql, `
      SELECT session_id
      FROM signal_events
      WHERE signature = ?
      ORDER BY created_at_ms DESC
      LIMIT 1
    `, [signature]);
    return row?.session_id || "";
  }

  /** Resolve org_id — prefer cached from DO name, fall back to DB query. */
  private resolveOrgId(sql: any): string {
    if (this._cachedOrgId !== null) return this._cachedOrgId;
    const row = this.first<{ metadata_json: string }>(sql, `
      SELECT metadata_json FROM signal_events ORDER BY created_at_ms DESC LIMIT 1
    `);
    try {
      this._cachedOrgId = String(JSON.parse(row?.metadata_json || "{}")?.org_id || "");
    } catch { this._cachedOrgId = ""; }
    return this._cachedOrgId;
  }

  /** Resolve agent_name — prefer cached from DO name, fall back to DB query. */
  private resolveAgentName(sql: any): string {
    if (this._cachedAgentName !== null) return this._cachedAgentName;
    const row = this.first<{ metadata_json: string }>(sql, `
      SELECT metadata_json FROM signal_events ORDER BY created_at_ms DESC LIMIT 1
    `);
    try {
      this._cachedAgentName = String(JSON.parse(row?.metadata_json || "{}")?.agent_name || "");
    } catch { this._cachedAgentName = ""; }
    return this._cachedAgentName;
  }

  private emitSignalRuntimeEvent(
    eventType: "signal_buffered" | "signal_threshold_hit" | "signal_cooldown_suppressed" | "signal_workflow_fired",
    envelope: SignalEnvelopeRecord,
    details: Record<string, unknown>,
  ): void {
    this.env.TELEMETRY_QUEUE?.send?.({
      type: "runtime_event",
      payload: {
        event_type: eventType,
        org_id: envelope.org_id || "",
        agent_name: envelope.agent_name || "",
        session_id: envelope.session_id || "",
        node_id: "signal-coordinator",
        status: eventType === "signal_cooldown_suppressed" ? "suppressed" : "success",
        duration_ms: 0,
        created_at: Date.now(),
        details: {
          feature: envelope.feature,
          signal_type: envelope.signal_type,
          signature: envelope.signature,
          topic: envelope.topic,
          ...details,
        },
      },
    }).catch(() => {});
  }

  private writeAnalytics(kind: string, envelope: SignalEnvelopeRecord, count: number): void {
    this.env.SIGNAL_ANALYTICS?.writeDataPoint?.({
      blobs: [
        envelope.org_id || "",
        envelope.agent_name || "",
        envelope.feature,
        envelope.signal_type,
        kind,
      ],
      doubles: [count, envelope.severity || 0],
      indexes: [String(envelope.created_at_ms || Date.now())],
    });
  }

  private sql(): any {
    return (this.ctx.storage as any).sql;
  }

  private exec(sql: any, query: string, bindings: unknown[] = []): { changes: number } {
    const cursor = sql.exec(query, ...bindings);
    return { changes: Number(cursor?.rowsWritten || 0) };
  }

  private rows<T>(sql: any, query: string, bindings: unknown[] = []): T[] {
    const cursor = sql.exec(query, ...bindings);
    return [...cursor] as T[];
  }

  private first<T>(sql: any, query: string, bindings: unknown[] = []): T | null {
    const rows = this.rows<T>(sql, query, bindings);
    return rows[0] ?? null;
  }

  private scalar(sql: any, query: string, bindings: unknown[] = []): number {
    const row = this.first<{ value: number }>(sql, query, bindings);
    return Number(row?.value || 0);
  }
}

export function buildWorkflowFireId(
  signature: string,
  workflowKind: "digest" | "consolidate",
  nowMs: number,
  cooldownMs: number,
): string {
  const bucket = Math.floor(nowMs / Math.max(cooldownMs, 1));
  return createHash("sha1").update(`${signature}|${workflowKind}|${bucket}`).digest("hex");
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}
