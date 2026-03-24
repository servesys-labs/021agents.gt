/**
 * AgentOS — Cloudflare Agents Deployment (Modernized)
 *
 * Uses Cloudflare Agents SDK patterns:
 *   - @callable() methods for type-safe RPC
 *   - Dedicated MCP server agent for MCP protocol support
 *   - this.schedule() / this.queue() for job orchestration
 *   - this.sql`` for persistent state
 *   - routeAgentRequest for URL-based agent dispatch
 */

import {
  Agent,
  AgentNamespace,
  Connection,
  callable,
  routeAgentRequest,
  type StreamingResponse,
} from "agents";
import { McpAgent } from "agents/mcp";

// ---------------------------------------------------------------------------
// Environment bindings
// ---------------------------------------------------------------------------

export interface Env {
  AGENTOS_AGENT: AgentNamespace<AgentOSAgent>;
  AGENTOS_MCP: AgentNamespace<AgentOSMcpServer>;
  AI: Ai;
  ASSETS: Fetcher;
  VECTORIZE: VectorizeIndex;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GMI_API_KEY?: string;
  E2B_API_KEY?: string;
  AUTH_JWT_SECRET?: string;
  BACKEND_INGEST_URL?: string;
  BACKEND_INGEST_TOKEN?: string;
  BACKEND_PROXY_ONLY?: string;
  DEFAULT_PLAN?: string;
  DEFAULT_PROVIDER: string;
  DEFAULT_MODEL: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentState {
  config: AgentConfig;
  working: Record<string, unknown>;
  turnCount: number;
  sessionActive: boolean;
  totalCostUsd: number;
}

interface AgentConfig {
  plan: string;
  provider: string;
  model: string;
  orgId?: string;
  projectId?: string;
  maxTurns: number;
  budgetLimitUsd: number;
  blockedTools: string[];
  systemPrompt: string;
  agentName: string;
  agentDescription: string;
}

interface TurnResult {
  turn: number;
  content: string;
  toolResults: any[];
  done: boolean;
  error?: string;
  costUsd: number;
  model: string;
}

interface ObservabilityEvent {
  id: number;
  session_id: string;
  turn: number;
  event_type: string;
  action: string;
  plan: string;
  tier: string;
  provider: string;
  model: string;
  tool_name: string;
  status: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  details_json: string;
  created_at: string;
}

type ComplexityTier = "simple" | "moderate" | "complex" | "tool_call";

type PlanRoute = {
  provider: string;
  model: string;
  maxTokens: number;
};

type PlanRouting = Record<ComplexityTier, PlanRoute>;

const PLAN_ROUTES: Record<string, PlanRouting> = {
  basic: {
    simple: { provider: "gmi", model: "deepseek-ai/DeepSeek-V3.2", maxTokens: 1024 },
    moderate: { provider: "gmi", model: "Qwen/Qwen3.5-122B-A10B", maxTokens: 2048 },
    complex: { provider: "gmi", model: "Qwen/Qwen3.5-397B-A17B", maxTokens: 4096 },
    tool_call: { provider: "gmi", model: "Qwen/Qwen3.5-122B-A10B", maxTokens: 2048 },
  },
  standard: {
    simple: { provider: "gmi", model: "deepseek-ai/DeepSeek-V3.2", maxTokens: 1024 },
    moderate: { provider: "gmi", model: "anthropic/claude-haiku-4.5", maxTokens: 4096 },
    complex: { provider: "gmi", model: "anthropic/claude-sonnet-4.6", maxTokens: 8192 },
    tool_call: { provider: "gmi", model: "anthropic/claude-haiku-4.5", maxTokens: 4096 },
  },
  premium: {
    simple: { provider: "gmi", model: "anthropic/claude-haiku-4.5", maxTokens: 2048 },
    moderate: { provider: "gmi", model: "anthropic/claude-sonnet-4.6", maxTokens: 4096 },
    complex: { provider: "gmi", model: "anthropic/claude-opus-4.6", maxTokens: 8192 },
    tool_call: { provider: "gmi", model: "anthropic/claude-sonnet-4.6", maxTokens: 4096 },
  },
  code: {
    simple: { provider: "gmi", model: "deepseek-ai/DeepSeek-V3.2", maxTokens: 2048 },
    moderate: { provider: "gmi", model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", maxTokens: 8192 },
    complex: { provider: "gmi", model: "anthropic/claude-sonnet-4.6", maxTokens: 8192 },
    tool_call: { provider: "gmi", model: "Qwen/Qwen3.5-122B-A10B", maxTokens: 4096 },
  },
  dedicated: {
    simple: { provider: "gmi", model: "deepseek-ai/DeepSeek-V3.2", maxTokens: 1024 },
    moderate: { provider: "gmi", model: "Qwen/Qwen3.5-122B-A10B", maxTokens: 4096 },
    complex: { provider: "gmi", model: "Qwen/Qwen3.5-397B-A17B", maxTokens: 8192 },
    tool_call: { provider: "gmi", model: "Qwen/Qwen3.5-122B-A10B", maxTokens: 4096 },
  },
  private: {
    simple: { provider: "gmi", model: "deepseek-ai/DeepSeek-V3.2", maxTokens: 1024 },
    moderate: { provider: "gmi", model: "Qwen/Qwen3.5-122B-A10B", maxTokens: 4096 },
    complex: { provider: "gmi", model: "Qwen/Qwen3.5-397B-A17B", maxTokens: 8192 },
    tool_call: { provider: "gmi", model: "Qwen/Qwen3.5-122B-A10B", maxTokens: 4096 },
  },
};

function normalizePlan(value?: string): string {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return "standard";
  if (raw === "balanced") return "standard";
  if (raw === "manual") return "manual";
  return PLAN_ROUTES[raw] ? raw : "standard";
}

// ---------------------------------------------------------------------------
// AgentOS Agent — main agent with @callable methods
// ---------------------------------------------------------------------------

export class AgentOSAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    config: {
      plan: "standard",
      provider: "gmi",
      model: "deepseek-ai/DeepSeek-V3.2",
      orgId: "",
      projectId: "",
      maxTurns: 50,
      budgetLimitUsd: 10.0,
      blockedTools: [],
      systemPrompt: "You are a helpful AI assistant.",
      agentName: "agentos",
      agentDescription: "AgentOS Agent",
    },
    working: {},
    turnCount: 0,
    sessionActive: false,
    totalCostUsd: 0,
  };

