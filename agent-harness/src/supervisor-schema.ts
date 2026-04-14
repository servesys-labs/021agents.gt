/**
 * AgentSupervisor SQLite Schema — comprehensive telemetry for Meta Agent.
 *
 * Maps to the 001_init.sql schema sections, adapted for DO SQLite:
 * - Agents (config, skills, channels, visibility)
 * - Sessions (per-run cost, tokens, timing, status)
 * - Turns (per-turn model, tokens, latency, tool calls, errors)
 * - Tool Executions (per-tool input/output/latency/error)
 * - Conversation Log (user message → agent response + feedback)
 * - Agent Metrics (daily aggregated health scores)
 * - Events (OTEL events, runtime events, signals)
 * - Security (scan findings, guardrail activations)
 * - Delegation (agent-to-agent task tracking)
 *
 * The Meta Agent queries ALL of these tables to understand agent health,
 * find failures, suggest improvements, and generate reports.
 */

export const SUPERVISOR_SCHEMA = `
-- ── Agents ──
CREATE TABLE IF NOT EXISTS agents (
  agent_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  icon            TEXT DEFAULT '✦',
  description     TEXT DEFAULT '',
  system_prompt   TEXT NOT NULL,
  model           TEXT DEFAULT '@cf/moonshotai/kimi-k2.5',
  skills          TEXT DEFAULT '[]',
  channels        TEXT DEFAULT '[]',
  visibility      TEXT DEFAULT 'org' CHECK (visibility IN ('org', 'private', 'public')),
  created_by      TEXT DEFAULT '',
  enable_sandbox  INTEGER DEFAULT 0,
  version         TEXT DEFAULT '1.0.0',
  config          TEXT DEFAULT '{}',
  status          TEXT DEFAULT 'active',
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ── Sessions (one per agent run) ──
CREATE TABLE IF NOT EXISTS sessions (
  session_id          TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL,
  channel             TEXT DEFAULT 'web',
  user_id             TEXT DEFAULT '',
  model               TEXT DEFAULT '',
  status              TEXT DEFAULT 'running',
  input_text          TEXT DEFAULT '',
  output_text         TEXT DEFAULT '',
  input_tokens        INTEGER DEFAULT 0,
  output_tokens       INTEGER DEFAULT 0,
  cost_usd            REAL DEFAULT 0,
  wall_clock_ms       INTEGER DEFAULT 0,
  step_count          INTEGER DEFAULT 0,
  tool_call_count     INTEGER DEFAULT 0,
  error_count         INTEGER DEFAULT 0,
  termination_reason  TEXT,
  trace_id            TEXT,
  parent_session_id   TEXT,
  depth               INTEGER DEFAULT 0,
  created_at          TEXT DEFAULT (datetime('now')),
  ended_at            TEXT
);

-- ── Turns (one per LLM call within a session) ──
CREATE TABLE IF NOT EXISTS turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  turn_number     INTEGER NOT NULL,
  model_used      TEXT DEFAULT '',
  role            TEXT DEFAULT 'assistant',
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  latency_ms      INTEGER DEFAULT 0,
  llm_latency_ms  INTEGER DEFAULT 0,
  ttft_ms         INTEGER DEFAULT 0,
  tool_calls      TEXT DEFAULT '[]',
  errors          TEXT DEFAULT '[]',
  cost_usd        REAL DEFAULT 0,
  stop_reason     TEXT,
  refusal         INTEGER DEFAULT 0,
  cache_read_tokens  INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  compaction_triggered INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE (session_id, turn_number)
);

-- ── Tool Executions (one per tool call) ──
CREATE TABLE IF NOT EXISTS tool_executions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  turn_number INTEGER,
  tool_name   TEXT NOT NULL,
  input       TEXT DEFAULT '{}',
  output      TEXT DEFAULT '{}',
  latency_ms  INTEGER DEFAULT 0,
  cost_usd    REAL DEFAULT 0,
  error       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ── Conversation Log (message-level, for Meta Agent analysis) ──
CREATE TABLE IF NOT EXISTS conversation_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL,
  session_id      TEXT,
  channel         TEXT DEFAULT 'web',
  user_id         TEXT DEFAULT '',
  user_message    TEXT NOT NULL,
  agent_response  TEXT NOT NULL,
  tool_calls_used TEXT DEFAULT '[]',
  response_ms     INTEGER DEFAULT 0,
  cost_usd        REAL DEFAULT 0,
  feedback        TEXT DEFAULT '',
  feedback_rating INTEGER,
  sentiment       TEXT DEFAULT '',
  quality_score   REAL DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now'))
);

-- ── Agent Metrics (daily aggregated, for dashboards) ──
CREATE TABLE IF NOT EXISTS agent_metrics (
  agent_id            TEXT NOT NULL,
  date                TEXT NOT NULL,
  conversations       INTEGER DEFAULT 0,
  messages            INTEGER DEFAULT 0,
  tool_calls          INTEGER DEFAULT 0,
  errors              INTEGER DEFAULT 0,
  avg_response_ms     REAL DEFAULT 0,
  total_cost_usd      REAL DEFAULT 0,
  satisfaction_avg    REAL DEFAULT 0,
  satisfaction_count  INTEGER DEFAULT 0,
  unique_users        INTEGER DEFAULT 0,
  PRIMARY KEY (agent_id, date)
);

-- ── OTEL Events (structured telemetry from runtime) ──
CREATE TABLE IF NOT EXISTS otel_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT,
  session_id  TEXT,
  trace_id    TEXT,
  span_id     TEXT,
  event_type  TEXT NOT NULL,
  event_data  TEXT DEFAULT '{}',
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ── Runtime Events (LLM, tools, memory, signals, approvals) ──
CREATE TABLE IF NOT EXISTS runtime_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT,
  event_type  TEXT NOT NULL,
  event_data  TEXT DEFAULT '{}',
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ── Delegation Events (agent-to-agent) ──
CREATE TABLE IF NOT EXISTS delegation_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_session_id   TEXT,
  child_session_id    TEXT,
  parent_agent_name   TEXT DEFAULT '',
  child_agent_name    TEXT DEFAULT '',
  parent_trace_id     TEXT,
  child_trace_id      TEXT,
  depth               INTEGER DEFAULT 0,
  status              TEXT DEFAULT '',
  child_cost_usd      REAL DEFAULT 0,
  input_preview       TEXT DEFAULT '',
  output_preview      TEXT DEFAULT '',
  created_at          TEXT DEFAULT (datetime('now')),
  completed_at        TEXT
);

-- ── Security Events ──
CREATE TABLE IF NOT EXISTS security_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT,
  event_type  TEXT NOT NULL,
  severity    TEXT DEFAULT 'info',
  details     TEXT DEFAULT '{}',
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ── Guardrail Events ──
CREATE TABLE IF NOT EXISTS guardrail_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT,
  rule_name   TEXT NOT NULL,
  action      TEXT NOT NULL,
  input_preview TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ── Session Feedback ──
CREATE TABLE IF NOT EXISTS session_feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  rating      INTEGER CHECK (rating >= 1 AND rating <= 5),
  feedback    TEXT DEFAULT '',
  user_id     TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_session ON tool_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_name ON tool_executions(tool_name);
CREATE INDEX IF NOT EXISTS idx_conv_log_agent ON conversation_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_conv_log_created ON conversation_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otel_agent ON otel_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_otel_session ON otel_events(session_id);
CREATE INDEX IF NOT EXISTS idx_otel_type ON otel_events(event_type);
CREATE INDEX IF NOT EXISTS idx_runtime_type ON runtime_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_agent ON security_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_feedback_agent ON session_feedback(agent_id);
CREATE INDEX IF NOT EXISTS idx_metrics_date ON agent_metrics(date DESC);
`;
