"""SQLite database — the agent's single-file persistent brain.

Why SQLite:
  - Zero dependencies (Python stdlib)
  - Single file (data/agent.db) — deploys with the agent
  - WAL mode — concurrent readers + single writer, no corruption
  - Indexes — query sessions by agent_id, timestamp, status
  - Atomic transactions — no half-written data on crash
  - Cloudflare D1 compatible — same schema works at the edge

Schema covers:
  - Sessions & turns (replaces sessions.jsonl)
  - Evolution ledger (replaces ledger.json)
  - Proposals / review queue (replaces proposals.json)
  - Memory tiers: episodes, facts, procedures (previously RAM-only)
  - Cost ledger (persistent cost tracking)
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

logger = logging.getLogger(__name__)

# Current schema version — bump when you add migrations
SCHEMA_VERSION = 4

# ── Schema DDL ───────────────────────────────────────────────────────────────

SCHEMA_SQL = """\
-- Schema version tracking
CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════════
-- SESSIONS — replaces sessions.jsonl
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sessions (
    session_id          TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL DEFAULT '',
    agent_name          TEXT NOT NULL DEFAULT '',
    agent_version       TEXT NOT NULL DEFAULT '',
    model               TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'unknown',  -- success/error/timeout
    stop_reason         TEXT NOT NULL DEFAULT 'completed',
    is_finished         INTEGER NOT NULL DEFAULT 0,
    error_attribution   TEXT,
    step_count          INTEGER NOT NULL DEFAULT 0,
    action_count        INTEGER NOT NULL DEFAULT 0,
    time_to_first_action_ms REAL NOT NULL DEFAULT 0.0,
    wall_clock_seconds  REAL NOT NULL DEFAULT 0.0,
    input_text          TEXT NOT NULL DEFAULT '',
    output_text         TEXT NOT NULL DEFAULT '',
    -- Cost breakdown
    cost_llm_input_usd  REAL NOT NULL DEFAULT 0.0,
    cost_llm_output_usd REAL NOT NULL DEFAULT 0.0,
    cost_tool_usd       REAL NOT NULL DEFAULT 0.0,
    cost_total_usd      REAL NOT NULL DEFAULT 0.0,
    -- Benchmark cost (eval infrastructure — grader LLM calls, etc.)
    benchmark_cost_llm_input_usd  REAL NOT NULL DEFAULT 0.0,
    benchmark_cost_llm_output_usd REAL NOT NULL DEFAULT 0.0,
    benchmark_cost_tool_usd       REAL NOT NULL DEFAULT 0.0,
    benchmark_cost_total_usd      REAL NOT NULL DEFAULT 0.0,
    -- Composition snapshot (JSON blob for tools, memory, governance)
    composition_json    TEXT NOT NULL DEFAULT '{}',
    -- Session semantics (EEE agentic extensions)
    finish_accepted     INTEGER,  -- NULL=unknown, 0=rejected, 1=accepted
    stop_initiated_by   TEXT NOT NULL DEFAULT '',  -- agent/benchmark/infrastructure
    -- Eval fields
    eval_score          REAL,
    eval_passed         INTEGER,
    eval_task_name      TEXT NOT NULL DEFAULT '',
    -- Eval conditions (queryable columns, not buried in JSON)
    eval_conditions_json TEXT NOT NULL DEFAULT '{}',
    -- Trace chain (for sub-agent observability and audit)
    trace_id            TEXT NOT NULL DEFAULT '',  -- links all sessions in a chain
    parent_session_id   TEXT NOT NULL DEFAULT '',  -- which session spawned this one
    depth               INTEGER NOT NULL DEFAULT 0,  -- 0=root, 1=sub-agent, 2=sub-sub-agent
    -- Timestamps
    created_at          REAL NOT NULL DEFAULT (unixepoch('now')),
    ended_at            REAL
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_name ON sessions(agent_name);
CREATE INDEX IF NOT EXISTS idx_sessions_trace_id ON sessions(trace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- TURNS — per-turn detail within a session
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(session_id),
    turn_number     INTEGER NOT NULL,
    model_used      TEXT NOT NULL DEFAULT '',
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    latency_ms      REAL NOT NULL DEFAULT 0.0,
    llm_content     TEXT NOT NULL DEFAULT '',
    -- Cost for this turn
    cost_llm_input_usd  REAL NOT NULL DEFAULT 0.0,
    cost_llm_output_usd REAL NOT NULL DEFAULT 0.0,
    cost_tool_usd       REAL NOT NULL DEFAULT 0.0,
    cost_total_usd      REAL NOT NULL DEFAULT 0.0,
    -- Tool calls/results as JSON arrays
    tool_calls_json     TEXT NOT NULL DEFAULT '[]',
    tool_results_json   TEXT NOT NULL DEFAULT '[]',
    errors_json         TEXT NOT NULL DEFAULT '[]',
    -- Timestamps
    started_at          REAL NOT NULL DEFAULT (unixepoch('now')),
    ended_at            REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- ERRORS — structured error log (queryable across sessions)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS errors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(session_id),
    source      TEXT NOT NULL,  -- llm/tool/governance/memory/timeout/unknown
    message     TEXT NOT NULL,
    tool_name   TEXT,
    turn        INTEGER NOT NULL DEFAULT 0,
    recoverable INTEGER NOT NULL DEFAULT 1,
    created_at  REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_errors_session ON errors(session_id);
CREATE INDEX IF NOT EXISTS idx_errors_source ON errors(source);

-- ═══════════════════════════════════════════════════════════════════════════
-- EVOLUTION LEDGER — replaces ledger.json
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS evolution_entries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    version           TEXT NOT NULL,
    previous_version  TEXT NOT NULL,
    proposal_id       TEXT NOT NULL DEFAULT '',
    proposal_title    TEXT NOT NULL DEFAULT '',
    category          TEXT NOT NULL DEFAULT '',
    modification_json TEXT NOT NULL DEFAULT '{}',
    previous_config_json TEXT NOT NULL DEFAULT '{}',
    new_config_json   TEXT NOT NULL DEFAULT '{}',
    reviewer          TEXT NOT NULL DEFAULT '',
    reviewer_note     TEXT NOT NULL DEFAULT '',
    metrics_before_json TEXT NOT NULL DEFAULT '{}',
    metrics_after_json  TEXT NOT NULL DEFAULT '{}',
    impact_json       TEXT NOT NULL DEFAULT '{}',
    created_at        REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_evo_version ON evolution_entries(version);

-- ═══════════════════════════════════════════════════════════════════════════
-- PROPOSALS — replaces proposals.json
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS proposals (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL DEFAULT '',
    rationale       TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT '',
    modification_json TEXT NOT NULL DEFAULT '{}',
    priority        REAL NOT NULL DEFAULT 0.0,
    evidence_json   TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending',
    surfaced        INTEGER NOT NULL DEFAULT 0,
    applied_version TEXT NOT NULL DEFAULT '',
    reviewer_note   TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    reviewed_at     REAL
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_priority ON proposals(priority);

-- ═══════════════════════════════════════════════════════════════════════════
-- MEMORY: EPISODES — replaces in-memory list (now persistent)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS episodes (
    id          TEXT PRIMARY KEY,
    input       TEXT NOT NULL DEFAULT '',
    output      TEXT NOT NULL DEFAULT '',
    outcome     TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at  REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- MEMORY: FACTS (semantic) — replaces in-memory dict (now persistent)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS facts (
    key         TEXT PRIMARY KEY,
    value_json  TEXT NOT NULL DEFAULT '""',
    embedding_json TEXT NOT NULL DEFAULT '[]',
    metadata_json  TEXT NOT NULL DEFAULT '{}',
    created_at  REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at  REAL NOT NULL DEFAULT (unixepoch('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════
-- MEMORY: PROCEDURES — replaces in-memory dict (now persistent)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS procedures (
    name            TEXT PRIMARY KEY,
    description     TEXT NOT NULL DEFAULT '',
    steps_json      TEXT NOT NULL DEFAULT '[]',
    success_count   INTEGER NOT NULL DEFAULT 0,
    failure_count   INTEGER NOT NULL DEFAULT 0,
    last_used       REAL NOT NULL DEFAULT (unixepoch('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════
-- COST LEDGER — persistent cost tracking per session
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cost_ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL DEFAULT '',
    agent_name  TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL NOT NULL DEFAULT 0.0,
    created_at  REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_cost_agent ON cost_ledger(agent_id);
CREATE INDEX IF NOT EXISTS idx_cost_created ON cost_ledger(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- BILLING — customer billing aggregation for charging
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS billing_records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Who
    org_id          TEXT NOT NULL DEFAULT '',
    customer_id     TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    -- What
    cost_type       TEXT NOT NULL DEFAULT 'inference',  -- inference / gpu_compute / tool / eval
    description     TEXT NOT NULL DEFAULT '',
    -- Inference costs
    model           TEXT NOT NULL DEFAULT '',
    provider        TEXT NOT NULL DEFAULT '',
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    inference_cost_usd REAL NOT NULL DEFAULT 0.0,
    -- GPU compute costs (dedicated endpoints)
    gpu_type        TEXT NOT NULL DEFAULT '',  -- h100 / h200 / '' for serverless
    gpu_hours       REAL NOT NULL DEFAULT 0.0,
    gpu_cost_usd    REAL NOT NULL DEFAULT 0.0,
    -- Total
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    -- Trace
    session_id      TEXT NOT NULL DEFAULT '',
    trace_id        TEXT NOT NULL DEFAULT '',
    -- Time
    period_start    REAL,   -- billing period start
    period_end      REAL,   -- billing period end
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_billing_org ON billing_records(org_id);
CREATE INDEX IF NOT EXISTS idx_billing_customer ON billing_records(customer_id);
CREATE INDEX IF NOT EXISTS idx_billing_created ON billing_records(created_at);
CREATE INDEX IF NOT EXISTS idx_billing_type ON billing_records(cost_type);

-- ═══════════════════════════════════════════════════════════════════════════
-- GPU ENDPOINTS — dedicated GPU endpoint tracking
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gpu_endpoints (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id     TEXT NOT NULL UNIQUE,  -- GMI task/endpoint ID
    org_id          TEXT NOT NULL DEFAULT '',
    -- Config
    provider        TEXT NOT NULL DEFAULT 'gmi',
    gpu_type        TEXT NOT NULL DEFAULT 'h100',  -- h100 / h200
    gpu_count       INTEGER NOT NULL DEFAULT 1,
    model_id        TEXT NOT NULL DEFAULT '',
    api_base        TEXT NOT NULL DEFAULT '',  -- dedicated endpoint URL
    -- Status
    status          TEXT NOT NULL DEFAULT 'provisioning',  -- provisioning / running / stopped / terminated
    hourly_rate_usd REAL NOT NULL DEFAULT 2.98,
    -- Time tracking
    started_at      REAL,
    stopped_at      REAL,
    total_hours     REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    -- Metadata
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_gpu_endpoint_id ON gpu_endpoints(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_gpu_org ON gpu_endpoints(org_id);
CREATE INDEX IF NOT EXISTS idx_gpu_status ON gpu_endpoints(status);

-- ═══════════════════════════════════════════════════════════════════════════
-- EVAL RUNS — aggregate eval reports (one row per `agentos eval` invocation)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS eval_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name      TEXT NOT NULL DEFAULT '',
    agent_version   TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    benchmark_name  TEXT NOT NULL DEFAULT '',
    benchmark_version TEXT NOT NULL DEFAULT '',
    grader_type     TEXT NOT NULL DEFAULT '',
    protocol        TEXT NOT NULL DEFAULT 'agentos',
    -- Aggregate metrics
    total_tasks     INTEGER NOT NULL DEFAULT 0,
    total_trials    INTEGER NOT NULL DEFAULT 0,
    pass_count      INTEGER NOT NULL DEFAULT 0,
    fail_count      INTEGER NOT NULL DEFAULT 0,
    error_count     INTEGER NOT NULL DEFAULT 0,
    pass_rate       REAL NOT NULL DEFAULT 0.0,
    avg_score       REAL NOT NULL DEFAULT 0.0,
    avg_latency_ms  REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    benchmark_cost_usd REAL NOT NULL DEFAULT 0.0,
    avg_tool_calls  REAL NOT NULL DEFAULT 0.0,
    tool_efficiency REAL NOT NULL DEFAULT 1.0,
    pass_at_1       REAL,
    pass_at_3       REAL,
    -- Eval conditions
    eval_conditions_json TEXT NOT NULL DEFAULT '{}',
    -- Timestamps
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_agent ON eval_runs(agent_name);
CREATE INDEX IF NOT EXISTS idx_eval_runs_created ON eval_runs(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- SPANS — structured trace spans with parent-child hierarchy
-- "Traces are the source of truth for agents" — Mikyo King, Arize AI
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS spans (
    span_id         TEXT PRIMARY KEY,
    trace_id        TEXT NOT NULL,
    parent_span_id  TEXT,
    session_id      TEXT,
    name            TEXT NOT NULL DEFAULT '',
    kind            TEXT NOT NULL DEFAULT '',  -- session/turn/llm/tool/sub_agent/memory/governance
    status          TEXT NOT NULL DEFAULT 'ok',
    start_time      REAL NOT NULL DEFAULT 0.0,
    end_time        REAL NOT NULL DEFAULT 0.0,
    duration_ms     REAL NOT NULL DEFAULT 0.0,
    attributes_json TEXT NOT NULL DEFAULT '{}',
    events_json     TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id);
CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- FEEDBACK — human feedback on agent outputs (thumbs up/down, corrections)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS feedback (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    turn_number     INTEGER,
    rating          INTEGER NOT NULL DEFAULT 0,  -- -1=bad, 0=neutral, 1=good
    correction      TEXT NOT NULL DEFAULT '',     -- Human-provided corrected output
    comment         TEXT NOT NULL DEFAULT '',     -- Free-text feedback
    tags            TEXT NOT NULL DEFAULT '[]',   -- JSON array of tags
    source          TEXT NOT NULL DEFAULT 'human', -- human/auto/llm
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
"""

# ── Migration from v1 → v2 ─────────────────────────────────────────────────

MIGRATION_V1_TO_V2 = """\
-- Add benchmark cost columns to sessions
ALTER TABLE sessions ADD COLUMN benchmark_cost_llm_input_usd REAL NOT NULL DEFAULT 0.0;
ALTER TABLE sessions ADD COLUMN benchmark_cost_llm_output_usd REAL NOT NULL DEFAULT 0.0;
ALTER TABLE sessions ADD COLUMN benchmark_cost_tool_usd REAL NOT NULL DEFAULT 0.0;
ALTER TABLE sessions ADD COLUMN benchmark_cost_total_usd REAL NOT NULL DEFAULT 0.0;

-- Add session semantics columns
ALTER TABLE sessions ADD COLUMN finish_accepted INTEGER;
ALTER TABLE sessions ADD COLUMN stop_initiated_by TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN eval_conditions_json TEXT NOT NULL DEFAULT '{}';

-- Create eval_runs table
CREATE TABLE IF NOT EXISTS eval_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name      TEXT NOT NULL DEFAULT '',
    agent_version   TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    benchmark_name  TEXT NOT NULL DEFAULT '',
    benchmark_version TEXT NOT NULL DEFAULT '',
    grader_type     TEXT NOT NULL DEFAULT '',
    protocol        TEXT NOT NULL DEFAULT 'agentos',
    total_tasks     INTEGER NOT NULL DEFAULT 0,
    total_trials    INTEGER NOT NULL DEFAULT 0,
    pass_count      INTEGER NOT NULL DEFAULT 0,
    fail_count      INTEGER NOT NULL DEFAULT 0,
    error_count     INTEGER NOT NULL DEFAULT 0,
    pass_rate       REAL NOT NULL DEFAULT 0.0,
    avg_score       REAL NOT NULL DEFAULT 0.0,
    avg_latency_ms  REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    benchmark_cost_usd REAL NOT NULL DEFAULT 0.0,
    avg_tool_calls  REAL NOT NULL DEFAULT 0.0,
    tool_efficiency REAL NOT NULL DEFAULT 1.0,
    pass_at_1       REAL,
    pass_at_3       REAL,
    eval_conditions_json TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_agent ON eval_runs(agent_name);
CREATE INDEX IF NOT EXISTS idx_eval_runs_created ON eval_runs(created_at);
"""

# ── Migration from v2 → v3 (portal tables) ────────────────────────────────

MIGRATION_V2_TO_V3 = """\
CREATE TABLE IF NOT EXISTS users (
    user_id         TEXT PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL DEFAULT '',
    password_hash   TEXT NOT NULL DEFAULT '',
    provider        TEXT NOT NULL DEFAULT 'email',
    avatar_url      TEXT NOT NULL DEFAULT '',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS orgs (
    org_id          TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    owner_user_id   TEXT NOT NULL,
    plan            TEXT NOT NULL DEFAULT 'free',
    stripe_customer_id  TEXT NOT NULL DEFAULT '',
    stripe_subscription_id TEXT NOT NULL DEFAULT '',
    settings_json   TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_orgs_slug ON orgs(slug);

CREATE TABLE IF NOT EXISTS org_members (
    org_id          TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member',
    invited_by      TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
    key_id          TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    user_id         TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL DEFAULT '',
    key_prefix      TEXT NOT NULL DEFAULT '',
    key_hash        TEXT NOT NULL,
    scopes          TEXT NOT NULL DEFAULT '["*"]',
    last_used_at    REAL,
    expires_at      REAL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(org_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS webhooks (
    webhook_id      TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    url             TEXT NOT NULL,
    secret          TEXT NOT NULL DEFAULT '',
    events          TEXT NOT NULL DEFAULT '["*"]',
    is_active       INTEGER NOT NULL DEFAULT 1,
    last_triggered_at REAL,
    failure_count   INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(org_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id      TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    payload_json    TEXT NOT NULL DEFAULT '{}',
    response_status INTEGER,
    response_body   TEXT NOT NULL DEFAULT '',
    duration_ms     REAL NOT NULL DEFAULT 0.0,
    success         INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE TABLE IF NOT EXISTS agent_versions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL,
    version         TEXT NOT NULL,
    config_json     TEXT NOT NULL,
    created_by      TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    UNIQUE(agent_name, version)
);
CREATE INDEX IF NOT EXISTS idx_agent_versions_name ON agent_versions(agent_name);
"""


# ── Migration from v3 → v4 (control plane) ─────────────────────────────────

MIGRATION_V3_TO_V4 = """\
-- PROJECTS — org → project → agents hierarchy
CREATE TABLE IF NOT EXISTS projects (
    project_id      TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    default_env     TEXT NOT NULL DEFAULT 'development',
    default_plan    TEXT NOT NULL DEFAULT 'standard',
    settings_json   TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);

-- ENVIRONMENTS — dev/staging/production per project
CREATE TABLE IF NOT EXISTS environments (
    env_id          TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL DEFAULT 'development',  -- development/staging/production
    plan            TEXT NOT NULL DEFAULT '',              -- LLM plan for this env
    provider_config_json TEXT NOT NULL DEFAULT '{}',       -- provider overrides per env
    secrets_json    TEXT NOT NULL DEFAULT '{}',            -- encrypted secret refs
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_env_project ON environments(project_id);

-- AUDIT LOG — who changed what, when
CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    project_id      TEXT NOT NULL DEFAULT '',
    user_id         TEXT NOT NULL DEFAULT '',
    action          TEXT NOT NULL,          -- agent.create, agent.update, policy.change, etc.
    resource_type   TEXT NOT NULL DEFAULT '', -- agent, policy, env, schedule, etc.
    resource_id     TEXT NOT NULL DEFAULT '',
    changes_json    TEXT NOT NULL DEFAULT '{}',  -- before/after diff
    ip_address      TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

-- EVENT DEFINITIONS — structured webhook event taxonomy
CREATE TABLE IF NOT EXISTS event_types (
    event_type      TEXT PRIMARY KEY,      -- run.started, run.completed, run.failed, etc.
    category        TEXT NOT NULL DEFAULT '', -- run, agent, policy, billing, system
    description     TEXT NOT NULL DEFAULT '',
    schema_json     TEXT NOT NULL DEFAULT '{}',  -- JSON schema for event payload
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

-- POLICY TEMPLATES — reusable governance configurations
CREATE TABLE IF NOT EXISTS policy_templates (
    policy_id       TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    policy_json     TEXT NOT NULL DEFAULT '{}',  -- budget, tools, domains, approval rules
    is_default      INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_policy_org ON policy_templates(org_id);

-- SLO DEFINITIONS — success rate, latency, cost thresholds
CREATE TABLE IF NOT EXISTS slo_definitions (
    slo_id          TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',  -- '' = org-wide default
    env             TEXT NOT NULL DEFAULT '',  -- '' = all envs
    metric          TEXT NOT NULL,             -- success_rate, p95_latency_ms, cost_per_run_usd
    threshold       REAL NOT NULL,             -- e.g., 0.95, 2000, 0.05
    operator        TEXT NOT NULL DEFAULT 'gte', -- gte, lte, eq
    window_hours    INTEGER NOT NULL DEFAULT 24,
    alert_on_breach INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_slo_org ON slo_definitions(org_id);
CREATE INDEX IF NOT EXISTS idx_slo_agent ON slo_definitions(agent_name);

-- RELEASE CHANNELS — draft/staging/production per agent
CREATE TABLE IF NOT EXISTS release_channels (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL,
    channel         TEXT NOT NULL DEFAULT 'draft',  -- draft/staging/production
    version         TEXT NOT NULL,
    config_json     TEXT NOT NULL,
    promoted_by     TEXT NOT NULL DEFAULT '',
    promoted_at     REAL,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    UNIQUE(agent_name, channel)
);
CREATE INDEX IF NOT EXISTS idx_release_agent ON release_channels(agent_name);

-- CANARY SPLITS — traffic routing between versions
CREATE TABLE IF NOT EXISTS canary_splits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name      TEXT NOT NULL,
    env             TEXT NOT NULL DEFAULT 'production',
    primary_version TEXT NOT NULL,
    canary_version  TEXT NOT NULL,
    canary_weight   REAL NOT NULL DEFAULT 0.1,  -- 0.0 to 1.0
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

-- JOB QUEUE — async agent runs with retries
CREATE TABLE IF NOT EXISTS job_queue (
    job_id          TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL,
    task            TEXT NOT NULL,
    idempotency_key TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending/running/completed/failed/dead
    priority        INTEGER NOT NULL DEFAULT 0,
    retries         INTEGER NOT NULL DEFAULT 0,
    max_retries     INTEGER NOT NULL DEFAULT 3,
    result_json     TEXT NOT NULL DEFAULT '{}',
    error           TEXT NOT NULL DEFAULT '',
    session_id      TEXT NOT NULL DEFAULT '',
    scheduled_at    REAL,
    started_at      REAL,
    completed_at    REAL,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_status ON job_queue(status);
CREATE INDEX IF NOT EXISTS idx_job_agent ON job_queue(agent_name);
CREATE INDEX IF NOT EXISTS idx_job_idempotency ON job_queue(idempotency_key);

-- WORKFLOW DEFINITIONS — multi-agent DAGs
CREATE TABLE IF NOT EXISTS workflows (
    workflow_id     TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    steps_json      TEXT NOT NULL DEFAULT '[]',  -- ordered list of {agent, task, depends_on, condition}
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_org ON workflows(org_id);

-- WORKFLOW RUNS — execution instances of workflows
CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id          TEXT PRIMARY KEY,
    workflow_id     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'running',  -- running/completed/failed/canceled
    steps_status_json TEXT NOT NULL DEFAULT '{}',     -- per-step status
    trace_id        TEXT NOT NULL DEFAULT '',
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    started_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    completed_at    REAL
);
CREATE INDEX IF NOT EXISTS idx_wfrun_workflow ON workflow_runs(workflow_id);

-- RETENTION POLICIES — data lifecycle management
CREATE TABLE IF NOT EXISTS retention_policies (
    policy_id       TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    resource_type   TEXT NOT NULL,         -- sessions, turns, episodes, billing_records
    retention_days  INTEGER NOT NULL DEFAULT 90,
    redact_pii      INTEGER NOT NULL DEFAULT 0,
    redact_fields   TEXT NOT NULL DEFAULT '[]',  -- JSON array of field names to redact
    archive_before_delete INTEGER NOT NULL DEFAULT 1,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_retention_org ON retention_policies(org_id);

-- SECRETS VAULT — org/project/env scoped secrets
CREATE TABLE IF NOT EXISTS secrets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    project_id      TEXT NOT NULL DEFAULT '',
    env             TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    value_encrypted TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    UNIQUE(org_id, project_id, env, name)
);
CREATE INDEX IF NOT EXISTS idx_secrets_org ON secrets(org_id);

-- MCP SERVERS — registered MCP server connections
CREATE TABLE IF NOT EXISTS mcp_servers (
    server_id       TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    url             TEXT NOT NULL DEFAULT '',
    transport       TEXT NOT NULL DEFAULT 'stdio',
    auth_token      TEXT NOT NULL DEFAULT '',
    tools_json      TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'registered',
    last_health_at  REAL,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_mcp_org ON mcp_servers(org_id);
""";


# ── Database class ───────────────────────────────────────────────────────────


class AgentDB:
    """SQLite database for agent persistence.

    Usage:
        db = AgentDB("data/agent.db")
        db.initialize()  # Creates tables + WAL mode

        with db.tx() as cur:
            cur.execute("INSERT INTO episodes ...")

        db.close()
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._conn: sqlite3.Connection | None = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = self._connect()
        return self._conn

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # Performance pragmas
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def initialize(self) -> None:
        """Create all tables and set schema version. Runs migrations for existing DBs."""
        current = self.schema_version()

        if current == 0:
            # Fresh database — create everything from scratch
            self.conn.executescript(SCHEMA_SQL)
        else:
            # Existing database — apply migrations
            self._migrate(current)

        self.conn.execute(
            "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        self.conn.commit()
        logger.info("Database initialized at %s (schema v%d)", self.path, SCHEMA_VERSION)

    def _migrate(self, from_version: int) -> None:
        """Apply schema migrations incrementally."""
        if from_version < 2:
            logger.info("Migrating database from v%d to v2", from_version)
            # ALTER TABLE doesn't support IF NOT EXISTS, so check first
            existing_cols = {
                row[1]
                for row in self.conn.execute("PRAGMA table_info(sessions)").fetchall()
            }
            for stmt in MIGRATION_V1_TO_V2.split(";"):
                stmt = stmt.strip()
                if not stmt:
                    continue
                # Skip ALTER TABLE for columns that already exist
                if "ALTER TABLE" in stmt and "ADD COLUMN" in stmt:
                    col_name = stmt.split("ADD COLUMN")[1].strip().split()[0]
                    if col_name in existing_cols:
                        continue
                try:
                    self.conn.execute(stmt)
                except sqlite3.OperationalError as exc:
                    if "duplicate column" not in str(exc).lower() and "already exists" not in str(exc).lower():
                        raise
            self.conn.commit()
        if from_version < 3:
            logger.info("Migrating database from v%d to v3 (portal tables)", from_version)
            try:
                self.conn.executescript(MIGRATION_V2_TO_V3)
            except sqlite3.OperationalError as exc:
                logger.debug("v3 migration partial: %s", exc)
            self.conn.commit()
        if from_version < 4:
            logger.info("Migrating database from v%d to v4 (control plane)", from_version)
            try:
                self.conn.executescript(MIGRATION_V3_TO_V4)
            except sqlite3.OperationalError as exc:
                logger.debug("v4 migration partial: %s", exc)
            self._seed_event_types()
            self.conn.commit()

    def _seed_event_types(self) -> None:
        """Seed the default event taxonomy."""
        try:
            self.conn.execute("SELECT 1 FROM event_types LIMIT 1")
        except sqlite3.OperationalError:
            return  # Table doesn't exist yet
        events = [
            ("run.started", "run", "Agent run started"),
            ("run.completed", "run", "Agent run completed successfully"),
            ("run.failed", "run", "Agent run failed with error"),
            ("run.timeout", "run", "Agent run timed out"),
            ("run.budget_exhausted", "run", "Agent run stopped due to budget"),
            ("tool.called", "tool", "Tool was invoked"),
            ("tool.failed", "tool", "Tool invocation failed"),
            ("tool.blocked", "policy", "Tool blocked by governance policy"),
            ("agent.created", "agent", "New agent was created"),
            ("agent.updated", "agent", "Agent config was modified"),
            ("agent.deleted", "agent", "Agent was deleted"),
            ("agent.promoted", "agent", "Agent promoted to new channel"),
            ("evolve.proposal", "evolve", "Evolution proposal generated"),
            ("evolve.approved", "evolve", "Evolution proposal approved"),
            ("evolve.rejected", "evolve", "Evolution proposal rejected"),
            ("evolve.applied", "evolve", "Evolution change applied"),
            ("evolve.rollback", "evolve", "Evolution change rolled back"),
            ("policy.blocked", "policy", "Action blocked by policy"),
            ("policy.warning", "policy", "Policy threshold warning"),
            ("billing.threshold", "billing", "Billing threshold exceeded"),
            ("slo.breach", "slo", "SLO threshold breached"),
            ("schedule.triggered", "schedule", "Scheduled run triggered"),
            ("schedule.failed", "schedule", "Scheduled run failed"),
            ("workflow.started", "workflow", "Workflow execution started"),
            ("workflow.completed", "workflow", "Workflow execution completed"),
            ("workflow.failed", "workflow", "Workflow execution failed"),
        ]
        for event_type, category, description in events:
            self.conn.execute(
                "INSERT OR IGNORE INTO event_types (event_type, category, description) VALUES (?, ?, ?)",
                (event_type, category, description),
            )

    # ── Audit Log ──────────────────────────────────────────────────────

    def audit(
        self, action: str, user_id: str = "", org_id: str = "", project_id: str = "",
        resource_type: str = "", resource_id: str = "", changes: dict | None = None,
    ) -> None:
        """Record an audit log entry. Silently skips if table doesn't exist."""
        try:
            self.conn.execute(
                """INSERT INTO audit_log (org_id, project_id, user_id, action,
                resource_type, resource_id, changes_json) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (org_id, project_id, user_id, action, resource_type, resource_id,
                 json.dumps(changes or {})),
            )
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # audit_log table may not exist in older DBs

    def query_audit_log(
        self, org_id: str = "", action: str = "", user_id: str = "",
        since: float = 0, limit: int = 100,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM audit_log WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if action:
            sql += " AND action LIKE ?"
            params.append(f"%{action}%")
        if user_id:
            sql += " AND user_id = ?"
            params.append(user_id)
        if since:
            sql += " AND created_at >= ?"
            params.append(since)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    # ── Job Queue ──────────────────────────────────────────────────────

    def enqueue_job(
        self, job_id: str, agent_name: str, task: str,
        org_id: str = "", idempotency_key: str = "", max_retries: int = 3,
        priority: int = 0, scheduled_at: float | None = None,
    ) -> None:
        # Check idempotency
        if idempotency_key:
            existing = self.conn.execute(
                "SELECT job_id FROM job_queue WHERE idempotency_key = ? AND status != 'dead'",
                (idempotency_key,),
            ).fetchone()
            if existing:
                return  # Deduplicate

        self.conn.execute(
            """INSERT INTO job_queue (job_id, org_id, agent_name, task,
            idempotency_key, max_retries, priority, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (job_id, org_id, agent_name, task, idempotency_key, max_retries, priority, scheduled_at),
        )
        self.conn.commit()

    def dequeue_job(self) -> dict[str, Any] | None:
        """Get the next pending job (highest priority, oldest first)."""
        row = self.conn.execute(
            """SELECT * FROM job_queue WHERE status = 'pending'
            AND (scheduled_at IS NULL OR scheduled_at <= ?)
            ORDER BY priority DESC, created_at ASC LIMIT 1""",
            (time.time(),),
        ).fetchone()
        if not row:
            return None
        job = dict(row)
        self.conn.execute(
            "UPDATE job_queue SET status = 'running', started_at = ? WHERE job_id = ?",
            (time.time(), job["job_id"]),
        )
        self.conn.commit()
        return job

    def complete_job(self, job_id: str, result: dict | None = None, session_id: str = "") -> None:
        self.conn.execute(
            "UPDATE job_queue SET status = 'completed', completed_at = ?, result_json = ?, session_id = ? WHERE job_id = ?",
            (time.time(), json.dumps(result or {}), session_id, job_id),
        )
        self.conn.commit()

    def fail_job(self, job_id: str, error: str) -> None:
        job = dict(self.conn.execute("SELECT * FROM job_queue WHERE job_id = ?", (job_id,)).fetchone())
        if job["retries"] >= job["max_retries"]:
            new_status = "dead"  # Dead-letter
        else:
            new_status = "pending"  # Retry
        self.conn.execute(
            "UPDATE job_queue SET status = ?, retries = retries + 1, error = ? WHERE job_id = ?",
            (new_status, error, job_id),
        )
        self.conn.commit()

    def list_jobs(self, status: str = "", limit: int = 50, org_id: str = "") -> list[dict[str, Any]]:
        sql = "SELECT * FROM job_queue"
        params: list[Any] = []
        clauses: list[str] = []
        if org_id:
            clauses.append("org_id = ?")
            params.append(org_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    # ── Retention ──────────────────────────────────────────────────────

    def apply_retention(self) -> dict[str, int]:
        """Apply all active retention policies. Returns counts of deleted rows."""
        policies = self.conn.execute(
            "SELECT * FROM retention_policies WHERE is_active = 1"
        ).fetchall()
        deleted: dict[str, int] = {}
        for p in policies:
            p = dict(p)
            cutoff = time.time() - (p["retention_days"] * 86400)
            table = p["resource_type"]
            try:
                result = self.conn.execute(f"DELETE FROM {table} WHERE created_at < ?", (cutoff,))
                deleted[table] = result.rowcount
            except Exception:
                deleted[table] = -1
        self.conn.commit()
        return deleted

    @contextmanager
    def tx(self) -> Generator[sqlite3.Cursor, None, None]:
        """Transaction context manager. Auto-commits on success, rolls back on error."""
        cur = self.conn.cursor()
        try:
            yield cur
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    # ── Schema info ──────────────────────────────────────────────────────

    def schema_version(self) -> int:
        try:
            row = self.conn.execute(
                "SELECT value FROM _meta WHERE key = 'schema_version'"
            ).fetchone()
            return int(row["value"]) if row else 0
        except sqlite3.OperationalError:
            return 0

    def table_exists(self, name: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
        return row is not None

    # ── Session CRUD ─────────────────────────────────────────────────────

    def insert_session(self, record: dict[str, Any]) -> None:
        """Insert a complete session record (from SessionRecord.to_dict())."""
        comp = record.get("composition", {})
        cost = record.get("cost", {})
        bench_cost = record.get("benchmark_cost", {})
        finish_accepted = record.get("finish_accepted")
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO sessions (
                    session_id, agent_id, agent_name, agent_version, model,
                    status, stop_reason, is_finished, error_attribution,
                    step_count, action_count, time_to_first_action_ms,
                    wall_clock_seconds, input_text, output_text,
                    cost_llm_input_usd, cost_llm_output_usd,
                    cost_tool_usd, cost_total_usd,
                    benchmark_cost_llm_input_usd, benchmark_cost_llm_output_usd,
                    benchmark_cost_tool_usd, benchmark_cost_total_usd,
                    composition_json,
                    finish_accepted, stop_initiated_by,
                    eval_score, eval_passed, eval_task_name,
                    eval_conditions_json,
                    trace_id, parent_session_id, depth,
                    created_at, ended_at
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, ?,
                    ?,
                    ?, ?,
                    ?, ?, ?,
                    ?,
                    ?, ?, ?,
                    ?, ?
                )""",
                (
                    record["session_id"],
                    comp.get("agent_id", ""),
                    comp.get("agent_name", record.get("agent_name", "")),
                    comp.get("agent_version", ""),
                    comp.get("model", ""),
                    record.get("status", "unknown"),
                    record.get("stop_reason", "completed"),
                    1 if record.get("is_finished") else 0,
                    record.get("error_attribution"),
                    record.get("step_count", 0),
                    record.get("action_count", 0),
                    record.get("time_to_first_action_ms", 0.0),
                    record.get("wall_clock_seconds", 0.0),
                    record.get("input_text", ""),
                    record.get("output_text", ""),
                    cost.get("llm_input_cost_usd", 0.0),
                    cost.get("llm_output_cost_usd", 0.0),
                    cost.get("tool_cost_usd", 0.0),
                    cost.get("total_usd", 0.0),
                    bench_cost.get("llm_input_cost_usd", 0.0),
                    bench_cost.get("llm_output_cost_usd", 0.0),
                    bench_cost.get("tool_cost_usd", 0.0),
                    bench_cost.get("total_usd", 0.0),
                    json.dumps(comp),
                    1 if finish_accepted else (0 if finish_accepted is not None else None),
                    record.get("stop_initiated_by", ""),
                    record.get("eval_score"),
                    1 if record.get("eval_passed") else (0 if record.get("eval_passed") is not None else None),
                    record.get("eval_task_name", ""),
                    json.dumps(record.get("eval_conditions", {})) if record.get("eval_conditions") else "{}",
                    record.get("trace_id", ""),
                    record.get("parent_session_id", ""),
                    record.get("depth", 0),
                    record.get("timestamp", time.time()),
                    record.get("ended_at"),
                ),
            )

    def insert_turns(self, session_id: str, turns: list[dict[str, Any]]) -> None:
        """Insert turn-level records for a session."""
        with self.tx() as cur:
            for turn in turns:
                cost = turn.get("cost", {})
                cur.execute(
                    """INSERT INTO turns (
                        session_id, turn_number, model_used,
                        input_tokens, output_tokens, latency_ms, llm_content,
                        cost_llm_input_usd, cost_llm_output_usd,
                        cost_tool_usd, cost_total_usd,
                        tool_calls_json, tool_results_json, errors_json,
                        started_at, ended_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        session_id,
                        turn.get("turn_number", 0),
                        turn.get("model_used", ""),
                        turn.get("input_tokens", 0),
                        turn.get("output_tokens", 0),
                        turn.get("latency_ms", 0.0),
                        turn.get("llm_content", ""),
                        cost.get("llm_input_cost_usd", 0.0),
                        cost.get("llm_output_cost_usd", 0.0),
                        cost.get("tool_cost_usd", 0.0),
                        cost.get("total_usd", 0.0),
                        json.dumps(turn.get("tool_calls", [])),
                        json.dumps(turn.get("tool_results", [])),
                        json.dumps([
                            {"source": e.get("source", "unknown"), "message": e.get("message", "")}
                            for e in turn.get("errors", [])
                        ]),
                        turn.get("started_at", time.time()),
                        turn.get("ended_at", time.time()),
                    ),
                )

    def insert_eval_run(self, report: dict[str, Any]) -> int:
        """Insert an aggregate eval run report. Returns the row id."""
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO eval_runs (
                    agent_name, agent_version, model,
                    benchmark_name, benchmark_version, grader_type, protocol,
                    total_tasks, total_trials, pass_count, fail_count, error_count,
                    pass_rate, avg_score, avg_latency_ms,
                    total_cost_usd, benchmark_cost_usd,
                    avg_tool_calls, tool_efficiency,
                    pass_at_1, pass_at_3,
                    eval_conditions_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    report.get("agent_name", ""),
                    report.get("agent_version", ""),
                    report.get("model", ""),
                    report.get("benchmark_name", ""),
                    report.get("benchmark_version", ""),
                    report.get("grader_type", ""),
                    report.get("protocol", "agentos"),
                    report.get("total_tasks", 0),
                    report.get("total_trials", 0),
                    report.get("pass_count", 0),
                    report.get("fail_count", 0),
                    report.get("error_count", 0),
                    report.get("pass_rate", 0.0),
                    report.get("avg_score", 0.0),
                    report.get("avg_latency_ms", 0.0),
                    report.get("total_cost_usd", 0.0),
                    report.get("benchmark_cost_usd", 0.0),
                    report.get("avg_tool_calls", 0.0),
                    report.get("tool_efficiency", 1.0),
                    report.get("pass_at_1"),
                    report.get("pass_at_3"),
                    json.dumps(report.get("eval_conditions", {})),
                ),
            )
            return cur.lastrowid

    def insert_session_errors(self, session_id: str, errors: list[dict[str, Any]]) -> None:
        """Insert error records for a session."""
        with self.tx() as cur:
            for err in errors:
                cur.execute(
                    """INSERT INTO errors (session_id, source, message, tool_name, turn, recoverable)
                    VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        session_id,
                        err.get("source", "unknown"),
                        err.get("message", ""),
                        err.get("tool_name"),
                        err.get("turn", 0),
                        1 if err.get("recoverable", True) else 0,
                    ),
                )

    def query_sessions(
        self,
        agent_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
        since: float | None = None,
    ) -> list[dict[str, Any]]:
        """Query sessions with optional filters."""
        sql = "SELECT * FROM sessions WHERE 1=1"
        params: list[Any] = []

        if agent_id:
            sql += " AND agent_id = ?"
            params.append(agent_id)
        if status:
            sql += " AND status = ?"
            params.append(status)
        if since:
            sql += " AND created_at >= ?"
            params.append(since)

        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)

        rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def query_trace(self, trace_id: str) -> list[dict[str, Any]]:
        """Get all sessions in a trace chain, ordered by depth then time."""
        rows = self.conn.execute(
            "SELECT * FROM sessions WHERE trace_id = ? ORDER BY depth, created_at",
            (trace_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def trace_cost_rollup(self, trace_id: str) -> dict[str, Any]:
        """Aggregate costs across all sessions in a trace."""
        row = self.conn.execute(
            """SELECT
                COUNT(*) as total_sessions,
                SUM(step_count) as total_turns,
                SUM(action_count) as total_tool_calls,
                SUM(cost_total_usd) as total_cost_usd,
                SUM(cost_llm_input_usd) as total_input_cost_usd,
                SUM(cost_llm_output_usd) as total_output_cost_usd,
                SUM(wall_clock_seconds) as total_wall_clock_seconds,
                MAX(depth) as max_depth
            FROM sessions WHERE trace_id = ?""",
            (trace_id,),
        ).fetchone()
        return dict(row) if row else {}

    def session_summary(self, agent_id: str | None = None) -> dict[str, Any]:
        """Aggregate stats across sessions."""
        where = "WHERE agent_id = ?" if agent_id else ""
        params: tuple[Any, ...] = (agent_id,) if agent_id else ()

        row = self.conn.execute(
            f"""SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
                SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) as timeouts,
                SUM(cost_total_usd) as total_cost,
                AVG(step_count) as avg_turns,
                AVG(wall_clock_seconds) as avg_wall_clock
            FROM sessions {where}""",
            params,
        ).fetchone()

        if not row or row["total"] == 0:
            return {"total_sessions": 0}

        return {
            "total_sessions": row["total"],
            "success_rate": row["successes"] / row["total"],
            "successes": row["successes"],
            "errors": row["errors"],
            "timeouts": row["timeouts"],
            "total_cost_usd": row["total_cost"] or 0.0,
            "avg_turns": row["avg_turns"] or 0.0,
            "avg_wall_clock_seconds": row["avg_wall_clock"] or 0.0,
        }

    # ── Evolution CRUD ───────────────────────────────────────────────────

    def insert_evolution_entry(self, entry: dict[str, Any]) -> None:
        """Insert an evolution ledger entry."""
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO evolution_entries (
                    version, previous_version, proposal_id, proposal_title,
                    category, modification_json, previous_config_json,
                    new_config_json, reviewer, reviewer_note,
                    metrics_before_json, metrics_after_json, impact_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    entry.get("version", ""),
                    entry.get("previous_version", ""),
                    entry.get("proposal_id", ""),
                    entry.get("proposal_title", ""),
                    entry.get("category", ""),
                    json.dumps(entry.get("modification", {})),
                    json.dumps(entry.get("previous_config", {})),
                    json.dumps(entry.get("new_config", {})),
                    entry.get("reviewer", ""),
                    entry.get("reviewer_note", ""),
                    json.dumps(entry.get("metrics_before", {})),
                    json.dumps(entry.get("metrics_after", {})),
                    json.dumps(entry.get("impact", {})),
                    entry.get("timestamp", time.time()),
                ),
            )

    def query_evolution(self, limit: int = 100) -> list[dict[str, Any]]:
        """Get evolution history, newest first."""
        rows = self.conn.execute(
            "SELECT * FROM evolution_entries ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        results = []
        for r in rows:
            d = dict(r)
            for col in ("modification_json", "previous_config_json", "new_config_json",
                         "metrics_before_json", "metrics_after_json", "impact_json"):
                if col in d:
                    d[col.replace("_json", "")] = json.loads(d[col])
            results.append(d)
        return results

    def update_evolution_impact(self, version: str, metrics_after: dict[str, float], impact: dict[str, float]) -> None:
        """Update impact metrics for an evolution entry."""
        with self.tx() as cur:
            cur.execute(
                """UPDATE evolution_entries
                SET metrics_after_json = ?, impact_json = ?
                WHERE version = ?""",
                (json.dumps(metrics_after), json.dumps(impact), version),
            )

    # ── Proposal CRUD ────────────────────────────────────────────────────

    def insert_proposal(self, proposal: dict[str, Any]) -> None:
        """Insert a proposal."""
        with self.tx() as cur:
            cur.execute(
                """INSERT OR REPLACE INTO proposals (
                    id, title, rationale, category, modification_json,
                    priority, evidence_json, status, surfaced,
                    reviewer_note, created_at, reviewed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    proposal["id"],
                    proposal.get("title", ""),
                    proposal.get("rationale", ""),
                    proposal.get("category", ""),
                    json.dumps(proposal.get("modification", {})),
                    proposal.get("priority", 0.0),
                    json.dumps(proposal.get("evidence", {})),
                    proposal.get("status", "pending"),
                    1 if proposal.get("surfaced") else 0,
                    proposal.get("reviewer_note", ""),
                    proposal.get("created_at", time.time()),
                    proposal.get("reviewed_at"),
                ),
            )

    def update_proposal_status(self, proposal_id: str, status: str, note: str = "", reviewed_at: float | None = None) -> None:
        """Update a proposal's review status."""
        with self.tx() as cur:
            cur.execute(
                """UPDATE proposals SET status = ?, reviewer_note = ?, reviewed_at = ?
                WHERE id = ?""",
                (status, note, reviewed_at or time.time(), proposal_id),
            )

    # ── Memory: Episodes ─────────────────────────────────────────────────

    def insert_episode(self, episode: dict[str, Any]) -> None:
        with self.tx() as cur:
            cur.execute(
                """INSERT OR REPLACE INTO episodes (id, input, output, outcome, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    episode["id"],
                    episode.get("input", ""),
                    episode.get("output", ""),
                    episode.get("outcome", ""),
                    json.dumps(episode.get("metadata", {})),
                    episode.get("timestamp", time.time()),
                ),
            )

    def search_episodes(self, query: str, limit: int = 5, ttl_seconds: float = 0) -> list[dict[str, Any]]:
        """Keyword search over episodes, respecting TTL."""
        sql = "SELECT * FROM episodes"
        params: list[Any] = []
        if ttl_seconds > 0:
            sql += " WHERE created_at >= ?"
            params.append(time.time() - ttl_seconds)
        sql += " ORDER BY created_at DESC"

        rows = self.conn.execute(sql, params).fetchall()

        # Score by keyword overlap (same logic as in-memory version)
        query_lower = query.lower()
        words = query_lower.split()
        scored: list[tuple[int, dict[str, Any]]] = []
        for r in rows:
            text = f"{r['input']} {r['output']}".lower()
            score = sum(1 for w in words if w in text)
            if score > 0:
                scored.append((score, dict(r)))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [d for _, d in scored[:limit]]

    def recent_episodes(self, limit: int = 10) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM episodes ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def count_episodes(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) as cnt FROM episodes").fetchone()
        return row["cnt"] if row else 0

    # ── Memory: Facts ────────────────────────────────────────────────────

    def upsert_fact(self, key: str, value: Any, embedding: list[float] | None = None) -> None:
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO facts (key, value_json, embedding_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    embedding_json = excluded.embedding_json,
                    updated_at = excluded.updated_at""",
                (key, json.dumps(value), json.dumps(embedding or []), time.time()),
            )

    def get_fact(self, key: str) -> Any | None:
        row = self.conn.execute("SELECT value_json FROM facts WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value_json"]) if row else None

    def search_facts_by_keyword(self, keyword: str, limit: int = 10) -> list[dict[str, Any]]:
        keyword_pattern = f"%{keyword}%"
        rows = self.conn.execute(
            """SELECT key, value_json, embedding_json, metadata_json
            FROM facts
            WHERE key LIKE ? OR value_json LIKE ?
            LIMIT ?""",
            (keyword_pattern, keyword_pattern, limit),
        ).fetchall()
        return [
            {"key": r["key"], "value": json.loads(r["value_json"]),
             "embedding": json.loads(r["embedding_json"])}
            for r in rows
        ]

    def delete_fact(self, key: str) -> bool:
        with self.tx() as cur:
            cur.execute("DELETE FROM facts WHERE key = ?", (key,))
            return cur.rowcount > 0

    def count_facts(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) as cnt FROM facts").fetchone()
        return row["cnt"] if row else 0

    # ── Memory: Procedures ───────────────────────────────────────────────

    def upsert_procedure(self, proc: dict[str, Any]) -> None:
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO procedures (name, description, steps_json, success_count, failure_count, last_used)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    description = excluded.description,
                    steps_json = excluded.steps_json,
                    success_count = excluded.success_count,
                    failure_count = excluded.failure_count,
                    last_used = excluded.last_used""",
                (
                    proc["name"],
                    proc.get("description", ""),
                    json.dumps(proc.get("steps", [])),
                    proc.get("success_count", 0),
                    proc.get("failure_count", 0),
                    proc.get("last_used", time.time()),
                ),
            )

    def get_procedure(self, name: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM procedures WHERE name = ?", (name,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["steps"] = json.loads(d["steps_json"])
        return d

    def record_procedure_outcome(self, name: str, success: bool) -> None:
        col = "success_count" if success else "failure_count"
        with self.tx() as cur:
            cur.execute(
                f"UPDATE procedures SET {col} = {col} + 1, last_used = ? WHERE name = ?",
                (time.time(), name),
            )

    def find_best_procedures(self, task_description: str, limit: int = 3) -> list[dict[str, Any]]:
        rows = self.conn.execute("SELECT * FROM procedures").fetchall()
        task_words = set(task_description.lower().split())
        scored: list[tuple[float, dict[str, Any]]] = []
        for r in rows:
            d = dict(r)
            desc_words = set(f"{d['name']} {d['description']}".lower().split())
            overlap = len(task_words & desc_words)
            if overlap > 0:
                total = d["success_count"] + d["failure_count"]
                rate = d["success_count"] / total if total else 0.0
                score = overlap * (0.5 + 0.5 * rate)
                d["steps"] = json.loads(d["steps_json"])
                scored.append((score, d))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [d for _, d in scored[:limit]]

    # ── Cost ledger ──────────────────────────────────────────────────────

    def record_cost(
        self,
        session_id: str,
        agent_id: str = "",
        agent_name: str = "",
        model: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        cost_usd: float = 0.0,
    ) -> None:
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO cost_ledger (session_id, agent_id, agent_name, model, input_tokens, output_tokens, cost_usd)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (session_id, agent_id, agent_name, model, input_tokens, output_tokens, cost_usd),
            )

    def total_cost(self, agent_id: str | None = None, since: float | None = None) -> float:
        sql = "SELECT COALESCE(SUM(cost_usd), 0.0) as total FROM cost_ledger WHERE 1=1"
        params: list[Any] = []
        if agent_id:
            sql += " AND agent_id = ?"
            params.append(agent_id)
        if since:
            sql += " AND created_at >= ?"
            params.append(since)
        row = self.conn.execute(sql, params).fetchone()
        return float(row["total"]) if row else 0.0

    # ── Spans (tracing) ─────────────────────────────────────────────────

    def insert_spans(self, spans: list[dict[str, Any]], session_id: str = "") -> None:
        """Insert trace spans (from Tracer.export())."""
        with self.tx() as cur:
            for s in spans:
                cur.execute(
                    """INSERT OR REPLACE INTO spans (
                        span_id, trace_id, parent_span_id, session_id,
                        name, kind, status,
                        start_time, end_time, duration_ms,
                        attributes_json, events_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        s["span_id"],
                        s["trace_id"],
                        s.get("parent_span_id"),
                        session_id,
                        s.get("name", ""),
                        s.get("kind", ""),
                        s.get("status", "ok"),
                        s.get("start_time", 0.0),
                        s.get("end_time", 0.0),
                        s.get("duration_ms", 0.0),
                        json.dumps(s.get("attributes", {})),
                        json.dumps(s.get("events", [])),
                    ),
                )

    def query_trace_spans(self, trace_id: str) -> list[dict[str, Any]]:
        """Get all spans for a trace, ordered by start time."""
        rows = self.conn.execute(
            "SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time",
            (trace_id,),
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["attributes"] = json.loads(d.pop("attributes_json", "{}"))
            d["events"] = json.loads(d.pop("events_json", "[]"))
            result.append(d)
        return result

    def query_spans(
        self,
        session_id: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Query spans with optional filters — programmatic trace API."""
        sql = "SELECT * FROM spans WHERE 1=1"
        params: list[Any] = []
        if session_id:
            sql += " AND session_id = ?"
            params.append(session_id)
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        if status:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY start_time DESC LIMIT ?"
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["attributes"] = json.loads(d.pop("attributes_json", "{}"))
            d["events"] = json.loads(d.pop("events_json", "[]"))
            result.append(d)
        return result

    # ── Feedback ──────────────────────────────────────────────────────────

    def insert_feedback(
        self,
        session_id: str,
        rating: int,
        turn_number: int | None = None,
        correction: str = "",
        comment: str = "",
        tags: list[str] | None = None,
        source: str = "human",
    ) -> int:
        """Record human (or automated) feedback on an agent output."""
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO feedback (
                    session_id, turn_number, rating, correction, comment, tags, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    session_id,
                    turn_number,
                    rating,
                    correction,
                    comment,
                    json.dumps(tags or []),
                    source,
                ),
            )
            return cur.lastrowid

    def query_feedback(
        self,
        session_id: str | None = None,
        rating: int | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Query feedback records."""
        sql = "SELECT * FROM feedback WHERE 1=1"
        params: list[Any] = []
        if session_id:
            sql += " AND session_id = ?"
            params.append(session_id)
        if rating is not None:
            sql += " AND rating = ?"
            params.append(rating)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["tags"] = json.loads(d.get("tags", "[]"))
            result.append(d)
        return result

    def feedback_summary(self, agent_name: str | None = None) -> dict[str, Any]:
        """Aggregate feedback stats — programmatic API for the agent."""
        if agent_name:
            rows = self.conn.execute(
                """SELECT f.rating, COUNT(*) as cnt
                FROM feedback f
                JOIN sessions s ON f.session_id = s.session_id
                WHERE s.agent_name = ?
                GROUP BY f.rating""",
                (agent_name,),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT rating, COUNT(*) as cnt FROM feedback GROUP BY rating"
            ).fetchall()
        total = sum(r["cnt"] for r in rows)
        by_rating = {r["rating"]: r["cnt"] for r in rows}
        return {
            "total": total,
            "positive": by_rating.get(1, 0),
            "neutral": by_rating.get(0, 0),
            "negative": by_rating.get(-1, 0),
            "approval_rate": by_rating.get(1, 0) / total if total else 0.0,
        }

    # ── Programmatic Trace Query API (Phase 3 — agent consumes its own telemetry) ──

    def trace_summary(self, session_id: str) -> dict[str, Any]:
        """Build a summary an agent can consume to understand its own performance.

        This is the Phase 3 interface: the agent reads its own traces
        to self-improve without human intervention.
        """
        session_rows = self.conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchall()
        if not session_rows:
            return {}

        session = dict(session_rows[0])
        turns = self.conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY turn_number",
            (session_id,),
        ).fetchall()
        errors = self.conn.execute(
            "SELECT * FROM errors WHERE session_id = ?", (session_id,)
        ).fetchall()
        feedback_rows = self.conn.execute(
            "SELECT * FROM feedback WHERE session_id = ?", (session_id,)
        ).fetchall()
        spans = self.query_trace(session.get("session_id", ""))

        return {
            "session": {
                "status": session["status"],
                "stop_reason": session["stop_reason"],
                "stop_initiated_by": session.get("stop_initiated_by", ""),
                "finish_accepted": session.get("finish_accepted"),
                "wall_clock_seconds": session["wall_clock_seconds"],
                "step_count": session["step_count"],
                "action_count": session["action_count"],
                "cost_total_usd": session["cost_total_usd"],
                "benchmark_cost_total_usd": session.get("benchmark_cost_total_usd", 0.0),
            },
            "turns": [
                {
                    "turn": dict(t)["turn_number"],
                    "model": dict(t)["model_used"],
                    "latency_ms": dict(t)["latency_ms"],
                    "tokens": dict(t)["input_tokens"] + dict(t)["output_tokens"],
                    "tool_calls": len(json.loads(dict(t).get("tool_calls_json", "[]"))),
                    "errors": len(json.loads(dict(t).get("errors_json", "[]"))),
                }
                for t in turns
            ],
            "errors": [
                {"source": dict(e)["source"], "message": dict(e)["message"], "turn": dict(e)["turn"]}
                for e in errors
            ],
            "feedback": [
                {"rating": dict(f)["rating"], "comment": dict(f)["comment"]}
                for f in feedback_rows
            ],
            "span_count": len(spans),
        }

    # ── Utilities ────────────────────────────────────────────────────────

    def vacuum(self) -> None:
        """Reclaim space after deletions."""
        self.conn.execute("VACUUM")

    def size_bytes(self) -> int:
        """Get database file size."""
        return self.path.stat().st_size if self.path.exists() else 0

    # ── Billing ─────────────────────────────────────────────────────────

    def record_billing(
        self,
        cost_type: str,
        total_cost_usd: float,
        org_id: str = "",
        customer_id: str = "",
        agent_name: str = "",
        description: str = "",
        model: str = "",
        provider: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        inference_cost_usd: float = 0.0,
        gpu_type: str = "",
        gpu_hours: float = 0.0,
        gpu_cost_usd: float = 0.0,
        session_id: str = "",
        trace_id: str = "",
    ) -> int:
        """Record a billing entry for customer charging."""
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO billing_records (
                    org_id, customer_id, agent_name, cost_type, description,
                    model, provider, input_tokens, output_tokens, inference_cost_usd,
                    gpu_type, gpu_hours, gpu_cost_usd, total_cost_usd,
                    session_id, trace_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    org_id, customer_id, agent_name, cost_type, description,
                    model, provider, input_tokens, output_tokens, inference_cost_usd,
                    gpu_type, gpu_hours, gpu_cost_usd, total_cost_usd,
                    session_id, trace_id,
                ),
            )
            return cur.lastrowid

    def billing_summary(
        self,
        org_id: str = "",
        customer_id: str = "",
        since: float | None = None,
    ) -> dict[str, Any]:
        """Aggregate billing for an org/customer — for invoicing."""
        sql = "SELECT * FROM billing_records WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if customer_id:
            sql += " AND customer_id = ?"
            params.append(customer_id)
        if since:
            sql += " AND created_at >= ?"
            params.append(since)

        rows = self.conn.execute(sql, params).fetchall()
        records = [dict(r) for r in rows]

        total_inference = sum(r.get("inference_cost_usd", 0) for r in records)
        total_gpu = sum(r.get("gpu_cost_usd", 0) for r in records)
        total_all = sum(r.get("total_cost_usd", 0) for r in records)
        total_tokens_in = sum(r.get("input_tokens", 0) for r in records)
        total_tokens_out = sum(r.get("output_tokens", 0) for r in records)
        total_gpu_hours = sum(r.get("gpu_hours", 0) for r in records)

        # Breakdown by cost type
        by_type: dict[str, float] = {}
        for r in records:
            t = r.get("cost_type", "other")
            by_type[t] = by_type.get(t, 0) + r.get("total_cost_usd", 0)

        # Breakdown by model
        by_model: dict[str, float] = {}
        for r in records:
            m = r.get("model", "unknown")
            by_model[m] = by_model.get(m, 0) + r.get("total_cost_usd", 0)

        return {
            "total_records": len(records),
            "total_cost_usd": total_all,
            "inference_cost_usd": total_inference,
            "gpu_compute_cost_usd": total_gpu,
            "total_input_tokens": total_tokens_in,
            "total_output_tokens": total_tokens_out,
            "total_gpu_hours": total_gpu_hours,
            "by_cost_type": by_type,
            "by_model": by_model,
        }

    # ── GPU Endpoints ──────────────────────────────────────────────────

    def register_gpu_endpoint(
        self,
        endpoint_id: str,
        model_id: str,
        api_base: str,
        gpu_type: str = "h100",
        gpu_count: int = 1,
        hourly_rate_usd: float = 2.98,
        org_id: str = "",
    ) -> None:
        """Register a dedicated GPU endpoint."""
        with self.tx() as cur:
            cur.execute(
                """INSERT OR REPLACE INTO gpu_endpoints (
                    endpoint_id, org_id, gpu_type, gpu_count,
                    model_id, api_base, status, hourly_rate_usd, started_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)""",
                (endpoint_id, org_id, gpu_type, gpu_count,
                 model_id, api_base, hourly_rate_usd, time.time()),
            )

    def get_gpu_endpoint(self, endpoint_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM gpu_endpoints WHERE endpoint_id = ?", (endpoint_id,)
        ).fetchone()
        return dict(row) if row else None

    def stop_gpu_endpoint(self, endpoint_id: str) -> dict[str, Any] | None:
        """Stop a GPU endpoint and calculate total cost."""
        endpoint = self.get_gpu_endpoint(endpoint_id)
        if not endpoint:
            return None
        now = time.time()
        started = endpoint.get("started_at", now)
        hours = (now - started) / 3600
        cost = hours * endpoint.get("hourly_rate_usd", 2.98)
        with self.tx() as cur:
            cur.execute(
                """UPDATE gpu_endpoints SET status='stopped', stopped_at=?,
                total_hours=?, total_cost_usd=? WHERE endpoint_id=?""",
                (now, hours, cost, endpoint_id),
            )
        return {"endpoint_id": endpoint_id, "hours": hours, "cost_usd": cost}

    def list_gpu_endpoints(self, status: str | None = None, org_id: str = "") -> list[dict[str, Any]]:
        sql = "SELECT * FROM gpu_endpoints WHERE 1=1"
        params: list[Any] = []
        if status:
            sql += " AND status = ?"
            params.append(status)
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        sql += " ORDER BY created_at DESC"
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def stats(self) -> dict[str, Any]:
        """Quick overview of database contents."""
        tables = ["sessions", "turns", "errors", "evolution_entries",
                   "proposals", "episodes", "facts", "procedures", "cost_ledger",
                   "eval_runs", "spans", "feedback", "billing_records", "gpu_endpoints"]
        counts: dict[str, int] = {}
        for table in tables:
            try:
                row = self.conn.execute(f"SELECT COUNT(*) as cnt FROM {table}").fetchone()
                counts[table] = row["cnt"] if row else 0
            except sqlite3.OperationalError:
                counts[table] = -1
        return {
            "path": str(self.path),
            "size_bytes": self.size_bytes(),
            "schema_version": self.schema_version(),
            "tables": counts,
        }


def create_database(path: str | Path) -> AgentDB:
    """Create and initialize a new agent database. Idempotent."""
    db = AgentDB(path)
    db.initialize()
    return db