  async onStart() {
    // Initialize SQL tables for persistent state
    this.sql`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      turns INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      model TEXT DEFAULT '',
      status TEXT DEFAULT 'completed',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments TEXT DEFAULT '{}',
      result TEXT DEFAULT '',
      error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      task_input TEXT NOT NULL,
      cron_or_delay TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      task_input TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS otel_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn INTEGER DEFAULT 0,
      event_type TEXT NOT NULL,
      action TEXT DEFAULT '',
      plan TEXT DEFAULT '',
      tier TEXT DEFAULT '',
      provider TEXT DEFAULT '',
      model TEXT DEFAULT '',
      tool_name TEXT DEFAULT '',
      status TEXT DEFAULT '',
      latency_ms INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      details_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS ingest_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      attempts INTEGER DEFAULT 0,
      next_retry_at REAL DEFAULT 0,
      last_error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS config_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT DEFAULT '',
      action TEXT DEFAULT '',
      field_changed TEXT DEFAULT '',
      old_value TEXT DEFAULT '',
      new_value TEXT DEFAULT '',
      changed_by TEXT DEFAULT '',
      image_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    // Issues table
    this.sql`CREATE TABLE IF NOT EXISTS issues (
      issue_id TEXT PRIMARY KEY,
      agent_name TEXT DEFAULT '',
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'unknown',
      severity TEXT DEFAULT 'low',
      status TEXT DEFAULT 'open',
      source TEXT DEFAULT 'auto',
      source_session_id TEXT DEFAULT '',
      suggested_fix TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    // Security tables
    this.sql`CREATE TABLE IF NOT EXISTS security_scans (
      scan_id TEXT PRIMARY KEY,
      agent_name TEXT DEFAULT '',
      scan_type TEXT DEFAULT 'config',
      status TEXT DEFAULT 'pending',
      total_probes INTEGER DEFAULT 0,
      passed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      risk_score REAL DEFAULT 0,
      risk_level TEXT DEFAULT 'unknown',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS security_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT DEFAULT '',
      agent_name TEXT DEFAULT '',
      probe_name TEXT DEFAULT '',
      category TEXT DEFAULT '',
      severity TEXT DEFAULT 'info',
      title TEXT DEFAULT '',
      evidence TEXT DEFAULT '',
      aivss_score REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS agent_risk_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      risk_score REAL DEFAULT 0,
      risk_level TEXT DEFAULT 'unknown',
      aivss_vector_json TEXT DEFAULT '{}',
      last_scan_id TEXT DEFAULT '',
      findings_summary_json TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    )`;

    // Vapi tables
    this.sql`CREATE TABLE IF NOT EXISTS vapi_calls (
      call_id TEXT PRIMARY KEY,
      agent_name TEXT DEFAULT '',
      phone_number TEXT DEFAULT '',
      direction TEXT DEFAULT 'outbound',
      status TEXT DEFAULT 'pending',
      duration_seconds REAL DEFAULT 0,
      transcript TEXT DEFAULT '',
      cost_usd REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS vapi_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT DEFAULT '',
      event_type TEXT DEFAULT '',
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS voice_calls (
      call_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      agent_name TEXT DEFAULT '',
      phone_number TEXT DEFAULT '',
      direction TEXT DEFAULT 'outbound',
      status TEXT DEFAULT 'pending',
      duration_seconds REAL DEFAULT 0,
      transcript TEXT DEFAULT '',
      cost_usd REAL DEFAULT 0,
      platform_agent_id TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS voice_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    // Conversation intelligence tables
    this.sql`CREATE TABLE IF NOT EXISTS conversation_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_number INTEGER DEFAULT 0,
      sentiment TEXT DEFAULT 'neutral',
      sentiment_score REAL DEFAULT 0,
      quality_overall REAL DEFAULT 0,
      relevance_score REAL DEFAULT 0,
      coherence_score REAL DEFAULT 0,
      helpfulness_score REAL DEFAULT 0,
      safety_score REAL DEFAULT 1.0,
      topic TEXT DEFAULT '',
      intent TEXT DEFAULT '',
      has_tool_failure INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    // Gold images table
    this.sql`CREATE TABLE IF NOT EXISTS gold_images (
      image_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT DEFAULT '{}',
      config_hash TEXT DEFAULT '',
      version TEXT DEFAULT '1.0.0',
      category TEXT DEFAULT 'general',
      is_active INTEGER DEFAULT 1,
      approved_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS compliance_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      image_id TEXT DEFAULT '',
      status TEXT DEFAULT 'unchecked',
      drift_count INTEGER DEFAULT 0,
      drift_fields TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS conversation_analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      avg_sentiment_score REAL DEFAULT 0,
      dominant_sentiment TEXT DEFAULT 'neutral',
      sentiment_trend TEXT DEFAULT 'stable',
      avg_quality REAL DEFAULT 0,
      total_turns INTEGER DEFAULT 0,
      topics_json TEXT DEFAULT '[]',
      tool_failure_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`;
  }

  // ── Callable Methods (RPC from client) ──────────────────────────

  @callable()
  async run(input: string): Promise<TurnResult[]> {
    const results: TurnResult[] = [];
    const config = this.state.config;
    const sessionId = crypto.randomUUID().slice(0, 16);
    await this._flushIngestOutbox(100);
    const messages: any[] = [
      { role: "system", content: config.systemPrompt },
      { role: "user", content: input },
    ];

    this._recordEvent({
      sessionId,
      turn: 0,
      eventType: "session.start",
      action: "run",
      plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
      details: { inputPreview: input.slice(0, 240), maxTurns: config.maxTurns },
      status: "ok",
    });

    // Load episodic memory context
    const episodes = this.sql<{ input: string; output: string }>`
      SELECT input, output FROM episodes ORDER BY rowid DESC LIMIT 5
    `;
    if (episodes.length > 0) {
      const context = episodes.map(e => `Q: ${e.input}\nA: ${e.output}`).join("\n");
      messages[0].content += `\n\n[Memory]\n${context}`;
    }

    this.setState({ ...this.state, sessionActive: true, turnCount: 0 });

    for (let turn = 1; turn <= config.maxTurns; turn++) {
      if (this.state.totalCostUsd >= config.budgetLimitUsd) {
        results.push({ turn, content: "", toolResults: [], done: true, error: "Budget exhausted", costUsd: 0, model: config.model });
        break;
      }

      const response = await this._callLLM(messages, sessionId, turn);

      this.setState({ ...this.state, turnCount: turn, totalCostUsd: this.state.totalCostUsd + response.costUsd });

      if (response.toolCalls.length > 0) {
        const toolResults = await this._executeTools(response.toolCalls, sessionId, turn);
        results.push({ turn, content: response.content, toolResults, done: false, costUsd: response.costUsd, model: response.model });
        await this._mirrorTurnToBackend(sessionId, {
          turn_number: turn,
          model_used: response.model,
          input_tokens: response.inputTokens,
          output_tokens: response.outputTokens,
          latency_ms: 0,
          llm_content: response.content,
          cost_total_usd: response.costUsd,
          tool_calls_json: JSON.stringify(response.toolCalls || []),
          tool_results_json: JSON.stringify(toolResults || []),
          errors_json: "[]",
          execution_mode: "parallel",
          plan_json: JSON.stringify({ plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN), tier: response.tier }),
          reflection_json: "{}",
          started_at: Date.now() / 1000,
          ended_at: Date.now() / 1000,
        });

        // Add tool results to conversation
        messages.push({ role: "assistant", content: response.content });
        for (const tr of toolResults) {
          messages.push({ role: "tool", content: JSON.stringify(tr) });
        }
      } else {
        results.push({ turn, content: response.content, toolResults: [], done: true, costUsd: response.costUsd, model: response.model });
        await this._mirrorTurnToBackend(sessionId, {
          turn_number: turn,
          model_used: response.model,
          input_tokens: response.inputTokens,
          output_tokens: response.outputTokens,
          latency_ms: 0,
          llm_content: response.content,
          cost_total_usd: response.costUsd,
          tool_calls_json: "[]",
          tool_results_json: "[]",
          errors_json: "[]",
          execution_mode: "sequential",
          plan_json: JSON.stringify({ plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN), tier: response.tier }),
          reflection_json: "{}",
          started_at: Date.now() / 1000,
          ended_at: Date.now() / 1000,
        });

        // Store in episodic memory
        this.sql`INSERT INTO episodes (id, input, output) VALUES (${sessionId}, ${input}, ${response.content})`;
        await this._mirrorEpisodeToBackend({
          id: sessionId,
          input,
          output: response.content,
          outcome: "completed",
          metadata: {
            agent_name: this.state.config.agentName || "agentos",
            org_id: this.state.config.orgId || "",
            project_id: this.state.config.projectId || "",
          },
          created_at: Date.now() / 1000,
        });
        this.sql`INSERT INTO sessions (id, input, output, turns, cost_usd, model) VALUES (${sessionId}, ${input}, ${response.content}, ${turn}, ${this.state.totalCostUsd}, ${response.model})`;
        this._recordEvent({
          sessionId,
          turn,
          eventType: "session.complete",
          action: "run",
          plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
          provider: response.provider,
          model: response.model,
          tier: response.tier,
          status: "ok",
          details: { turns: turn },
          costUsd: this.state.totalCostUsd,
        });
        break;
      }
    }

    this.setState({ ...this.state, sessionActive: false });

    // Auto-score session for conversation intelligence
    try { this.scoreSession(sessionId); } catch { /* non-fatal */ }
    await this._mirrorSessionToBackend(sessionId, input, results);
    await this._flushIngestOutbox(100);

