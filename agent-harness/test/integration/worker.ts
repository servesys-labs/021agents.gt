/**
 * Test worker — defines test agent classes that extend production ChatAgent
 * with public inspection methods for integration testing.
 *
 * Each test agent adds getters to inspect internal state (signals, overlays,
 * budget, connectors) that are normally private in production.
 *
 * Pattern from Cloudflare Agents SDK: tests/worker.ts
 */

import { Agent } from "agents";
// Note: Think extends Agent but requires experimental compatibility flags
// and the full @cloudflare/think package resolution chain. For integration
// tests that only need SQLite and RPC, we extend Agent directly.
// Think-specific tests (chat, sessions, compaction) need the full
// agent-harness wrangler config and are e2e tests, not unit integration.

// ── Test Chat Agent — basic DO with SQLite inspection ──

export class TestChatAgent extends Agent<Env, {}> {
  private _requestCount = 0;

  async onRequest(request: Request): Promise<Response> {
    this._requestCount++;
    return Response.json({ ok: true, requests: this._requestCount });
  }

  async getRequestCount() {
    return this._requestCount;
  }

  async getSqlTableList() {
    const rows = this.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `;
    return rows.map((r: any) => r.name);
  }
}

// ── Test Signal Agent — tests signal recording and clustering ──

export class TestSignalAgent extends Agent<Env, {}> {
  private _signalTableReady = false;

  private _ensureSignalTable() {
    if (this._signalTableReady) return;
    this._signalTableReady = true;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_type TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT '',
        severity INTEGER NOT NULL DEFAULT 1,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_signal_clusters (
        signal_type TEXT NOT NULL,
        topic TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        last_fired_at TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (signal_type, topic)
      )
    `;
  }

  async recordTestSignal(type: string, topic: string, severity: number) {
    this._ensureSignalTable();
    this.sql`
      INSERT INTO cf_agent_signals (signal_type, topic, severity)
      VALUES (${type}, ${topic}, ${severity})
    `;
    this.sql`
      INSERT INTO cf_agent_signal_clusters (signal_type, topic, count, updated_at)
      VALUES (${type}, ${topic}, 1, datetime('now'))
      ON CONFLICT(signal_type, topic) DO UPDATE SET
        count = cf_agent_signal_clusters.count + 1,
        updated_at = datetime('now')
    `;
  }

  async getSignals() {
    this._ensureSignalTable();
    return this.sql<{ signal_type: string; topic: string; severity: number }>`
      SELECT signal_type, topic, severity FROM cf_agent_signals ORDER BY id
    `;
  }

  async getClusters() {
    this._ensureSignalTable();
    return this.sql<{ signal_type: string; topic: string; count: number }>`
      SELECT signal_type, topic, count FROM cf_agent_signal_clusters
    `;
  }

  async getClusterCount(type: string, topic: string): Promise<number> {
    this._ensureSignalTable();
    const [row] = this.sql<{ count: number }>`
      SELECT count FROM cf_agent_signal_clusters
      WHERE signal_type = ${type} AND topic = ${topic}
    `;
    return row?.count || 0;
  }
}

// ── Test Skill Agent — tests overlay CRUD and audit ──

export class TestSkillAgent extends Agent<Env, {}> {
  private _skillTablesReady = false;

  private _ensureSkillTables() {
    if (this._skillTablesReady) return;
    this._skillTablesReady = true;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_skill_overlays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name TEXT NOT NULL,
        rule_text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'human',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_skill_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name TEXT NOT NULL,
        overlay_id INTEGER,
        action TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT,
        reason TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'human',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `;
  }

  async appendOverlay(skillName: string, ruleText: string, source = "human") {
    this._ensureSkillTables();
    this.sql`
      INSERT INTO cf_agent_skill_overlays (skill_name, rule_text, source)
      VALUES (${skillName}, ${ruleText}, ${source})
    `;
    const [last] = this.sql<{ id: number }>`SELECT last_insert_rowid() as id`;
    this.sql`
      INSERT INTO cf_agent_skill_audit (skill_name, overlay_id, action, reason, source)
      VALUES (${skillName}, ${last?.id || 0}, 'append', 'test', ${source})
    `;
    return last?.id || 0;
  }

  async getOverlays(skillName: string) {
    this._ensureSkillTables();
    return this.sql<{ id: number; rule_text: string; source: string }>`
      SELECT id, rule_text, source FROM cf_agent_skill_overlays
      WHERE skill_name = ${skillName} ORDER BY created_at ASC
    `;
  }

  async getAuditLog(skillName: string) {
    this._ensureSkillTables();
    return this.sql<{ action: string; source: string }>`
      SELECT action, source FROM cf_agent_skill_audit
      WHERE skill_name = ${skillName} ORDER BY created_at ASC
    `;
  }

  async revertLastOverlay(skillName: string) {
    this._ensureSkillTables();
    const [last] = this.sql<{ id: number }>`
      SELECT id FROM cf_agent_skill_overlays
      WHERE skill_name = ${skillName} ORDER BY id DESC LIMIT 1
    `;
    if (!last) return false;
    this.sql`DELETE FROM cf_agent_skill_overlays WHERE id = ${last.id}`;
    this.sql`
      INSERT INTO cf_agent_skill_audit (skill_name, overlay_id, action, reason, source)
      VALUES (${skillName}, ${last.id}, 'revert', 'test revert', 'human')
    `;
    return true;
  }
}

// ── Test Budget Agent — tests cost persistence across "hibernation" ──

export class TestBudgetAgent extends Agent<Env, {}> {
  private _costTableReady = false;

  private _ensureCostTable() {
    if (this._costTableReady) return;
    this._costTableReady = true;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_session_cost (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        total_cost_usd REAL NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `;
    this.sql`INSERT OR IGNORE INTO cf_agent_session_cost (id, total_cost_usd) VALUES (1, 0)`;
  }

  async addCost(amount: number) {
    this._ensureCostTable();
    this.sql`
      UPDATE cf_agent_session_cost SET total_cost_usd = total_cost_usd + ${amount}, updated_at = datetime('now') WHERE id = 1
    `;
  }

  async getCost(): Promise<number> {
    this._ensureCostTable();
    const [row] = this.sql<{ total_cost_usd: number }>`
      SELECT total_cost_usd FROM cf_agent_session_cost WHERE id = 1
    `;
    return row?.total_cost_usd || 0;
  }

  async resetCost() {
    this._ensureCostTable();
    this.sql`UPDATE cf_agent_session_cost SET total_cost_usd = 0 WHERE id = 1`;
  }
}

// ── Worker entry point ──

export type Env = {
  AI: any;
  TestChatAgent: DurableObjectNamespace<TestChatAgent>;
  TestSignalAgent: DurableObjectNamespace<TestSignalAgent>;
  TestSkillAgent: DurableObjectNamespace<TestSkillAgent>;
  TestBudgetAgent: DurableObjectNamespace<TestBudgetAgent>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return new Response("Test worker", { status: 200 });
  },
};
