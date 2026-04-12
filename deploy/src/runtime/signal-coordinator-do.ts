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

export class SignalCoordinatorDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
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
          count = count + 1,
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
    const feature = this.detectFeature(sql);
    const pack = getSignalRulePack(feature);
    if (!pack) {
      await this.clearPending(sql, now);
      return { fired: 0, suppressed: 0, clusters: 0 };
    }

    const clusters = this.loadClustersForFeature(feature, sql, now);
    const cooldowns = new Set(this.loadActiveCooldowns(sql, now));
    const actions = pack.evaluate({ nowMs: now, clusters, activeCooldowns: cooldowns });
    let fired = 0;
    let suppressed = 0;

    for (const action of actions) {
      const lastSessionId = this.lookupLastSessionForSignature(sql, action.signature);
      const evidence = this.loadWorkflowEvidence(sql, action.signature, {
        signalBriefing: action.briefing,
        signalType: clusters.find((cluster) => cluster.signature === action.signature)?.signal_type || "topic_recurrence",
        signalTopic: action.topic,
      });
      if (cooldowns.has(action.dedupe_key)) {
        suppressed++;
        this.emitSignalRuntimeEvent("signal_cooldown_suppressed", {
          feature: "memory",
          signal_type: "topic_recurrence",
          source_type: "runtime_event",
          org_id: this.extractOrgId(sql),
          agent_name: this.extractAgentName(sql),
          session_id: lastSessionId,
          created_at_ms: now,
          signature: action.signature,
          topic: action.topic,
          summary: action.summary,
          severity: 0,
          entities: [],
          metadata: {},
        }, {
          workflow_kind: action.workflow_kind,
          dedupe_key: action.dedupe_key,
        });
        continue;
      }

      const fireId = buildWorkflowFireId(action.signature, action.workflow_kind, now, action.cooldown_ms);
      const inserted = this.exec(sql, `
        INSERT OR IGNORE INTO workflow_fires(
          fire_id, feature, signature, workflow_kind, workflow_instance_id,
          fired_at_ms, org_id, agent_name, signal_briefing
        ) VALUES (?, 'memory', ?, ?, '', ?, ?, ?, ?)
      `, [
        fireId,
        action.signature,
        action.workflow_kind,
        now,
        this.extractOrgId(sql),
        this.extractAgentName(sql),
        action.briefing,
      ]);
      if (inserted.changes === 0) {
        suppressed++;
        continue;
      }

      const params = buildPassiveMemoryWorkflowParams(
        action.workflow_kind,
        this.extractAgentName(sql),
        lastSessionId,
        this.extractOrgId(sql),
        0,
        Boolean(this.env.AGENT_RUN_WORKFLOW),
        evidence,
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
        this.exec(sql, `DELETE FROM workflow_fires WHERE fire_id = ?`, [fireId]);
        throw error;
      }

      this.exec(sql, `
        UPDATE workflow_fires
        SET workflow_instance_id = ?
        WHERE fire_id = ?
      `, [workflowId, fireId]);

      this.exec(sql, `
        INSERT INTO signal_cooldowns(feature, dedupe_key, until_ms, last_fire_id, updated_at_ms)
        VALUES('memory', ?, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          until_ms = excluded.until_ms,
          last_fire_id = excluded.last_fire_id,
          updated_at_ms = excluded.updated_at_ms
      `, [action.dedupe_key, now + action.cooldown_ms, fireId, now]);

      fired++;
      this.emitSignalRuntimeEvent("signal_threshold_hit", {
        feature: "memory",
        signal_type: clusters.find((cluster) => cluster.signature === action.signature)?.signal_type || "topic_recurrence",
        source_type: "runtime_event",
        org_id: this.extractOrgId(sql),
        agent_name: this.extractAgentName(sql),
        session_id: lastSessionId,
        created_at_ms: now,
        signature: action.signature,
        topic: action.topic,
        summary: action.summary,
        severity: 1,
        entities: [],
        metadata: {},
      }, {
        workflow_kind: action.workflow_kind,
        briefing: action.briefing,
      });
      this.emitSignalRuntimeEvent("signal_workflow_fired", {
        feature: "memory",
        signal_type: clusters.find((cluster) => cluster.signature === action.signature)?.signal_type || "topic_recurrence",
        source_type: "runtime_event",
        org_id: this.extractOrgId(sql),
        agent_name: this.extractAgentName(sql),
        session_id: lastSessionId,
        created_at_ms: now,
        signature: action.signature,
        topic: action.topic,
        summary: action.summary,
        severity: 1,
        entities: [],
        metadata: {},
      }, {
        workflow_kind: action.workflow_kind,
        fire_id: fireId,
        workflow_id: workflowId,
      });
      this.writeAnalytics("workflow_fired", {
        feature: "memory",
        signal_type: clusters.find((cluster) => cluster.signature === action.signature)?.signal_type || "topic_recurrence",
        source_type: "runtime_event",
        org_id: this.extractOrgId(sql),
        agent_name: this.extractAgentName(sql),
        session_id: lastSessionId,
        created_at_ms: now,
        signature: action.signature,
        topic: action.topic,
        summary: action.summary,
        severity: 1,
        entities: [],
        metadata: { workflow_kind: action.workflow_kind },
      }, 1);
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
    const feature = this.detectFeature(sql);
    return this.loadClustersForFeature(feature, sql, Date.now());
  }

  async reconcile(): Promise<{ pruned_events: number; pruned_fires: number; pruned_cooldowns: number }> {
    const sql = this.sql();
    const now = Date.now();
    const prunedEvents = this.exec(sql, `DELETE FROM signal_events WHERE created_at_ms < ?`, [now - EVENT_RETENTION_MS]).changes;
    const prunedFires = this.exec(sql, `DELETE FROM workflow_fires WHERE fired_at_ms < ?`, [now - FIRE_RETENTION_MS]).changes;
    const prunedCooldowns = this.exec(sql, `DELETE FROM signal_cooldowns WHERE until_ms < ?`, [now]).changes;
    return {
      pruned_events: prunedEvents,
      pruned_fires: prunedFires,
      pruned_cooldowns: prunedCooldowns,
    };
  }

  async alarm(): Promise<void> {
    await this.evaluateNow();
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
    const rows = this.rows<ClusterRow>(sql, `
      SELECT feature, signature, signal_type, topic, count, first_seen_ms, last_seen_ms,
             max_severity, last_session_id, sample_summary, entities_json
      FROM signal_clusters
      WHERE feature = 'memory' AND last_seen_ms >= ?
      ORDER BY last_seen_ms DESC
    `, [now - EVENT_RETENTION_MS]);
    return rows.map((row) => {
      const sessionCount = this.scalar(sql, `
        SELECT COUNT(DISTINCT session_id) AS value
        FROM signal_events
        WHERE signature = ? AND created_at_ms >= ?
      `, [row.signature, now - EVENT_RETENTION_MS]);
      const sampleRows = this.rows<{ summary: string }>(sql, `
        SELECT summary
        FROM signal_events
        WHERE signature = ?
        ORDER BY created_at_ms DESC
        LIMIT 3
      `, [row.signature]);
      return {
        feature: "memory",
        signature: row.signature,
        signal_type: row.signal_type,
        topic: row.topic,
        count: row.count,
        distinct_sessions: sessionCount,
        first_seen_ms: row.first_seen_ms,
        last_seen_ms: row.last_seen_ms,
        max_severity: row.max_severity,
        sample_summaries: sampleRows.map((sample) => sample.summary),
        entities: parseStringArray(row.entities_json),
      };
    });
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

  private detectFeature(sql: any): SignalFeature | null {
    const row = this.first<{ feature: SignalFeature }>(sql, `
      SELECT feature
      FROM signal_clusters
      ORDER BY last_seen_ms DESC
      LIMIT 1
    `) || this.first<{ feature: SignalFeature }>(sql, `
      SELECT feature
      FROM signal_events
      ORDER BY created_at_ms DESC
      LIMIT 1
    `);
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

  private extractOrgId(sql: any): string {
    const row = this.first<{ metadata_json: string }>(sql, `
      SELECT metadata_json
      FROM signal_events
      ORDER BY created_at_ms DESC
      LIMIT 1
    `);
    if (!row?.metadata_json) return "";
    try {
      return String(JSON.parse(row.metadata_json)?.org_id || "");
    } catch {
      return "";
    }
  }

  private extractAgentName(sql: any): string {
    const row = this.first<{ metadata_json: string }>(sql, `
      SELECT metadata_json
      FROM signal_events
      ORDER BY created_at_ms DESC
      LIMIT 1
    `);
    if (!row?.metadata_json) return "";
    try {
      return String(JSON.parse(row.metadata_json)?.agent_name || "");
    } catch {
      return "";
    }
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