    return results;
  }

  @callable()
  getConfig(): AgentConfig {
    return this.state.config;
  }

  @callable()
  setConfig(config: Partial<AgentConfig>): AgentConfig {
    const before = this.state.config;
    const plan = normalizePlan(config.plan ?? before.plan ?? this.env.DEFAULT_PLAN);
    const updated = { ...before, ...config, plan };
    this.setState({ ...this.state, config: updated });
    const changedKeys = Object.keys(config || {}).filter((k) => {
      const key = k as keyof AgentConfig;
      return JSON.stringify(before[key]) !== JSON.stringify(updated[key]);
    });
    for (const key of changedKeys) {
      const oldValue = JSON.stringify((before as Record<string, unknown>)[key] ?? "");
      const newValue = JSON.stringify((updated as Record<string, unknown>)[key] ?? "");
      this.sql`INSERT INTO config_audit_log (
        agent_name, action, field_changed, old_value, new_value, changed_by, created_at
      ) VALUES (
        ${updated.agentName || "agentos"},
        ${"config.update"},
        ${key},
        ${oldValue},
        ${newValue},
        ${"worker"},
        ${Date.now() / 1000}
      )`;
      void this._sendIngest("/api/v1/edge-ingest/config/audit", {
        org_id: updated.orgId || "",
        agent_name: updated.agentName || "agentos",
        action: "config.update",
        field_changed: key,
        old_value: oldValue,
        new_value: newValue,
        change_reason: "worker_config_update",
        changed_by: "worker",
        created_at: Date.now() / 1000,
      });
    }
    return updated;
  }

  @callable()
  getWorkingMemory(): Record<string, unknown> {
    return this.state.working;
  }

  @callable()
  setWorkingMemory(key: string, value: unknown): void {
    const working = { ...this.state.working, [key]: value };
    this.setState({ ...this.state, working });
  }

  @callable()
  getSessions(limit: number = 20): any[] {
    return this.sql`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable()
  getEpisodes(limit: number = 20): any[] {
    return this.sql`SELECT * FROM episodes ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable()
  getStats(): any {
    const sessions = this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM sessions`;
    const totalCost = this.sql<{ total: number }>`SELECT COALESCE(SUM(cost_usd), 0) as total FROM sessions`;
    return {
      totalSessions: sessions[0]?.cnt ?? 0,
      totalCostUsd: totalCost[0]?.total ?? 0,
      turnCount: this.state.turnCount,
      sessionActive: this.state.sessionActive,
      config: this.state.config,
    };
  }

  // ── Gold Images ──────────────────────────────────────────────

  @callable()
  createGoldImage(name: string, config: any): any {
    const imageId = crypto.randomUUID().slice(0, 16);
    const configJson = JSON.stringify(config);
    const hash = imageId.slice(0, 8); // simplified hash for edge
    this.sql`INSERT INTO gold_images (image_id, name, config_json, config_hash) VALUES (${imageId}, ${name}, ${configJson}, ${hash})`;
    void this._sendIngest("/api/v1/edge-ingest/gold-image", {
      image_id: imageId,
      org_id: this.state.config.orgId || "",
      name,
      description: "",
      config_json: configJson,
      config_hash: hash,
      version: "1.0.0",
      category: "general",
      is_active: 1,
      created_by: "worker",
      approved_by: "",
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    });
    return { imageId, name, hash };
  }

  @callable()
  listGoldImages(): any[] {
    return this.sql`SELECT image_id, name, version, category, is_active, approved_by, created_at FROM gold_images WHERE is_active = 1 ORDER BY created_at DESC LIMIT 50`;
  }

  @callable()
  getGoldImage(imageId: string): any {
    const rows = this.sql`SELECT * FROM gold_images WHERE image_id = ${imageId}`;
    return rows[0] ?? null;
  }

  @callable()
  listComplianceChecks(): any[] {
    return this.sql`SELECT * FROM compliance_checks ORDER BY created_at DESC LIMIT 50`;
  }

  // ── Security ────────────────────────────────────────────────

  @callable()
  listSecurityScans(limit: number = 20): any[] {
    return this.sql`SELECT * FROM security_scans ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable()
  createSecurityScan(input: {
    scanType?: string;
    status?: string;
    totalProbes?: number;
    passed?: number;
    failed?: number;
    errors?: number;
    riskScore?: number;
    riskLevel?: string;
  } = {}): any {
    const scanId = crypto.randomUUID().slice(0, 16);
    const scanType = String(input.scanType || "runtime");
    const status = String(input.status || "completed");
    const totalProbes = Number(input.totalProbes || 0);
    const passed = Number(input.passed || 0);
    const failed = Number(input.failed || 0);
    const errors = Number(input.errors || 0);
    const riskScore = Number(input.riskScore || 0);
    const riskLevel = String(input.riskLevel || "unknown");
    this.sql`INSERT INTO security_scans (
      scan_id, agent_name, scan_type, status, total_probes, passed, failed, risk_score, risk_level
    ) VALUES (
      ${scanId}, ${this.state.config.agentName || "agentos"}, ${scanType}, ${status},
      ${totalProbes}, ${passed}, ${failed}, ${riskScore}, ${riskLevel}
    )`;
    this._recordEvent({
      sessionId: scanId,
      turn: 0,
      eventType: "security.scan",
      action: "create",
      status,
      details: { scanType, totalProbes, passed, failed, errors, riskScore, riskLevel },
    });
    void this._sendIngest("/api/v1/edge-ingest/security/scan", {
      scan_id: scanId,
      org_id: this.state.config.orgId || "",
      agent_name: this.state.config.agentName || "agentos",
      scan_type: scanType,
      status,
      total_probes: totalProbes,
      passed,
      failed,
      errors,
      risk_score: riskScore,
      risk_level: riskLevel,
      created_at: Date.now() / 1000,
    });
    return { scanId, status, riskScore, riskLevel };
  }

  @callable()
  listSecurityFindings(scanId: string = ""): any[] {
    if (scanId) return this.sql`SELECT * FROM security_findings WHERE scan_id = ${scanId} ORDER BY aivss_score DESC`;
    return this.sql`SELECT * FROM security_findings ORDER BY aivss_score DESC LIMIT 100`;
  }

  @callable()
  createSecurityFinding(input: {
    scanId: string;
    probeName?: string;
    category?: string;
    severity?: string;
    title?: string;
    evidence?: string;
    aivssScore?: number;
  }): any {
    const scanId = String(input.scanId || "");
    if (!scanId) return { error: "scanId required" };
    const probeName = String(input.probeName || "probe");
    const category = String(input.category || "unknown");
    const severity = String(input.severity || "info");
    const title = String(input.title || "finding");
    const evidence = String(input.evidence || "");
    const aivssScore = Number(input.aivssScore || 0);
    this.sql`INSERT INTO security_findings (
      scan_id, agent_name, probe_name, category, severity, title, evidence, aivss_score
    ) VALUES (
      ${scanId}, ${this.state.config.agentName || "agentos"}, ${probeName}, ${category}, ${severity}, ${title}, ${evidence}, ${aivssScore}
    )`;
    this._recordEvent({
      sessionId: scanId,
      turn: 0,
      eventType: "security.finding",
      action: "create",
      status: "ok",
      details: { probeName, category, severity, title, aivssScore },
    });
    void this._sendIngest("/api/v1/edge-ingest/security/finding", {
      scan_id: scanId,
      org_id: this.state.config.orgId || "",
      agent_name: this.state.config.agentName || "agentos",
      probe_id: probeName,
      probe_name: probeName,
      category,
      layer: "runtime",
      severity,
      status: "open",
      title,
      description: title,
      evidence,
      remediation: "",
      aivss_vector: "",
      aivss_score: aivssScore,
      created_at: Date.now() / 1000,
    });
    return { created: true, scanId, probeName, severity, aivssScore };
  }

  @callable()
  upsertRiskProfile(input: {
    riskScore?: number;
    riskLevel?: string;
    aivssVectorJson?: string;
    lastScanId?: string;
    findingsSummaryJson?: string;
  } = {}): any {
    const agentName = this.state.config.agentName || "agentos";
    const riskScore = Number(input.riskScore || 0);
    const riskLevel = String(input.riskLevel || "unknown");
    const aivssVectorJson = String(input.aivssVectorJson || "{}");
    const lastScanId = String(input.lastScanId || "");
    const findingsSummaryJson = String(input.findingsSummaryJson || "{}");
    const existing = this.sql<{ id: number }>`SELECT id FROM agent_risk_profiles WHERE agent_name = ${agentName} LIMIT 1`;
    if (existing.length > 0) {
      this.sql`UPDATE agent_risk_profiles
        SET risk_score = ${riskScore},
            risk_level = ${riskLevel},
            aivss_vector_json = ${aivssVectorJson},
            last_scan_id = ${lastScanId},
            findings_summary_json = ${findingsSummaryJson},
            updated_at = ${Date.now() / 1000}
        WHERE id = ${existing[0].id}`;
    } else {
      this.sql`INSERT INTO agent_risk_profiles (
        agent_name, risk_score, risk_level, aivss_vector_json, last_scan_id, findings_summary_json, updated_at
      ) VALUES (
        ${agentName}, ${riskScore}, ${riskLevel}, ${aivssVectorJson}, ${lastScanId}, ${findingsSummaryJson}, ${Date.now() / 1000}
      )`;
    }
    this._recordEvent({
      sessionId: lastScanId || agentName,
      turn: 0,
      eventType: "security.risk_profile",
      action: "upsert",
      status: "ok",
      details: { riskScore, riskLevel, lastScanId },
    });
    void this._sendIngest("/api/v1/edge-ingest/security/risk-profile", {
      org_id: this.state.config.orgId || "",
      agent_name: agentName,
      risk_score: riskScore,
      risk_level: riskLevel,
      aivss_vector_json: aivssVectorJson,
      last_scan_id: lastScanId,
      findings_summary_json: findingsSummaryJson,
      updated_at: Date.now() / 1000,
    });
    return { agentName, riskScore, riskLevel };
  }

  @callable()
  listRiskProfiles(): any[] {
    return this.sql`SELECT * FROM agent_risk_profiles ORDER BY updated_at DESC LIMIT 100`;
  }

  // ── Voice (Vapi) ───────────────────────────────────────────────

  @callable()
  upsertVapiCall(input: {
    callId: string;
    phoneNumber?: string;
    direction?: string;
    status?: string;
    durationSeconds?: number;
    transcript?: string;
    costUsd?: number;
    vapiAssistantId?: string;
    metadata?: Record<string, unknown>;
    startedAt?: number;
    endedAt?: number;
  }): any {
    const callId = String(input.callId || "");
    if (!callId) return { error: "callId required" };
    const existing = this.sql<{ call_id: string }>`SELECT call_id FROM vapi_calls WHERE call_id = ${callId} LIMIT 1`;
    if (existing.length > 0) {
      this.sql`UPDATE vapi_calls
        SET agent_name = ${this.state.config.agentName || "agentos"},
            phone_number = ${String(input.phoneNumber || "")},
            direction = ${String(input.direction || "outbound")},
            status = ${String(input.status || "pending")},
            duration_seconds = ${Number(input.durationSeconds || 0)},
            transcript = ${String(input.transcript || "")},
            cost_usd = ${Number(input.costUsd || 0)}
        WHERE call_id = ${callId}`;
    } else {
      this.sql`INSERT INTO vapi_calls (
        call_id, agent_name, phone_number, direction, status, duration_seconds, transcript, cost_usd
      ) VALUES (
        ${callId}, ${this.state.config.agentName || "agentos"}, ${String(input.phoneNumber || "")},
        ${String(input.direction || "outbound")}, ${String(input.status || "pending")},
        ${Number(input.durationSeconds || 0)}, ${String(input.transcript || "")}, ${Number(input.costUsd || 0)}
      )`;
    }
    this._recordEvent({
      sessionId: callId,
      turn: 0,
      eventType: "voice.call",
      action: "upsert",
      status: String(input.status || "pending"),
      details: { direction: input.direction || "outbound", durationSeconds: Number(input.durationSeconds || 0) },
      costUsd: Number(input.costUsd || 0),
    });
    void this._mirrorVapiCallToBackend({
      call_id: callId,
      org_id: this.state.config.orgId || "",
      agent_name: this.state.config.agentName || "agentos",
      phone_number: String(input.phoneNumber || ""),
      direction: String(input.direction || "outbound"),
      status: String(input.status || "pending"),
      duration_seconds: Number(input.durationSeconds || 0),
      transcript: String(input.transcript || ""),
      cost_usd: Number(input.costUsd || 0),
      vapi_assistant_id: String(input.vapiAssistantId || ""),
      metadata: input.metadata || {},
      started_at: Number(input.startedAt || Date.now() / 1000),
      ended_at: Number(input.endedAt || 0),
    });
    return { callId, status: String(input.status || "pending") };
  }

  @callable()
  recordVapiEvent(input: {
    callId: string;
    eventType: string;
    payload?: Record<string, unknown>;
  }): any {
    const callId = String(input.callId || "");
    const eventType = String(input.eventType || "");
    if (!callId || !eventType) return { error: "callId and eventType required" };
    const payloadJson = JSON.stringify(input.payload || {});
    this.sql`INSERT INTO vapi_events (call_id, event_type, payload_json) VALUES (${callId}, ${eventType}, ${payloadJson})`;
    this._recordEvent({
      sessionId: callId,
      turn: 0,
      eventType: "voice.event",
      action: eventType,
      status: "ok",
      details: input.payload || {},
    });
    void this._mirrorVapiEventToBackend({
      call_id: callId,
      org_id: this.state.config.orgId || "",
      event_type: eventType,
      payload_json: payloadJson,
    });
    return { recorded: true, callId, eventType };
  }

  @callable()
  listVapiCalls(limit: number = 50): any[] {
    return this.sql`SELECT * FROM vapi_calls ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable()
  listVapiEvents(callId: string, limit: number = 100): any[] {
    return this.sql`SELECT * FROM vapi_events WHERE call_id = ${callId} ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable()
  upsertVoiceCall(input: {
    callId: string;
    platform: string;
    phoneNumber?: string;
    direction?: string;
    status?: string;
    durationSeconds?: number;
    transcript?: string;
    costUsd?: number;
    platformAgentId?: string;
    metadata?: Record<string, unknown>;
  }): any {
    const callId = String(input.callId || "");
    const platform = String(input.platform || "");
    if (!callId || !platform) return { error: "callId and platform required" };
    const exists = this.sql<{ call_id: string }>`SELECT call_id FROM voice_calls WHERE call_id = ${callId} LIMIT 1`;
    if (exists.length > 0) {
      this.sql`UPDATE voice_calls
        SET platform = ${platform},
            agent_name = ${this.state.config.agentName || "agentos"},
            phone_number = ${String(input.phoneNumber || "")},
            direction = ${String(input.direction || "outbound")},
            status = ${String(input.status || "pending")},
            duration_seconds = ${Number(input.durationSeconds || 0)},
            transcript = ${String(input.transcript || "")},
            cost_usd = ${Number(input.costUsd || 0)},
            platform_agent_id = ${String(input.platformAgentId || "")},
            metadata_json = ${JSON.stringify(input.metadata || {})}
        WHERE call_id = ${callId}`;
    } else {
      this.sql`INSERT INTO voice_calls (
        call_id, platform, agent_name, phone_number, direction, status,
        duration_seconds, transcript, cost_usd, platform_agent_id, metadata_json
      ) VALUES (
        ${callId}, ${platform}, ${this.state.config.agentName || "agentos"},
        ${String(input.phoneNumber || "")}, ${String(input.direction || "outbound")},
        ${String(input.status || "pending")}, ${Number(input.durationSeconds || 0)},
        ${String(input.transcript || "")}, ${Number(input.costUsd || 0)},
        ${String(input.platformAgentId || "")}, ${JSON.stringify(input.metadata || {})}
      )`;
    }
    void this._sendIngest("/api/v1/edge-ingest/voice/call", {
      call_id: callId,
      platform,
      org_id: this.state.config.orgId || "",
      agent_name: this.state.config.agentName || "agentos",
      phone_number: String(input.phoneNumber || ""),
      direction: String(input.direction || "outbound"),
      status: String(input.status || "pending"),
      duration_seconds: Number(input.durationSeconds || 0),
      transcript: String(input.transcript || ""),
      cost_usd: Number(input.costUsd || 0),
      platform_agent_id: String(input.platformAgentId || ""),
      metadata: input.metadata || {},
      created_at: Date.now() / 1000,
    });
    return { callId, platform, status: String(input.status || "pending") };
  }

  @callable()
  recordVoiceEvent(input: {
    callId: string;
    platform: string;
    eventType: string;
    payload?: Record<string, unknown>;
  }): any {
    const callId = String(input.callId || "");
    const platform = String(input.platform || "");
    const eventType = String(input.eventType || "");
    if (!callId || !platform || !eventType) return { error: "callId, platform, eventType required" };
    const payloadJson = JSON.stringify(input.payload || {});
    this.sql`INSERT INTO voice_events (call_id, platform, event_type, payload_json) VALUES (${callId}, ${platform}, ${eventType}, ${payloadJson})`;
    void this._sendIngest("/api/v1/edge-ingest/voice/event", {
      call_id: callId,
      platform,
      org_id: this.state.config.orgId || "",
      event_type: eventType,
      payload_json: payloadJson,
      created_at: Date.now() / 1000,
    });
    return { recorded: true, callId, platform, eventType };
  }

  @callable()
  listVoiceCalls(platform: string = "", limit: number = 50): any[] {
    if (platform) {
      return this.sql`SELECT * FROM voice_calls WHERE platform = ${platform} ORDER BY created_at DESC LIMIT ${limit}`;
    }
    return this.sql`SELECT * FROM voice_calls ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable()
  listVoiceEvents(callId: string, platform: string = "", limit: number = 100): any[] {
    if (platform) {
      return this.sql`SELECT * FROM voice_events WHERE call_id = ${callId} AND platform = ${platform} ORDER BY created_at DESC LIMIT ${limit}`;
    }
    return this.sql`SELECT * FROM voice_events WHERE call_id = ${callId} ORDER BY created_at DESC LIMIT ${limit}`;
  }

  // ── Issues ──────────────────────────────────────────────────

  @callable()
  listIssues(status: string = "", limit: number = 50): any[] {
    if (status) {
      return this.sql`SELECT * FROM issues WHERE status = ${status} ORDER BY created_at DESC LIMIT ${limit}`;
    }
    return this.sql`SELECT * FROM issues ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable()
  createIssue(title: string, description: string, category: string = "unknown", severity: string = "low"): any {
    const issueId = crypto.randomUUID().slice(0, 16);
    this.sql`INSERT INTO issues (issue_id, title, description, category, severity, source) VALUES (${issueId}, ${title}, ${description}, ${category}, ${severity}, 'manual')`;
    void this._sendIngest("/api/v1/edge-ingest/issues", {
      issue_id: issueId,
      org_id: this.state.config.orgId || "",
      agent_name: this.state.config.agentName || "agentos",
      title,
      description,
      category,
      severity,
      status: "open",
      source: "manual",
      metadata_json: "{}",
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    });
    return { issueId, title, category, severity };
  }

  @callable()
  resolveIssue(issueId: string): any {
    this.sql`UPDATE issues SET status = 'resolved' WHERE issue_id = ${issueId}`;
    void this._sendIngest("/api/v1/edge-ingest/issues", {
      issue_id: issueId,
      org_id: this.state.config.orgId || "",
      agent_name: this.state.config.agentName || "agentos",
      title: "",
      description: "",
      category: "unknown",
      severity: "low",
      status: "resolved",
      source: "manual",
      metadata_json: "{}",
      updated_at: Date.now() / 1000,
    });
    return { resolved: true, issueId };
  }

  @callable()
  issueSummary(): any {
    const total = this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM issues`;
    const byStatus = this.sql<{ status: string; cnt: number }>`SELECT status, COUNT(*) as cnt FROM issues GROUP BY status`;
    const byCategory = this.sql<{ category: string; cnt: number }>`SELECT category, COUNT(*) as cnt FROM issues GROUP BY category`;
    return {
      total: total[0]?.cnt ?? 0,
      byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.cnt])),
      byCategory: Object.fromEntries(byCategory.map(r => [r.category, r.cnt])),
    };
  }

  // ── Conversation Intelligence ─────────────────────────────────

  @callable()
  scoreSession(sessionId: string): any {
    const sessions = this.sql<{ input: string; output: string }>`SELECT input, output FROM sessions WHERE id = ${sessionId}`;
    if (!sessions.length) return { error: "Session not found" };
    const session = sessions[0];

    // Simple heuristic scoring (edge-compatible, no LLM needed)
    const output = session.output || "";
    const input = session.input || "";
    const words = output.split(/\s+/).length;

    // Quality heuristics
    const coherence = Math.min(1, 0.4 + (words > 5 ? 0.2 : 0) + (output.includes(".") ? 0.1 : 0) + (output.includes("\n") ? 0.1 : 0) + (output.includes("```") ? 0.1 : 0));
    const inputWords = new Set(input.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const outputWords = new Set(output.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const overlap = [...inputWords].filter(w => outputWords.has(w)).length;
    const relevance = inputWords.size > 0 ? Math.min(1, 0.3 + (overlap / inputWords.size) * 1.2) : 0.5;
    const helpfulness = Math.min(1, 0.4 + (words > 20 ? 0.15 : 0) + (output.includes("```") ? 0.15 : 0));
    const quality = relevance * 0.3 + coherence * 0.2 + helpfulness * 0.35 + 0.15;

    // Sentiment heuristics
    const posWords = ["thank", "great", "good", "perfect", "helpful", "works", "solved", "excellent"];
    const negWords = ["wrong", "error", "fail", "bad", "broken", "bug", "issue", "problem"];
    const lower = output.toLowerCase();
    const posCount = posWords.filter(w => lower.includes(w)).length;
    const negCount = negWords.filter(w => lower.includes(w)).length;
    const sentimentScore = (posCount - negCount) / Math.max(posCount + negCount, 1);
    const sentimentConfidence = Math.min(1, Math.max(0.1, (posCount + negCount) / 4));
    const sentiment = posCount > negCount ? "positive" : negCount > posCount ? "negative" : "neutral";
    const hasHallucinationRisk = /\b(guess|unsure|not sure|maybe|probably)\b/i.test(output) ? 1 : 0;

    // Persist
    this.sql`INSERT INTO conversation_scores (session_id, turn_number, sentiment, sentiment_score, quality_overall, relevance_score, coherence_score, helpfulness_score) VALUES (${sessionId}, ${1}, ${sentiment}, ${sentimentScore}, ${quality}, ${relevance}, ${coherence}, ${helpfulness})`;
    this.sql`INSERT OR REPLACE INTO conversation_analytics (session_id, avg_sentiment_score, dominant_sentiment, avg_quality, total_turns) VALUES (${sessionId}, ${sentimentScore}, ${sentiment}, ${quality}, ${1})`;
    void this._sendIngest("/api/v1/edge-ingest/conversation/score", {
      session_id: sessionId,
      turn_number: 1,
      org_id: this.state.config.orgId || "",
      agent_name: this.state.config.agentName || "agentos",
      sentiment,
      sentiment_score: sentimentScore,
      sentiment_confidence: sentimentConfidence,
      relevance_score: relevance,
      coherence_score: coherence,
      helpfulness_score: helpfulness,
      safety_score: 1.0,
      quality_overall: quality,
      topic: "",
      intent: "",
      has_tool_failure: 0,
      has_hallucination_risk: hasHallucinationRisk,
      scorer_model: "heuristic",
      created_at: Date.now() / 1000,
    });
    void this._sendIngest("/api/v1/edge-ingest/conversation/analytics", {
      session_id: sessionId,
      org_id: this.state.config.orgId || "",
      agent_name: this.state.config.agentName || "agentos",
      avg_sentiment_score: sentimentScore,
      dominant_sentiment: sentiment,
      sentiment_trend: "stable",
      avg_quality: quality,
      topics_json: "[]",
      total_turns: 1,
      tool_failure_count: 0,
      hallucination_risk_count: hasHallucinationRisk,
      created_at: Date.now() / 1000,
    });

    return { sessionId, quality: Math.round(quality * 1000) / 1000, sentiment, sentimentScore: Math.round(sentimentScore * 1000) / 1000 };
  }

  @callable()
  getIntelligence(limit: number = 20): any {
    const scores = this.sql`SELECT * FROM conversation_scores ORDER BY created_at DESC LIMIT ${limit}`;
    const analytics = this.sql`SELECT * FROM conversation_analytics ORDER BY created_at DESC LIMIT ${limit}`;
    const summary = this.sql<{ avg_q: number; avg_s: number; cnt: number }>`SELECT AVG(quality_overall) as avg_q, AVG(sentiment_score) as avg_s, COUNT(*) as cnt FROM conversation_scores`;
    const sentDist = this.sql<{ sentiment: string; cnt: number }>`SELECT sentiment, COUNT(*) as cnt FROM conversation_scores GROUP BY sentiment`;
    return {
      scores,
      analytics,
      summary: {
        avgQuality: summary[0]?.avg_q ?? 0,
        avgSentiment: summary[0]?.avg_s ?? 0,
        totalScored: summary[0]?.cnt ?? 0,
      },
      sentimentDistribution: Object.fromEntries(sentDist.map(r => [r.sentiment, r.cnt])),
    };
  }

  @callable()
  recordComplianceCheck(input: {
    imageId?: string;
    imageName?: string;
    status?: string;
    driftCount?: number;
    driftFields?: string[];
    driftDetailsJson?: string;
  } = {}): any {
    const agentName = this.state.config.agentName || "agentos";
    const imageId = String(input.imageId || "");
    const imageName = String(input.imageName || "");
    const status = String(input.status || "unchecked");
    const driftCount = Number(input.driftCount || 0);
    const driftFields = JSON.stringify(input.driftFields || []);
    const driftDetailsJson = String(input.driftDetailsJson || "{}");
    this.sql`INSERT INTO compliance_checks (
      agent_name, image_id, status, drift_count, drift_fields
    ) VALUES (
      ${agentName}, ${imageId}, ${status}, ${driftCount}, ${driftFields}
    )`;
    this._recordEvent({
      sessionId: imageId || agentName,
      turn: 0,
      eventType: "compliance.check",
      action: "record",
      status,
      details: { imageId, driftCount },
    });
    void this._sendIngest("/api/v1/edge-ingest/compliance-check", {
      org_id: this.state.config.orgId || "",
      agent_name: agentName,
      image_id: imageId,
      image_name: imageName,
      status,
      drift_count: driftCount,
      drift_fields: driftFields,
      drift_details_json: driftDetailsJson,
      checked_by: "worker",
      created_at: Date.now() / 1000,
    });
    return { recorded: true, status, driftCount };
  }

  // ── Scheduling (cron jobs) ──────────────────────────────────────

  @callable()
  scheduleTask(taskInput: string, cronOrDelay: string | number): string {
    const id = crypto.randomUUID().slice(0, 12);
    this.sql`INSERT INTO schedules (id, task_input, cron_or_delay) VALUES (${id}, ${taskInput}, ${String(cronOrDelay)})`;
    if (typeof cronOrDelay === "string") {
      this.schedule(cronOrDelay, "runScheduledTask", { id, taskInput });
    } else {
      this.schedule(cronOrDelay, "runScheduledTask", { id, taskInput });
    }
    return id;
  }

  async runScheduledTask(payload: { id: string; taskInput: string }) {
    await this.run(payload.taskInput);
  }

  @callable()
  getSchedules(): any[] {
    return this.sql`SELECT * FROM schedules ORDER BY created_at DESC LIMIT 100`;
  }

  // ── Queueing (async jobs) ──────────────────────────────────────

  @callable()
  enqueueJob(taskInput: string, priority: number = 0): string {
    const jobId = crypto.randomUUID().slice(0, 16);
    this.sql`INSERT INTO jobs (id, task_input, priority, status) VALUES (${jobId}, ${taskInput}, ${priority}, 'queued')`;
    this.queue("processJob", { jobId, taskInput, priority });
    return jobId;
  }

  async processJob(payload: { jobId: string; taskInput: string; priority?: number }) {
    this.sql`UPDATE jobs SET status = 'running' WHERE id = ${payload.jobId}`;
    try {
      const results = await this.run(payload.taskInput);
      this.sql`UPDATE jobs SET status = 'completed' WHERE id = ${payload.jobId}`;
      return results;
    } catch (err) {
      this.sql`UPDATE jobs SET status = 'failed' WHERE id = ${payload.jobId}`;
      throw err;
    }
  }

  // ── HTTP Handler ────────────────────────────────────────────────

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").pop() || "";

    if (path !== "health") {
      const authorized = await this._isAuthorized(request);
      if (!authorized) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Health
    if (path === "health") {
      return Response.json({ status: "ok", agent: this.state.config.agentName });
    }

    // Run
    if (path === "run" && request.method === "POST") {
      const { input } = await request.json() as { input: string };
      const results = await this.run(input);
      const last = results[results.length - 1];
      return Response.json({
        success: !last?.error,
        output: last?.content ?? "",
        turns: results.length,
        costUsd: this.state.totalCostUsd,
        turnResults: results,
      });
    }

    // Config
    if (path === "config" && request.method === "GET") {
      return Response.json(this.getConfig());
    }
    if (path === "config" && request.method === "PUT") {
      const config = await request.json();
      return Response.json(this.setConfig(config));
    }

    // Stats
    if (path === "stats") {
      return Response.json(this.getStats());
    }

    // Sessions
    if (path === "sessions") {
      return Response.json(this.getSessions());
    }

    if (path === "observability") {
      const summary = this.sql<{
        event_type: string;
        action: string;
        plan: string;
        tier: string;
        provider: string;
        model: string;
        count: number;
      }>`
        SELECT
          event_type,
          action,
          plan,
          tier,
          provider,
          model,
          COUNT(*) as count
        FROM otel_events
        GROUP BY event_type, action, plan, tier, provider, model
        ORDER BY count DESC, event_type ASC
        LIMIT 200
      `;
      return Response.json({
        totalEvents: this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM otel_events`[0]?.cnt ?? 0,
        summary,
      });
    }

    if (path === "events") {
      const limit = Number(url.searchParams.get("limit") || "100");
      const sessionId = url.searchParams.get("session_id") || "";
      const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 100;
      if (sessionId) {
        const events = this.sql<ObservabilityEvent>`
          SELECT * FROM otel_events
          WHERE session_id = ${sessionId}
          ORDER BY id DESC
          LIMIT ${bounded}
        `;
        return Response.json(events);
      }
      const events = this.sql<ObservabilityEvent>`
        SELECT * FROM otel_events
        ORDER BY id DESC
        LIMIT ${bounded}
      `;
      return Response.json(events);
    }

    // Security
    if (path === "security-scans") {
      if (request.method === "POST") {
        const body = await request.json() as {
          scanType?: string; status?: string; totalProbes?: number; passed?: number; failed?: number;
          errors?: number; riskScore?: number; riskLevel?: string;
        };
        return Response.json(this.createSecurityScan(body || {}));
      }
      return Response.json({ scans: this.listSecurityScans() });
    }
    if (path === "security-findings") {
      if (request.method === "POST") {
        const body = await request.json() as {
          scanId?: string; probeName?: string; category?: string; severity?: string;
          title?: string; evidence?: string; aivssScore?: number;
        };
        if (!body.scanId) return Response.json({ error: "scanId required" }, { status: 400 });
        return Response.json(this.createSecurityFinding({
          scanId: body.scanId,
          probeName: body.probeName,
          category: body.category,
          severity: body.severity,
          title: body.title,
          evidence: body.evidence,
          aivssScore: body.aivssScore,
        }));
      }
      const scanId = url.searchParams.get("scan_id") || "";
      return Response.json({ findings: this.listSecurityFindings(scanId) });
    }
    if (path === "security-risk-profiles") {
      if (request.method === "POST") {
        const body = await request.json() as {
          riskScore?: number; riskLevel?: string; aivssVectorJson?: string;
          lastScanId?: string; findingsSummaryJson?: string;
        };
        return Response.json(this.upsertRiskProfile(body || {}));
      }
      return Response.json({ profiles: this.listRiskProfiles() });
    }
    if (path === "vapi-calls") {
      if (request.method === "POST") {
        const body = await request.json() as {
          callId?: string; phoneNumber?: string; direction?: string; status?: string; durationSeconds?: number;
          transcript?: string; costUsd?: number; vapiAssistantId?: string; metadata?: Record<string, unknown>;
          startedAt?: number; endedAt?: number;
        };
        if (!body.callId) return Response.json({ error: "callId required" }, { status: 400 });
        return Response.json(this.upsertVapiCall({
          callId: body.callId,
          phoneNumber: body.phoneNumber,
          direction: body.direction,
          status: body.status,
          durationSeconds: body.durationSeconds,
          transcript: body.transcript,
          costUsd: body.costUsd,
          vapiAssistantId: body.vapiAssistantId,
          metadata: body.metadata,
          startedAt: body.startedAt,
          endedAt: body.endedAt,
        }));
      }
      return Response.json({ calls: this.listVapiCalls() });
    }
    if (path === "vapi-events") {
      if (request.method === "POST") {
        const body = await request.json() as { callId?: string; eventType?: string; payload?: Record<string, unknown> };
        if (!body.callId || !body.eventType) {
          return Response.json({ error: "callId and eventType required" }, { status: 400 });
        }
        return Response.json(this.recordVapiEvent({ callId: body.callId, eventType: body.eventType, payload: body.payload || {} }));
      }
      const callId = url.searchParams.get("call_id") || "";
      if (!callId) return Response.json({ error: "call_id required" }, { status: 400 });
      return Response.json({ events: this.listVapiEvents(callId) });
    }
    if (path === "voice-calls") {
      if (request.method === "POST") {
        const body = await request.json() as {
          callId?: string; platform?: string; phoneNumber?: string; direction?: string; status?: string;
          durationSeconds?: number; transcript?: string; costUsd?: number; platformAgentId?: string;
          metadata?: Record<string, unknown>;
        };
        if (!body.callId || !body.platform) {
          return Response.json({ error: "callId and platform required" }, { status: 400 });
        }
        return Response.json(this.upsertVoiceCall({
          callId: body.callId,
          platform: body.platform,
          phoneNumber: body.phoneNumber,
          direction: body.direction,
          status: body.status,
          durationSeconds: body.durationSeconds,
          transcript: body.transcript,
          costUsd: body.costUsd,
          platformAgentId: body.platformAgentId,
          metadata: body.metadata || {},
        }));
      }
      const platform = url.searchParams.get("platform") || "";
      return Response.json({ calls: this.listVoiceCalls(platform) });
    }
    if (path === "voice-events") {
      if (request.method === "POST") {
        const body = await request.json() as { callId?: string; platform?: string; eventType?: string; payload?: Record<string, unknown> };
        if (!body.callId || !body.platform || !body.eventType) {
          return Response.json({ error: "callId, platform, eventType required" }, { status: 400 });
        }
        return Response.json(this.recordVoiceEvent({
          callId: body.callId,
          platform: body.platform,
          eventType: body.eventType,
          payload: body.payload || {},
        }));
      }
      const callId = url.searchParams.get("call_id") || "";
      const platform = url.searchParams.get("platform") || "";
      if (!callId) return Response.json({ error: "call_id required" }, { status: 400 });
      return Response.json({ events: this.listVoiceEvents(callId, platform) });
    }

    // Issues
    if (path === "issues") {
      if (request.method === "POST") {
        const body = await request.json() as { title?: string; description?: string; category?: string; severity?: string };
        if (!body.title) return Response.json({ error: "title required" }, { status: 400 });
        return Response.json(this.createIssue(body.title, body.description ?? "", body.category, body.severity));
      }
      const status = url.searchParams.get("status") || "";
      return Response.json({ issues: this.listIssues(status) });
    }
    if (path === "issues-summary") {
      return Response.json(this.issueSummary());
    }

    // Gold Images
    if (path === "gold-images") {
      if (request.method === "POST") {
        const body = await request.json() as { name?: string; config?: any };
        if (!body.name || !body.config) return Response.json({ error: "name and config required" }, { status: 400 });
        return Response.json(this.createGoldImage(body.name, body.config));
      }
      return Response.json({ images: this.listGoldImages() });
    }
    if (path === "compliance") {
      if (request.method === "POST") {
        const body = await request.json() as {
          imageId?: string; imageName?: string; status?: string; driftCount?: number;
          driftFields?: string[]; driftDetailsJson?: string;
        };
        return Response.json(this.recordComplianceCheck(body || {}));
      }
      return Response.json({ checks: this.listComplianceChecks() });
    }

    // Conversation Intelligence
    if (path === "intel" || path === "intelligence") {
      return Response.json(this.getIntelligence());
    }
    if (path === "intel-score" && request.method === "POST") {
      const body = await request.json() as { sessionId?: string };
      if (!body.sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });
      return Response.json(this.scoreSession(body.sessionId));
    }

    // Memory
    if (path === "memory") {
      return Response.json({
        working: this.getWorkingMemory(),
        episodes: this.getEpisodes(),
        procedures: [],
      });
    }

    return new Response("Not found", { status: 404 });
  }

  private async _isAuthorized(request: Request): Promise<boolean> {
    const secret = this.env.AUTH_JWT_SECRET;
    if (!secret) return true;
    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return false;
    const token = auth.slice(7).trim();
    return verifyHs256Jwt(token, secret);
  }

  // ── WebSocket (real-time streaming) ─────────────────────────────

  async onConnect(connection: Connection) {
    connection.send(JSON.stringify({ type: "connected", agent: this.state.config.agentName }));
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer) {
    const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

    if (data.type === "run") {
      const results = await this.run(data.input);
      for (const result of results) {
        connection.send(JSON.stringify({ type: "turn", ...result }));
      }
      connection.send(JSON.stringify({ type: "done" }));
    }
  }

  // ── LLM Routing (Workers AI / GMI / Anthropic / OpenAI) ────────

  private async _callLLM(messages: any[], sessionId: string, turn: number): Promise<{
    content: string; model: string; toolCalls: any[];
    provider: string; tier: ComplexityTier;
    inputTokens: number; outputTokens: number; costUsd: number;
  }> {
    const config = this.state.config;
    const resolved = this._resolveRoute(messages);
    const provider = resolved.provider;
    const model = resolved.model;
    const tier = resolved.tier;
    const maxTokens = resolved.maxTokens;
    const start = Date.now();

    try {
      if (this._isBackendProxyOnly()) {
        if (provider === "workers-ai") {
          throw new Error("workers_ai_disabled_in_backend_proxy_only_mode");
        }
        return await this._callLLMViaBackendProxy(messages, sessionId, turn, {
          provider,
          model,
          tier,
          maxTokens,
        });
      }

      if (provider === "workers-ai") {
        const result = await this.env.AI.run(model as any, { messages }) as any;
        const latency = Date.now() - start;
        this._recordEvent({
          sessionId,
          turn,
          eventType: "llm.call",
          action: "inference",
          plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
          tier,
          provider,
          model,
          status: "ok",
          latencyMs: latency,
        });
        return {
          content: result.response || "",
          model,
          provider,
          tier,
          toolCalls: [],
          inputTokens: 0, outputTokens: 0,
          costUsd: 0, // Workers AI pricing handled by Cloudflare
        };
      }

      // Centralized backend proxy: provider keys live only on backend.
      if (this._ingestBase() && this.env.BACKEND_INGEST_TOKEN) {
        return await this._callLLMViaBackendProxy(messages, sessionId, turn, {
          provider,
          model,
          tier,
          maxTokens,
        });
      }

      // GMI / OpenAI-compatible
      if (provider === "gmi" || provider === "openai") {
        const apiBase = provider === "gmi"
          ? "https://api.gmi-serving.com/v1"
          : "https://api.openai.com/v1";
        const apiKey = provider === "gmi"
          ? this.env.GMI_API_KEY
          : this.env.OPENAI_API_KEY;
        if (!apiKey) {
          this._recordEvent({
            sessionId,
            turn,
            eventType: "llm.call",
            action: "inference",
            plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
            tier,
            provider,
            model,
            status: "error",
            details: { message: `${provider.toUpperCase()} API key not configured` },
          });
          return {
            content: `${provider.toUpperCase()} API key not configured`,
            model,
            provider,
            tier,
            toolCalls: [],
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          };
        }

        const resp = await this._safeFetch(`${apiBase}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
        });
        const data = await resp.json() as any;
        const choice = data.choices?.[0] || {};
        const latency = Date.now() - start;
        this._recordEvent({
          sessionId,
          turn,
          eventType: "llm.call",
          action: "inference",
          plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
          tier,
          provider,
          model: data.model || model,
          status: resp.ok ? "ok" : "error",
          latencyMs: latency,
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
          details: { httpStatus: resp.status },
        });
        return {
          content: choice.message?.content || "",
          model: data.model || model,
          provider,
          tier,
          toolCalls: choice.message?.tool_calls || [],
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
          costUsd: 0, // Tracked by billing system
        };
      }

      // Anthropic
      if (provider === "anthropic") {
        const systemMsg = messages.find((m: any) => m.role === "system")?.content || "";
        const chatMsgs = messages.filter((m: any) => m.role !== "system");
        const resp = await this._safeFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.env.ANTHROPIC_API_KEY!,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ model, messages: chatMsgs, system: systemMsg, max_tokens: maxTokens }),
        });
        const data = await resp.json() as any;
        const content = data.content?.map((b: any) => b.text).join("") || "";
        const latency = Date.now() - start;
        this._recordEvent({
          sessionId,
          turn,
          eventType: "llm.call",
          action: "inference",
          plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
          tier,
          provider,
          model: data.model || model,
          status: resp.ok ? "ok" : "error",
          latencyMs: latency,
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
          details: { httpStatus: resp.status },
        });
        return {
          content,
          model: data.model || model,
          provider,
          tier,
          toolCalls: data.content?.filter((b: any) => b.type === "tool_use") || [],
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
          costUsd: 0,
        };
      }

      this._recordEvent({
        sessionId,
        turn,
        eventType: "llm.call",
        action: "inference",
        plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
        tier,
        provider,
        model,
        status: "error",
        details: { message: "Unknown provider" },
      });
      return { content: "Unknown provider", model, provider, tier, toolCalls: [], inputTokens: 0, outputTokens: 0, costUsd: 0 };
    } catch (err: any) {
      this._recordEvent({
        sessionId,
        turn,
        eventType: "llm.call",
        action: "inference",
        plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
        tier,
        provider,
        model,
        status: "error",
        details: { message: String(err?.message || err) },
      });
      return { content: `Error: ${err.message}`, model, provider, tier, toolCalls: [], inputTokens: 0, outputTokens: 0, costUsd: 0 };
    }
  }

  private async _callLLMViaBackendProxy(
    messages: any[],
    sessionId: string,
    turn: number,
    route: { provider: string; model: string; tier: ComplexityTier; maxTokens: number },
  ): Promise<{
    content: string; model: string; toolCalls: any[];
    provider: string; tier: ComplexityTier;
    inputTokens: number; outputTokens: number; costUsd: number;
  }> {
    const config = this.state.config;
    const started = Date.now();
    const base = this._ingestBase();
    const resp = await this._safeFetch(`${base}/api/v1/runtime-proxy/llm/infer`, {
      method: "POST",
      headers: this._ingestHeaders(),
      body: JSON.stringify({
        messages,
        provider: route.provider,
        model: route.model,
        max_tokens: route.maxTokens,
        temperature: 0.0,
        plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
        tier: route.tier,
        session_id: sessionId,
        turn,
        org_id: this.state.config.orgId || "",
        project_id: this.state.config.projectId || "",
        agent_name: this.state.config.agentName || "agentos",
      }),
    });
    const data = await resp.json() as any;
    const latency = Date.now() - started;

    this._recordEvent({
      sessionId,
      turn,
      eventType: "llm.call",
      action: "inference",
      plan: normalizePlan(config.plan || this.env.DEFAULT_PLAN),
      tier: route.tier,
      provider: String(data.provider || route.provider),
      model: String(data.model || route.model),
      status: resp.ok ? "ok" : "error",
      latencyMs: Number(data.latency_ms || latency),
      inputTokens: Number(data.input_tokens || 0),
      outputTokens: Number(data.output_tokens || 0),
      costUsd: Number(data.cost_usd || 0),
      details: resp.ok ? { source: "backend_proxy" } : { source: "backend_proxy", message: String(data.detail || "proxy error"), httpStatus: resp.status },
    });

    if (!resp.ok) {
      throw new Error(`backend_proxy_http_${resp.status}:${String(data.detail || "proxy error")}`);
    }

    return {
      content: String(data.content || ""),
      model: String(data.model || route.model),
      provider: String(data.provider || route.provider),
      tier: route.tier,
      toolCalls: Array.isArray(data.tool_calls) ? data.tool_calls : [],
      inputTokens: Number(data.input_tokens || 0),
      outputTokens: Number(data.output_tokens || 0),
      costUsd: Number(data.cost_usd || 0),
    };
  }

  private _resolveRoute(messages: any[]): (PlanRoute & { tier: ComplexityTier }) {
    const planName = normalizePlan(this.state.config.plan || this.env.DEFAULT_PLAN);
    if (planName === "manual" && this.state.config.provider && this.state.config.model) {
      return {
        provider: this.state.config.provider,
        model: this.state.config.model,
        tier: "moderate",
        maxTokens: 4096,
      };
    }

    const plan = PLAN_ROUTES[planName] || PLAN_ROUTES.standard;
    const tier = this._classifyComplexity(messages);
    const route = plan[tier] || plan.moderate;
    if (route.provider && route.model) return { ...route, tier };
    return {
      provider: this.env.DEFAULT_PROVIDER || "gmi",
      model: this.env.DEFAULT_MODEL || "deepseek-ai/DeepSeek-V3.2",
      tier,
      maxTokens: route.maxTokens || 4096,
    };
  }

  private _classifyComplexity(messages: any[]): ComplexityTier {
    const nonSystem = messages.filter((m: any) => m?.role !== "system");
    const last = nonSystem[nonSystem.length - 1];
    const recentToolMessage = nonSystem.slice(-4).some((m: any) => m?.role === "tool");
    if (recentToolMessage) return "tool_call";

    const text = String(last?.content || "").toLowerCase();
    const len = text.length;
    const hardSignals = [
      "architecture", "design", "compare", "trade-off", "migration",
      "optimize", "debug", "root cause", "multi-step", "refactor",
      "compliance", "security", "evaluate", "benchmark", "plan",
    ];
    const mediumSignals = [
      "summarize", "explain", "implement", "write", "analyze", "test",
    ];

    const hardHits = hardSignals.filter((s) => text.includes(s)).length;
    const mediumHits = mediumSignals.filter((s) => text.includes(s)).length;

    if (len > 900 || hardHits >= 2) return "complex";
    if (len > 240 || hardHits >= 1 || mediumHits >= 2) return "moderate";
    return "simple";
  }

  // ── Tool Execution ──────────────────────────────────────────────

  private async _executeTools(toolCalls: any[], sessionId: string, turn: number): Promise<any[]> {
    const results: any[] = [];
    for (const tc of toolCalls) {
      const name = tc.name || tc.function?.name || "";
      const args = tc.arguments || tc.input || tc.function?.arguments || {};
      const parsedArgs = typeof args === "string" ? JSON.parse(args) : args;
      const start = Date.now();

      try {
        const result = await this._runTool(name, parsedArgs, sessionId, turn);
        const latency = Date.now() - start;
        this._recordEvent({
          sessionId,
          turn,
          eventType: "tool.call",
          action: "execution",
          plan: normalizePlan(this.state.config.plan || this.env.DEFAULT_PLAN),
          toolName: name,
          status: "ok",
          latencyMs: latency,
          details: { args: parsedArgs },
        });
        results.push({ tool: name, result });
      } catch (err: any) {
        const latency = Date.now() - start;
        this._recordEvent({
          sessionId,
          turn,
          eventType: "tool.call",
          action: "execution",
          plan: normalizePlan(this.state.config.plan || this.env.DEFAULT_PLAN),
          toolName: name,
          status: "error",
          latencyMs: latency,
          details: { args: parsedArgs, error: String(err?.message || err) },
        });
        results.push({ tool: name, error: err.message });
      }
    }
    return results;
  }

  private _recordEvent(input: {
    sessionId: string;
    turn?: number;
    eventType: string;
    action?: string;
    plan?: string;
    tier?: string;
    provider?: string;
    model?: string;
    toolName?: string;
    status?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    details?: Record<string, unknown>;
  }): void {
    const turn = input.turn ?? 0;
    const action = input.action || "";
    const plan = input.plan || "";
    const tier = input.tier || "";
    const provider = input.provider || "";
    const model = input.model || "";
    const toolName = input.toolName || "";
    const status = input.status || "";
    const latencyMs = input.latencyMs || 0;
    const inputTokens = input.inputTokens || 0;
    const outputTokens = input.outputTokens || 0;
    const costUsd = input.costUsd || 0;
    const detailsJson = JSON.stringify(input.details || {});
    this.sql`INSERT INTO otel_events (
      session_id, turn, event_type, action, plan, tier, provider, model, tool_name, status, latency_ms,
      input_tokens, output_tokens, cost_usd, details_json
    ) VALUES (
      ${input.sessionId}, ${turn}, ${input.eventType}, ${action}, ${plan}, ${tier}, ${provider}, ${model}, ${toolName}, ${status}, ${latencyMs},
      ${inputTokens}, ${outputTokens}, ${costUsd}, ${detailsJson}
    )`;

    // Best-effort mirror of event telemetry to backend control plane.
    void this._sendIngest(
      "/api/v1/edge-ingest/events",
      {
        events: [{
          session_id: input.sessionId,
          turn,
          event_type: input.eventType,
          action,
          plan,
          tier,
          provider,
          model,
          tool_name: toolName,
          status,
          latency_ms: latencyMs,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: costUsd,
          details_json: detailsJson,
          created_at: Date.now() / 1000,
        }],
      },
    );
  }

  private _ingestHeaders(): Record<string, string> {
    const token = this.env.BACKEND_INGEST_TOKEN || "";
    if (!token) return { "Content-Type": "application/json" };
    return {
      "Content-Type": "application/json",
      "X-Edge-Token": token,
      "Authorization": `Bearer ${token}`,
    };
  }

  private _ingestBase(): string {
    return (this.env.BACKEND_INGEST_URL || "").trim().replace(/\/+$/, "");
  }

  private _isBackendProxyOnly(): boolean {
    const raw = String(this.env.BACKEND_PROXY_ONLY ?? "true").trim().toLowerCase();
    return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
  }

  private _assertEgressAllowed(targetUrl: string): void {
    if (!this._isBackendProxyOnly()) return;

    const backend = this._ingestBase();
    if (!backend) {
      throw new Error("backend_proxy_only_enabled_but_backend_ingest_url_missing");
    }

    const target = new URL(targetUrl);
    const backendUrl = new URL(backend);
    const isBackend = target.origin === backendUrl.origin;
    const isInternal = target.hostname === "internal" || target.hostname === "localhost" || target.hostname === "127.0.0.1";
    if (!isBackend && !isInternal) {
      throw new Error(`direct_egress_blocked:${target.origin}`);
    }
  }

  private async _safeFetch(input: string, init?: RequestInit): Promise<Response> {
    this._assertEgressAllowed(input);
    return fetch(input, init);
  }

  private async _postIngest(endpoint: string, payload: Record<string, unknown>): Promise<void> {
    const base = this._ingestBase();
    if (!base || !this.env.BACKEND_INGEST_TOKEN) {
      throw new Error("backend_ingest_not_configured");
    }
    const resp = await this._safeFetch(`${base}${endpoint}`, {
      method: "POST",
      headers: this._ingestHeaders(),
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`backend_ingest_http_${resp.status}`);
    }
  }

  private async _enqueueIngest(endpoint: string, payload: Record<string, unknown>, error: string): Promise<void> {
    this.sql`INSERT INTO ingest_outbox (endpoint, payload_json, attempts, next_retry_at, last_error, updated_at)
      VALUES (${endpoint}, ${JSON.stringify(payload)}, ${1}, ${Date.now() / 1000 + 5}, ${error.slice(0, 500)}, ${Date.now() / 1000})`;
  }

  private async _sendIngest(endpoint: string, payload: Record<string, unknown>): Promise<void> {
    const base = this._ingestBase();
    if (!base || !this.env.BACKEND_INGEST_TOKEN) return;
    try {
      await this._postIngest(endpoint, payload);
    } catch (err: any) {
      await this._enqueueIngest(endpoint, payload, String(err?.message || err));
    }
  }

  private async _flushIngestOutbox(limit: number = 50): Promise<void> {
    const base = this._ingestBase();
    if (!base || !this.env.BACKEND_INGEST_TOKEN) return;
    const now = Date.now() / 1000;
    const rows = this.sql<{ id: number; endpoint: string; payload_json: string; attempts: number }>`
      SELECT id, endpoint, payload_json, attempts
      FROM ingest_outbox
      WHERE next_retry_at <= ${now}
      ORDER BY id ASC
      LIMIT ${Math.max(1, Math.min(limit, 500))}
    `;
    for (const row of rows) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload_json || "{}");
      } catch {
        this.sql`DELETE FROM ingest_outbox WHERE id = ${row.id}`;
        continue;
      }
      try {
        await this._postIngest(row.endpoint, payload);
        this.sql`DELETE FROM ingest_outbox WHERE id = ${row.id}`;
      } catch (err: any) {
        const attempts = Math.max(1, Number(row.attempts || 0) + 1);
        const backoffSec = Math.min(300, 2 ** Math.min(attempts, 8));
        this.sql`UPDATE ingest_outbox
          SET attempts = ${attempts},
              next_retry_at = ${now + backoffSec},
              last_error = ${String(err?.message || err).slice(0, 500)},
              updated_at = ${now}
          WHERE id = ${row.id}`;
      }
    }
  }

  private async _mirrorEpisodeToBackend(episodePayload: Record<string, unknown>): Promise<void> {
    await this._sendIngest("/api/v1/edge-ingest/episode", episodePayload);
  }

  private async _mirrorVapiCallToBackend(callPayload: Record<string, unknown>): Promise<void> {
    await this._sendIngest("/api/v1/edge-ingest/vapi/call", callPayload);
  }

  private async _mirrorVapiEventToBackend(eventPayload: Record<string, unknown>): Promise<void> {
    await this._sendIngest("/api/v1/edge-ingest/vapi/event", eventPayload);
  }

  private async _mirrorTurnToBackend(sessionId: string, turnPayload: Record<string, unknown>): Promise<void> {
    await this._sendIngest("/api/v1/edge-ingest/turn", {
      session_id: sessionId,
      ...turnPayload,
    });
  }

  private async _mirrorSessionToBackend(sessionId: string, input: string, results: TurnResult[]): Promise<void> {
    const last = results[results.length - 1];
    const output = last?.content || "";
    const status = last?.error ? "error" : "success";
    const totalCost = results.reduce((acc, r) => acc + (r.costUsd || 0), 0);
    const model = last?.model || this.state.config.model || "";
    await this._sendIngest("/api/v1/edge-ingest/session", {
      session_id: sessionId,
      org_id: this.state.config.orgId || "",
      project_id: this.state.config.projectId || "",
      agent_name: this.state.config.agentName || "agentos",
      status,
      input_text: input,
      output_text: output,
      model,
      trace_id: sessionId,
      parent_session_id: "",
      depth: 0,
      step_count: results.length,
      action_count: results.reduce((acc, r) => acc + ((r.toolResults || []).length), 0),
      wall_clock_seconds: 0,
      cost_total_usd: totalCost,
      created_at: Date.now() / 1000,
    });
  }

  private async _runTool(name: string, args: any, sessionId: string, turn: number): Promise<string> {
    if (this._ingestBase() && this.env.BACKEND_INGEST_TOKEN) {
      return this._callToolViaBackendProxy(name, args, sessionId, turn);
    }

    switch (name) {
      case "web_search":
      case "web-search":
        return `Search results for: ${args.query} (implement with actual search API)`;

      case "vectorize_query":
      case "knowledge-search": {
        const embedding = await this.env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [args.query] }) as any;
        const results = await this.env.VECTORIZE.query(embedding.data[0], { topK: args.top_k || 5 });
        return JSON.stringify(results.matches);
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  private async _callToolViaBackendProxy(name: string, args: any, sessionId: string, turn: number): Promise<string> {
    const base = this._ingestBase();
    const resp = await this._safeFetch(`${base}/api/v1/runtime-proxy/tool/call`, {
      method: "POST",
      headers: this._ingestHeaders(),
      body: JSON.stringify({
        tool: name,
        args: args || {},
        session_id: sessionId,
        turn,
        org_id: this.state.config.orgId || "",
        project_id: this.state.config.projectId || "",
        agent_name: this.state.config.agentName || "agentos",
      }),
    });
    const data = await resp.json() as any;
    if (!resp.ok) {
      throw new Error(String(data.detail || `tool_proxy_http_${resp.status}`));
    }
    return String(data.output || "");
  }
}

// Backward-compatibility export for previously deployed Durable Object class name.
// Some existing Cloudflare deployments reference AgentOSWorker in prior migrations.
export class AgentOSWorker extends AgentOSAgent {}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifyHs256Jwt(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlToBytes(signatureB64);
    const valid = await crypto.subtle.verify("HMAC", key, signature, signingInput);
    if (!valid) return false;
    const payloadRaw = new TextDecoder().decode(base64UrlToBytes(payloadB64));
    const payload = JSON.parse(payloadRaw) as { exp?: number };
    if (payload.exp && Date.now() / 1000 > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MCP Server Agent — exposes tools via Model Context Protocol
// ---------------------------------------------------------------------------

export class AgentOSMcpServer extends McpAgent<Env> {
  async onStart() {
    // MCP tools are registered here
  }

  async onRequest(request: Request): Promise<Response> {
    // MCP JSON-RPC handler
    if (request.method === "POST") {
      const body = await request.json() as any;
      const method = body.method;

      if (method === "initialize") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "agentos-mcp", version: "0.2.0" },
          },
        });
      }

      if (method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            tools: [
              {
                name: "run-agent",
                description: "Run an AgentOS agent on a task",
                inputSchema: {
                  type: "object",
                  properties: {
                    agent_name: { type: "string", description: "Agent name" },
                    task: { type: "string", description: "Task to execute" },
                  },
                  required: ["task"],
                },
              },
              {
                name: "search-knowledge",
                description: "Search the agent's knowledge base",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "Search query" },
                  },
                  required: ["query"],
                },
              },
            ],
          },
        });
      }

      if (method === "tools/call") {
        const toolName = body.params?.name;
        const args = body.params?.arguments || {};

        if (toolName === "run-agent") {
          // Delegate to the main agent
          const agentId = this.env.AGENTOS_AGENT.idFromName(args.agent_name || "default");
          const agent = this.env.AGENTOS_AGENT.get(agentId);
          const resp = await agent.fetch(new Request("http://internal/run", {
            method: "POST",
            body: JSON.stringify({ input: args.task }),
          }));
          const result = await resp.json();
          return Response.json({
            jsonrpc: "2.0", id: body.id,
            result: { content: [{ type: "text", text: JSON.stringify(result) }] },
          });
        }

        if (toolName === "search-knowledge") {
          const query = String(args.query || "");
          if (!query.trim()) {
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: { content: [{ type: "text", text: "query is required" }], isError: true },
            });
          }
          try {
            const agentId = this.env.AGENTOS_AGENT.idFromName("default");
            const agent = this.env.AGENTOS_AGENT.get(agentId);
            const resp = await agent.fetch(new Request("http://internal/run", {
              method: "POST",
              body: JSON.stringify({ input: `Use knowledge search for: ${query}` }),
            }));
            const result = await resp.json();
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify(result) }] },
            });
          } catch (err: any) {
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: {
                content: [{ type: "text", text: `search-knowledge failed: ${err?.message || err}` }],
                isError: true,
              },
            });
          }
        }

        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: `Unknown tool: ${toolName}` }] },
        });
      }

      return Response.json({
        jsonrpc: "2.0", id: body.id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }

    return new Response("MCP Server — POST JSON-RPC requests here", { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Worker entry point — routes to agents
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Route agent requests: /agents/:agent-name/:instance-name
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "0.2.0" });
    }

    // Serve static assets (portal SPA)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
