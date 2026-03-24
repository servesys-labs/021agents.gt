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
SCHEMA_VERSION = 15

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
    org_id              TEXT NOT NULL DEFAULT '',
    project_id          TEXT NOT NULL DEFAULT '',
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
CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

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
    execution_mode      TEXT NOT NULL DEFAULT 'sequential',
    plan_json           TEXT NOT NULL DEFAULT '{}',
    reflection_json     TEXT NOT NULL DEFAULT '{}',
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
    -- Pricing snapshot for invoice-grade reproducibility
    pricing_source  TEXT NOT NULL DEFAULT 'fallback_env',  -- catalog / fallback_env
    pricing_key     TEXT NOT NULL DEFAULT '',              -- e.g. llm:gmi:model or tool:web-search
    unit            TEXT NOT NULL DEFAULT '',              -- input_token / call / second
    unit_price_usd  REAL NOT NULL DEFAULT 0.0,
    quantity        REAL NOT NULL DEFAULT 0.0,
    pricing_version TEXT NOT NULL DEFAULT '',              -- catalog version hash/label
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

CREATE TABLE IF NOT EXISTS pricing_catalog (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    provider        TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    resource_type   TEXT NOT NULL DEFAULT '',      -- llm / tool / sandbox / connector
    operation       TEXT NOT NULL DEFAULT '',      -- infer / web-search / exec
    unit            TEXT NOT NULL DEFAULT '',      -- input_token / output_token / call / second
    unit_price_usd  REAL NOT NULL DEFAULT 0.0,
    currency        TEXT NOT NULL DEFAULT 'USD',
    source          TEXT NOT NULL DEFAULT 'manual', -- manual / synced
    pricing_version TEXT NOT NULL DEFAULT '',
    effective_from  REAL NOT NULL DEFAULT 0.0,
    effective_to    REAL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_pricing_lookup ON pricing_catalog(resource_type, provider, model, operation, unit, is_active, effective_from);
CREATE INDEX IF NOT EXISTS idx_pricing_effective ON pricing_catalog(effective_from, effective_to);

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

-- OTel-like event stream from edge/runtime workers
CREATE TABLE IF NOT EXISTS otel_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL DEFAULT '',
    turn            INTEGER NOT NULL DEFAULT 0,
    event_type      TEXT NOT NULL DEFAULT '',
    action          TEXT NOT NULL DEFAULT '',
    plan            TEXT NOT NULL DEFAULT '',
    tier            TEXT NOT NULL DEFAULT '',
    provider        TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    tool_name       TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT '',
    latency_ms      REAL NOT NULL DEFAULT 0.0,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0.0,
    details_json    TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_otel_session ON otel_events(session_id);
CREATE INDEX IF NOT EXISTS idx_otel_event_type ON otel_events(event_type);
CREATE INDEX IF NOT EXISTS idx_otel_created ON otel_events(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- SKILLS — loaded skill definitions and their enabled state
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS skills (
    name            TEXT PRIMARY KEY,
    description     TEXT NOT NULL DEFAULT '',
    version         TEXT NOT NULL DEFAULT '1.0.0',
    license         TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT 'public',
    allowed_tools   TEXT NOT NULL DEFAULT '[]',
    tags            TEXT NOT NULL DEFAULT '[]',
    enabled         INTEGER NOT NULL DEFAULT 1,
    source_path     TEXT NOT NULL DEFAULT '',
    content_hash    TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════
-- MEMORY_FACTS — async memory updater extracted facts
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS memory_facts (
    id              TEXT PRIMARY KEY,
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT 'context',
    confidence      REAL NOT NULL DEFAULT 0.8,
    source          TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_facts_category ON memory_facts(category);
CREATE INDEX IF NOT EXISTS idx_memory_facts_hash ON memory_facts(content_hash);

-- ═══════════════════════════════════════════════════════════════════════════
-- MIDDLEWARE_EVENTS — loop detection and middleware actions log
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS middleware_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL DEFAULT '',
    middleware_name  TEXT NOT NULL,
    action          TEXT NOT NULL,
    details_json    TEXT NOT NULL DEFAULT '{}',
    turn_number     INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_mw_events_session ON middleware_events(session_id);
CREATE INDEX IF NOT EXISTS idx_mw_events_middleware ON middleware_events(middleware_name);

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

-- ═══════════════════════════════════════════════════════════════════════════
-- CONVERSATION INTELLIGENCE — sentiment, quality, analytics
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conversation_scores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL DEFAULT '',
    turn_number     INTEGER NOT NULL DEFAULT 0,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    sentiment       TEXT NOT NULL DEFAULT 'neutral',
    sentiment_score REAL NOT NULL DEFAULT 0.0,
    sentiment_confidence REAL NOT NULL DEFAULT 0.0,
    relevance_score REAL NOT NULL DEFAULT 0.0,
    coherence_score REAL NOT NULL DEFAULT 0.0,
    helpfulness_score REAL NOT NULL DEFAULT 0.0,
    safety_score    REAL NOT NULL DEFAULT 1.0,
    quality_overall REAL NOT NULL DEFAULT 0.0,
    topic           TEXT NOT NULL DEFAULT '',
    intent          TEXT NOT NULL DEFAULT '',
    has_tool_failure INTEGER NOT NULL DEFAULT 0,
    has_hallucination_risk INTEGER NOT NULL DEFAULT 0,
    scorer_model    TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_scores_session ON conversation_scores(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_scores_org ON conversation_scores(org_id);
CREATE INDEX IF NOT EXISTS idx_conv_scores_agent ON conversation_scores(agent_name);
CREATE INDEX IF NOT EXISTS idx_conv_scores_sentiment ON conversation_scores(sentiment);
CREATE INDEX IF NOT EXISTS idx_conv_scores_created ON conversation_scores(created_at);

CREATE TABLE IF NOT EXISTS conversation_analytics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL UNIQUE,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    avg_sentiment_score REAL NOT NULL DEFAULT 0.0,
    dominant_sentiment TEXT NOT NULL DEFAULT 'neutral',
    sentiment_trend TEXT NOT NULL DEFAULT 'stable',
    avg_quality     REAL NOT NULL DEFAULT 0.0,
    min_quality     REAL NOT NULL DEFAULT 0.0,
    max_quality     REAL NOT NULL DEFAULT 0.0,
    topics_json     TEXT NOT NULL DEFAULT '[]',
    intents_json    TEXT NOT NULL DEFAULT '[]',
    failure_patterns_json TEXT NOT NULL DEFAULT '[]',
    total_turns     INTEGER NOT NULL DEFAULT 0,
    tool_failure_count INTEGER NOT NULL DEFAULT 0,
    hallucination_risk_count INTEGER NOT NULL DEFAULT 0,
    task_completed  INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_session ON conversation_analytics(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_org ON conversation_analytics(org_id);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_agent ON conversation_analytics(agent_name);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_created ON conversation_analytics(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- GOLD IMAGES — blessed/approved base agent configurations
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gold_images (
    image_id        TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    config_json     TEXT NOT NULL DEFAULT '{}',
    config_hash     TEXT NOT NULL DEFAULT '',
    version         TEXT NOT NULL DEFAULT '1.0.0',
    category        TEXT NOT NULL DEFAULT 'general',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_by      TEXT NOT NULL DEFAULT '',
    approved_by     TEXT NOT NULL DEFAULT '',
    approved_at     REAL,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_gold_org ON gold_images(org_id);
CREATE INDEX IF NOT EXISTS idx_gold_name ON gold_images(name);
CREATE INDEX IF NOT EXISTS idx_gold_active ON gold_images(is_active);
CREATE INDEX IF NOT EXISTS idx_gold_hash ON gold_images(config_hash);

-- COMPLIANCE CHECKS — records of agent vs gold image comparison
CREATE TABLE IF NOT EXISTS compliance_checks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL,
    image_id        TEXT NOT NULL DEFAULT '',
    image_name      TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'unchecked',
    drift_count     INTEGER NOT NULL DEFAULT 0,
    drift_fields    TEXT NOT NULL DEFAULT '[]',
    drift_details_json TEXT NOT NULL DEFAULT '{}',
    checked_by      TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_compliance_org ON compliance_checks(org_id);
CREATE INDEX IF NOT EXISTS idx_compliance_agent ON compliance_checks(agent_name);
CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance_checks(status);
CREATE INDEX IF NOT EXISTS idx_compliance_image ON compliance_checks(image_id);

-- CONFIG AUDIT LOG — every config change with who/when/what/why
CREATE TABLE IF NOT EXISTS config_audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    action          TEXT NOT NULL DEFAULT '',
    field_changed   TEXT NOT NULL DEFAULT '',
    old_value       TEXT NOT NULL DEFAULT '',
    new_value       TEXT NOT NULL DEFAULT '',
    change_reason   TEXT NOT NULL DEFAULT '',
    changed_by      TEXT NOT NULL DEFAULT '',
    image_id        TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_config_audit_org ON config_audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_config_audit_agent ON config_audit_log(agent_name);
CREATE INDEX IF NOT EXISTS idx_config_audit_created ON config_audit_log(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- ISSUES — automated issue tracking and remediation
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS issues (
    issue_id        TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT 'unknown',
    severity        TEXT NOT NULL DEFAULT 'low',
    status          TEXT NOT NULL DEFAULT 'open',
    source          TEXT NOT NULL DEFAULT 'auto',
    source_session_id TEXT NOT NULL DEFAULT '',
    source_turn     INTEGER NOT NULL DEFAULT 0,
    suggested_fix   TEXT NOT NULL DEFAULT '',
    fix_applied     INTEGER NOT NULL DEFAULT 0,
    assigned_to     TEXT NOT NULL DEFAULT '',
    resolved_by     TEXT NOT NULL DEFAULT '',
    resolved_at     REAL,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_issues_org ON issues(org_id);
CREATE INDEX IF NOT EXISTS idx_issues_agent ON issues(agent_name);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_category ON issues(category);
CREATE INDEX IF NOT EXISTS idx_issues_severity ON issues(severity);
CREATE INDEX IF NOT EXISTS idx_issues_created ON issues(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY — red-team scans, vulnerability findings, AIVSS risk scores
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS security_scans (
    scan_id         TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    scan_type       TEXT NOT NULL DEFAULT 'full',
    status          TEXT NOT NULL DEFAULT 'pending',
    total_probes    INTEGER NOT NULL DEFAULT 0,
    passed          INTEGER NOT NULL DEFAULT 0,
    failed          INTEGER NOT NULL DEFAULT 0,
    errors          INTEGER NOT NULL DEFAULT 0,
    risk_score      REAL NOT NULL DEFAULT 0.0,
    risk_level      TEXT NOT NULL DEFAULT 'unknown',
    started_at      REAL,
    completed_at    REAL,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_scans_org ON security_scans(org_id);
CREATE INDEX IF NOT EXISTS idx_scans_agent ON security_scans(agent_name);
CREATE INDEX IF NOT EXISTS idx_scans_status ON security_scans(status);

CREATE TABLE IF NOT EXISTS security_findings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id         TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    probe_id        TEXT NOT NULL DEFAULT '',
    probe_name      TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT '',
    layer           TEXT NOT NULL DEFAULT '',
    severity        TEXT NOT NULL DEFAULT 'info',
    status          TEXT NOT NULL DEFAULT 'open',
    title           TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    evidence        TEXT NOT NULL DEFAULT '',
    remediation     TEXT NOT NULL DEFAULT '',
    aivss_vector    TEXT NOT NULL DEFAULT '',
    aivss_score     REAL NOT NULL DEFAULT 0.0,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_findings_scan ON security_findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_agent ON security_findings(agent_name);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON security_findings(severity);
CREATE INDEX IF NOT EXISTS idx_findings_category ON security_findings(category);

CREATE TABLE IF NOT EXISTS agent_risk_profiles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL UNIQUE,
    risk_score      REAL NOT NULL DEFAULT 0.0,
    risk_level      TEXT NOT NULL DEFAULT 'unknown',
    aivss_vector_json TEXT NOT NULL DEFAULT '{}',
    last_scan_id    TEXT NOT NULL DEFAULT '',
    findings_summary_json TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_risk_org ON agent_risk_profiles(org_id);
CREATE INDEX IF NOT EXISTS idx_risk_agent ON agent_risk_profiles(agent_name);
CREATE INDEX IF NOT EXISTS idx_risk_level ON agent_risk_profiles(risk_level);

-- ═══════════════════════════════════════════════════════════════════════════
-- VAPI — voice platform integration (calls, events)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vapi_calls (
    call_id         TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    phone_number    TEXT NOT NULL DEFAULT '',
    direction       TEXT NOT NULL DEFAULT 'outbound',
    status          TEXT NOT NULL DEFAULT 'pending',
    duration_seconds REAL NOT NULL DEFAULT 0.0,
    transcript      TEXT NOT NULL DEFAULT '',
    cost_usd        REAL NOT NULL DEFAULT 0.0,
    vapi_assistant_id TEXT NOT NULL DEFAULT '',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    started_at      REAL,
    ended_at        REAL,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_org ON vapi_calls(org_id);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_agent ON vapi_calls(agent_name);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_status ON vapi_calls(status);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_created ON vapi_calls(created_at);

CREATE TABLE IF NOT EXISTS vapi_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id         TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    event_type      TEXT NOT NULL DEFAULT '',
    payload_json    TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_vapi_events_call ON vapi_events(call_id);
CREATE INDEX IF NOT EXISTS idx_vapi_events_type ON vapi_events(event_type);

-- ═══════════════════════════════════════════════════════════════════════════
-- AUTORESEARCH — full observability for autonomous improvement loops
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS autoresearch_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    mode            TEXT NOT NULL DEFAULT 'agent',
    primary_metric  TEXT NOT NULL DEFAULT 'pass_rate',
    max_iterations  INTEGER NOT NULL DEFAULT 0,
    proposer_model  TEXT NOT NULL DEFAULT '',
    proposer_provider TEXT NOT NULL DEFAULT '',
    backend         TEXT NOT NULL DEFAULT 'in-process',
    status          TEXT NOT NULL DEFAULT 'running',
    total_iterations INTEGER NOT NULL DEFAULT 0,
    baseline_score  REAL NOT NULL DEFAULT 0.0,
    best_score      REAL NOT NULL DEFAULT 0.0,
    improvements_kept INTEGER NOT NULL DEFAULT 0,
    experiments_discarded INTEGER NOT NULL DEFAULT 0,
    experiments_crashed INTEGER NOT NULL DEFAULT 0,
    best_config_json TEXT NOT NULL DEFAULT '{}',
    applied         INTEGER NOT NULL DEFAULT 0,
    total_inference_cost_usd REAL NOT NULL DEFAULT 0.0,
    total_gpu_cost_usd REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    elapsed_seconds REAL NOT NULL DEFAULT 0.0,
    started_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    completed_at    REAL,
    source          TEXT NOT NULL DEFAULT 'backend',
    error_message   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ar_runs_agent ON autoresearch_runs(agent_name);
CREATE INDEX IF NOT EXISTS idx_ar_runs_org ON autoresearch_runs(org_id);
CREATE INDEX IF NOT EXISTS idx_ar_runs_status ON autoresearch_runs(status);
CREATE INDEX IF NOT EXISTS idx_ar_runs_started ON autoresearch_runs(started_at);

CREATE TABLE IF NOT EXISTS autoresearch_experiments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    iteration       INTEGER NOT NULL DEFAULT 0,
    hypothesis      TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    modification_json TEXT NOT NULL DEFAULT '{}',
    config_before_json TEXT NOT NULL DEFAULT '{}',
    config_after_json TEXT NOT NULL DEFAULT '{}',
    score_before    REAL NOT NULL DEFAULT 0.0,
    score_after     REAL NOT NULL DEFAULT 0.0,
    improvement     REAL NOT NULL DEFAULT 0.0,
    primary_metric  TEXT NOT NULL DEFAULT 'pass_rate',
    all_metrics_json TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'discard',
    val_bpb         REAL NOT NULL DEFAULT 0.0,
    peak_vram_mb    REAL NOT NULL DEFAULT 0.0,
    training_seconds REAL NOT NULL DEFAULT 0.0,
    num_steps       INTEGER NOT NULL DEFAULT 0,
    num_params_m    REAL NOT NULL DEFAULT 0.0,
    inference_cost_usd REAL NOT NULL DEFAULT 0.0,
    gpu_cost_usd    REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    commit_hash     TEXT NOT NULL DEFAULT '',
    error_message   TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_ar_exp_run ON autoresearch_experiments(run_id);
CREATE INDEX IF NOT EXISTS idx_ar_exp_agent ON autoresearch_experiments(agent_name);
CREATE INDEX IF NOT EXISTS idx_ar_exp_status ON autoresearch_experiments(status);
CREATE INDEX IF NOT EXISTS idx_ar_exp_created ON autoresearch_experiments(created_at);
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
    project_id      TEXT NOT NULL DEFAULT '',
    env             TEXT NOT NULL DEFAULT '',
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
    dag_json        TEXT NOT NULL DEFAULT '{}',
    reflection_json TEXT NOT NULL DEFAULT '{}',
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


# ── Migration from v4 → v5 (middleware, skills, async memory) ────────────────

MIGRATION_V4_TO_V5 = """\
-- SKILLS — loaded skill definitions and their enabled state
CREATE TABLE IF NOT EXISTS skills (
    name            TEXT PRIMARY KEY,
    description     TEXT NOT NULL DEFAULT '',
    version         TEXT NOT NULL DEFAULT '1.0.0',
    license         TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT 'public',  -- public/custom
    allowed_tools   TEXT NOT NULL DEFAULT '[]',       -- JSON array
    tags            TEXT NOT NULL DEFAULT '[]',       -- JSON array
    enabled         INTEGER NOT NULL DEFAULT 1,
    source_path     TEXT NOT NULL DEFAULT '',
    content_hash    TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

-- MEMORY_FACTS — async memory updater extracted facts
CREATE TABLE IF NOT EXISTS memory_facts (
    id              TEXT PRIMARY KEY,
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL DEFAULT '',  -- for deduplication
    category        TEXT NOT NULL DEFAULT 'context',  -- preference/knowledge/context/behavior/goal
    confidence      REAL NOT NULL DEFAULT 0.8,
    source          TEXT NOT NULL DEFAULT '',  -- session_id or 'manual'
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_facts_category ON memory_facts(category);
CREATE INDEX IF NOT EXISTS idx_memory_facts_hash ON memory_facts(content_hash);

-- MIDDLEWARE_EVENTS — loop detection and middleware actions log
CREATE TABLE IF NOT EXISTS middleware_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL DEFAULT '',
    middleware_name  TEXT NOT NULL,
    action          TEXT NOT NULL,  -- warning/hard_stop/summarized/halt
    details_json    TEXT NOT NULL DEFAULT '{}',
    turn_number     INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_mw_events_session ON middleware_events(session_id);
CREATE INDEX IF NOT EXISTS idx_mw_events_middleware ON middleware_events(middleware_name);

-- Add middleware_warnings column to turns table
ALTER TABLE turns ADD COLUMN middleware_warnings_json TEXT NOT NULL DEFAULT '[]';

-- Add skills_active column to sessions for tracking which skills were enabled
ALTER TABLE sessions ADD COLUMN skills_active_json TEXT NOT NULL DEFAULT '[]';
-- Add middleware_chain column to sessions for tracking which middlewares ran
ALTER TABLE sessions ADD COLUMN middleware_chain_json TEXT NOT NULL DEFAULT '[]';
""";

# ── Migration from v5 → v6 (conversation intelligence) ────────────────────

MIGRATION_V5_TO_V6 = """\
-- CONVERSATION SCORES — per-turn sentiment & quality analysis
CREATE TABLE IF NOT EXISTS conversation_scores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL DEFAULT '',
    turn_number     INTEGER NOT NULL DEFAULT 0,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    sentiment       TEXT NOT NULL DEFAULT 'neutral',
    sentiment_score REAL NOT NULL DEFAULT 0.0,
    sentiment_confidence REAL NOT NULL DEFAULT 0.0,
    relevance_score REAL NOT NULL DEFAULT 0.0,
    coherence_score REAL NOT NULL DEFAULT 0.0,
    helpfulness_score REAL NOT NULL DEFAULT 0.0,
    safety_score    REAL NOT NULL DEFAULT 1.0,
    quality_overall REAL NOT NULL DEFAULT 0.0,
    topic           TEXT NOT NULL DEFAULT '',
    intent          TEXT NOT NULL DEFAULT '',
    has_tool_failure INTEGER NOT NULL DEFAULT 0,
    has_hallucination_risk INTEGER NOT NULL DEFAULT 0,
    scorer_model    TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_scores_session ON conversation_scores(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_scores_org ON conversation_scores(org_id);
CREATE INDEX IF NOT EXISTS idx_conv_scores_agent ON conversation_scores(agent_name);
CREATE INDEX IF NOT EXISTS idx_conv_scores_sentiment ON conversation_scores(sentiment);
CREATE INDEX IF NOT EXISTS idx_conv_scores_created ON conversation_scores(created_at);

-- CONVERSATION ANALYTICS — per-session aggregate intelligence
CREATE TABLE IF NOT EXISTS conversation_analytics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL UNIQUE,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    avg_sentiment_score REAL NOT NULL DEFAULT 0.0,
    dominant_sentiment TEXT NOT NULL DEFAULT 'neutral',
    sentiment_trend TEXT NOT NULL DEFAULT 'stable',
    avg_quality     REAL NOT NULL DEFAULT 0.0,
    min_quality     REAL NOT NULL DEFAULT 0.0,
    max_quality     REAL NOT NULL DEFAULT 0.0,
    topics_json     TEXT NOT NULL DEFAULT '[]',
    intents_json    TEXT NOT NULL DEFAULT '[]',
    failure_patterns_json TEXT NOT NULL DEFAULT '[]',
    total_turns     INTEGER NOT NULL DEFAULT 0,
    tool_failure_count INTEGER NOT NULL DEFAULT 0,
    hallucination_risk_count INTEGER NOT NULL DEFAULT 0,
    task_completed  INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_session ON conversation_analytics(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_org ON conversation_analytics(org_id);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_agent ON conversation_analytics(agent_name);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_created ON conversation_analytics(created_at);
""";

# ── Migration from v6 → v7 (gold images, config compliance) ──────────────

MIGRATION_V6_TO_V7 = """\
CREATE TABLE IF NOT EXISTS gold_images (
    image_id        TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    config_json     TEXT NOT NULL DEFAULT '{}',
    config_hash     TEXT NOT NULL DEFAULT '',
    version         TEXT NOT NULL DEFAULT '1.0.0',
    category        TEXT NOT NULL DEFAULT 'general',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_by      TEXT NOT NULL DEFAULT '',
    approved_by     TEXT NOT NULL DEFAULT '',
    approved_at     REAL,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_gold_org ON gold_images(org_id);
CREATE INDEX IF NOT EXISTS idx_gold_name ON gold_images(name);
CREATE INDEX IF NOT EXISTS idx_gold_active ON gold_images(is_active);
CREATE INDEX IF NOT EXISTS idx_gold_hash ON gold_images(config_hash);

CREATE TABLE IF NOT EXISTS compliance_checks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL,
    image_id        TEXT NOT NULL DEFAULT '',
    image_name      TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'unchecked',
    drift_count     INTEGER NOT NULL DEFAULT 0,
    drift_fields    TEXT NOT NULL DEFAULT '[]',
    drift_details_json TEXT NOT NULL DEFAULT '{}',
    checked_by      TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_compliance_org ON compliance_checks(org_id);
CREATE INDEX IF NOT EXISTS idx_compliance_agent ON compliance_checks(agent_name);
CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance_checks(status);
CREATE INDEX IF NOT EXISTS idx_compliance_image ON compliance_checks(image_id);

CREATE TABLE IF NOT EXISTS config_audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    action          TEXT NOT NULL DEFAULT '',
    field_changed   TEXT NOT NULL DEFAULT '',
    old_value       TEXT NOT NULL DEFAULT '',
    new_value       TEXT NOT NULL DEFAULT '',
    change_reason   TEXT NOT NULL DEFAULT '',
    changed_by      TEXT NOT NULL DEFAULT '',
    image_id        TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_config_audit_org ON config_audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_config_audit_agent ON config_audit_log(agent_name);
CREATE INDEX IF NOT EXISTS idx_config_audit_created ON config_audit_log(created_at);
""";

# ── Migration from v7 → v8 (session tenancy columns) ──────────────────────

MIGRATION_V7_TO_V8 = """\
ALTER TABLE sessions ADD COLUMN org_id TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
""";

# ── Migration from v8 → v9 (issue tracking) ──────────────────────────────

MIGRATION_V8_TO_V9 = """\
CREATE TABLE IF NOT EXISTS issues (
    issue_id        TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT 'unknown',
    severity        TEXT NOT NULL DEFAULT 'low',
    status          TEXT NOT NULL DEFAULT 'open',
    source          TEXT NOT NULL DEFAULT 'auto',
    source_session_id TEXT NOT NULL DEFAULT '',
    source_turn     INTEGER NOT NULL DEFAULT 0,
    suggested_fix   TEXT NOT NULL DEFAULT '',
    fix_applied     INTEGER NOT NULL DEFAULT 0,
    assigned_to     TEXT NOT NULL DEFAULT '',
    resolved_by     TEXT NOT NULL DEFAULT '',
    resolved_at     REAL,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_issues_org ON issues(org_id);
CREATE INDEX IF NOT EXISTS idx_issues_agent ON issues(agent_name);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_category ON issues(category);
CREATE INDEX IF NOT EXISTS idx_issues_severity ON issues(severity);
CREATE INDEX IF NOT EXISTS idx_issues_created ON issues(created_at);
""";

# ── Migration from v9 → v10 (security red-teaming, AIVSS) ────────────────

MIGRATION_V9_TO_V10 = """\
CREATE TABLE IF NOT EXISTS security_scans (
    scan_id         TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    scan_type       TEXT NOT NULL DEFAULT 'full',
    status          TEXT NOT NULL DEFAULT 'pending',
    total_probes    INTEGER NOT NULL DEFAULT 0,
    passed          INTEGER NOT NULL DEFAULT 0,
    failed          INTEGER NOT NULL DEFAULT 0,
    errors          INTEGER NOT NULL DEFAULT 0,
    risk_score      REAL NOT NULL DEFAULT 0.0,
    risk_level      TEXT NOT NULL DEFAULT 'unknown',
    started_at      REAL,
    completed_at    REAL,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_scans_org ON security_scans(org_id);
CREATE INDEX IF NOT EXISTS idx_scans_agent ON security_scans(agent_name);
CREATE INDEX IF NOT EXISTS idx_scans_status ON security_scans(status);

CREATE TABLE IF NOT EXISTS security_findings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id         TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    probe_id        TEXT NOT NULL DEFAULT '',
    probe_name      TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT '',
    layer           TEXT NOT NULL DEFAULT '',
    severity        TEXT NOT NULL DEFAULT 'info',
    status          TEXT NOT NULL DEFAULT 'open',
    title           TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    evidence        TEXT NOT NULL DEFAULT '',
    remediation     TEXT NOT NULL DEFAULT '',
    aivss_vector    TEXT NOT NULL DEFAULT '',
    aivss_score     REAL NOT NULL DEFAULT 0.0,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_findings_scan ON security_findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_agent ON security_findings(agent_name);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON security_findings(severity);
CREATE INDEX IF NOT EXISTS idx_findings_category ON security_findings(category);

CREATE TABLE IF NOT EXISTS agent_risk_profiles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL UNIQUE,
    risk_score      REAL NOT NULL DEFAULT 0.0,
    risk_level      TEXT NOT NULL DEFAULT 'unknown',
    aivss_vector_json TEXT NOT NULL DEFAULT '{}',
    last_scan_id    TEXT NOT NULL DEFAULT '',
    findings_summary_json TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_risk_org ON agent_risk_profiles(org_id);
CREATE INDEX IF NOT EXISTS idx_risk_agent ON agent_risk_profiles(agent_name);
CREATE INDEX IF NOT EXISTS idx_risk_level ON agent_risk_profiles(risk_level);
""";

# ── Migration from v10 → v11 (Vapi voice integration) ────────────────────

MIGRATION_V10_TO_V11 = """\
CREATE TABLE IF NOT EXISTS vapi_calls (
    call_id         TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    phone_number    TEXT NOT NULL DEFAULT '',
    direction       TEXT NOT NULL DEFAULT 'outbound',
    status          TEXT NOT NULL DEFAULT 'pending',
    duration_seconds REAL NOT NULL DEFAULT 0.0,
    transcript      TEXT NOT NULL DEFAULT '',
    cost_usd        REAL NOT NULL DEFAULT 0.0,
    vapi_assistant_id TEXT NOT NULL DEFAULT '',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    started_at      REAL,
    ended_at        REAL,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_org ON vapi_calls(org_id);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_agent ON vapi_calls(agent_name);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_status ON vapi_calls(status);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_created ON vapi_calls(created_at);

CREATE TABLE IF NOT EXISTS vapi_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id         TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    event_type      TEXT NOT NULL DEFAULT '',
    payload_json    TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_vapi_events_call ON vapi_events(call_id);
CREATE INDEX IF NOT EXISTS idx_vapi_events_type ON vapi_events(event_type);
""";

MIGRATION_V11_TO_V12 = """\
-- Generic voice_calls table for ElevenLabs, Retell, Bland, Tavus (Vapi keeps its own table)
CREATE TABLE IF NOT EXISTS voice_calls (
    call_id         TEXT PRIMARY KEY,
    platform        TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    phone_number    TEXT NOT NULL DEFAULT '',
    direction       TEXT NOT NULL DEFAULT 'outbound',
    status          TEXT NOT NULL DEFAULT 'pending',
    duration_seconds REAL NOT NULL DEFAULT 0.0,
    transcript      TEXT NOT NULL DEFAULT '',
    cost_usd        REAL NOT NULL DEFAULT 0.0,
    platform_agent_id TEXT NOT NULL DEFAULT '',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    started_at      REAL,
    ended_at        REAL,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_calls_platform ON voice_calls(platform);
CREATE INDEX IF NOT EXISTS idx_voice_calls_org ON voice_calls(org_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_agent ON voice_calls(agent_name);
CREATE INDEX IF NOT EXISTS idx_voice_calls_status ON voice_calls(status);
CREATE INDEX IF NOT EXISTS idx_voice_calls_created ON voice_calls(created_at);

CREATE TABLE IF NOT EXISTS voice_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id         TEXT NOT NULL DEFAULT '',
    platform        TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    event_type      TEXT NOT NULL DEFAULT '',
    payload_json    TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_events_call ON voice_events(call_id);
CREATE INDEX IF NOT EXISTS idx_voice_events_platform ON voice_events(platform);
CREATE INDEX IF NOT EXISTS idx_voice_events_type ON voice_events(event_type);
""";

MIGRATION_V12_TO_V13 = """\
ALTER TABLE billing_records ADD COLUMN pricing_source TEXT NOT NULL DEFAULT 'fallback_env';
ALTER TABLE billing_records ADD COLUMN pricing_key TEXT NOT NULL DEFAULT '';
ALTER TABLE billing_records ADD COLUMN unit TEXT NOT NULL DEFAULT '';
ALTER TABLE billing_records ADD COLUMN unit_price_usd REAL NOT NULL DEFAULT 0.0;
ALTER TABLE billing_records ADD COLUMN quantity REAL NOT NULL DEFAULT 0.0;
ALTER TABLE billing_records ADD COLUMN pricing_version TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS pricing_catalog (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    provider        TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    resource_type   TEXT NOT NULL DEFAULT '',
    operation       TEXT NOT NULL DEFAULT '',
    unit            TEXT NOT NULL DEFAULT '',
    unit_price_usd  REAL NOT NULL DEFAULT 0.0,
    currency        TEXT NOT NULL DEFAULT 'USD',
    source          TEXT NOT NULL DEFAULT 'manual',
    pricing_version TEXT NOT NULL DEFAULT '',
    effective_from  REAL NOT NULL DEFAULT 0.0,
    effective_to    REAL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_pricing_lookup ON pricing_catalog(resource_type, provider, model, operation, unit, is_active, effective_from);
CREATE INDEX IF NOT EXISTS idx_pricing_effective ON pricing_catalog(effective_from, effective_to);
""";

MIGRATION_V13_TO_V14 = """\
CREATE TABLE IF NOT EXISTS autoresearch_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    mode            TEXT NOT NULL DEFAULT 'agent',
    primary_metric  TEXT NOT NULL DEFAULT 'pass_rate',
    max_iterations  INTEGER NOT NULL DEFAULT 0,
    proposer_model  TEXT NOT NULL DEFAULT '',
    proposer_provider TEXT NOT NULL DEFAULT '',
    backend         TEXT NOT NULL DEFAULT 'in-process',
    status          TEXT NOT NULL DEFAULT 'running',
    total_iterations INTEGER NOT NULL DEFAULT 0,
    baseline_score  REAL NOT NULL DEFAULT 0.0,
    best_score      REAL NOT NULL DEFAULT 0.0,
    improvements_kept INTEGER NOT NULL DEFAULT 0,
    experiments_discarded INTEGER NOT NULL DEFAULT 0,
    experiments_crashed INTEGER NOT NULL DEFAULT 0,
    best_config_json TEXT NOT NULL DEFAULT '{}',
    applied         INTEGER NOT NULL DEFAULT 0,
    total_inference_cost_usd REAL NOT NULL DEFAULT 0.0,
    total_gpu_cost_usd REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    elapsed_seconds REAL NOT NULL DEFAULT 0.0,
    started_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    completed_at    REAL,
    source          TEXT NOT NULL DEFAULT 'backend',
    error_message   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ar_runs_agent ON autoresearch_runs(agent_name);
CREATE INDEX IF NOT EXISTS idx_ar_runs_org ON autoresearch_runs(org_id);
CREATE INDEX IF NOT EXISTS idx_ar_runs_status ON autoresearch_runs(status);
CREATE INDEX IF NOT EXISTS idx_ar_runs_started ON autoresearch_runs(started_at);

CREATE TABLE IF NOT EXISTS autoresearch_experiments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    iteration       INTEGER NOT NULL DEFAULT 0,
    hypothesis      TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    modification_json TEXT NOT NULL DEFAULT '{}',
    config_before_json TEXT NOT NULL DEFAULT '{}',
    config_after_json TEXT NOT NULL DEFAULT '{}',
    score_before    REAL NOT NULL DEFAULT 0.0,
    score_after     REAL NOT NULL DEFAULT 0.0,
    improvement     REAL NOT NULL DEFAULT 0.0,
    primary_metric  TEXT NOT NULL DEFAULT 'pass_rate',
    all_metrics_json TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'discard',
    val_bpb         REAL NOT NULL DEFAULT 0.0,
    peak_vram_mb    REAL NOT NULL DEFAULT 0.0,
    training_seconds REAL NOT NULL DEFAULT 0.0,
    num_steps       INTEGER NOT NULL DEFAULT 0,
    num_params_m    REAL NOT NULL DEFAULT 0.0,
    inference_cost_usd REAL NOT NULL DEFAULT 0.0,
    gpu_cost_usd    REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    commit_hash     TEXT NOT NULL DEFAULT '',
    error_message   TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_ar_exp_run ON autoresearch_experiments(run_id);
CREATE INDEX IF NOT EXISTS idx_ar_exp_agent ON autoresearch_experiments(agent_name);
CREATE INDEX IF NOT EXISTS idx_ar_exp_status ON autoresearch_experiments(status);
CREATE INDEX IF NOT EXISTS idx_ar_exp_created ON autoresearch_experiments(created_at);
""";

MIGRATION_V14_TO_V15 = """\
CREATE TABLE IF NOT EXISTS agents (
    agent_id        TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    project_id      TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    version         TEXT NOT NULL DEFAULT '0.1.0',
    config_json     TEXT NOT NULL DEFAULT '{}',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_by      TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_org_project_name
    ON agents(org_id, project_id, name);
CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org_id);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(org_id, project_id);
CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
""";

RUNTIME_TABLES_SQL = """\
CREATE TABLE IF NOT EXISTS billing_records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    customer_id     TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    cost_type       TEXT NOT NULL DEFAULT 'inference',
    description     TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    provider        TEXT NOT NULL DEFAULT '',
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    inference_cost_usd REAL NOT NULL DEFAULT 0.0,
    gpu_type        TEXT NOT NULL DEFAULT '',
    gpu_hours       REAL NOT NULL DEFAULT 0.0,
    gpu_cost_usd    REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    pricing_source  TEXT NOT NULL DEFAULT 'fallback_env',
    pricing_key     TEXT NOT NULL DEFAULT '',
    unit            TEXT NOT NULL DEFAULT '',
    unit_price_usd  REAL NOT NULL DEFAULT 0.0,
    quantity        REAL NOT NULL DEFAULT 0.0,
    pricing_version TEXT NOT NULL DEFAULT '',
    session_id      TEXT NOT NULL DEFAULT '',
    trace_id        TEXT NOT NULL DEFAULT '',
    period_start    REAL,
    period_end      REAL,
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_billing_org ON billing_records(org_id);
CREATE INDEX IF NOT EXISTS idx_billing_customer ON billing_records(customer_id);
CREATE INDEX IF NOT EXISTS idx_billing_created ON billing_records(created_at);
CREATE INDEX IF NOT EXISTS idx_billing_type ON billing_records(cost_type);

CREATE TABLE IF NOT EXISTS pricing_catalog (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    provider        TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    resource_type   TEXT NOT NULL DEFAULT '',
    operation       TEXT NOT NULL DEFAULT '',
    unit            TEXT NOT NULL DEFAULT '',
    unit_price_usd  REAL NOT NULL DEFAULT 0.0,
    currency        TEXT NOT NULL DEFAULT 'USD',
    source          TEXT NOT NULL DEFAULT 'manual',
    pricing_version TEXT NOT NULL DEFAULT '',
    effective_from  REAL NOT NULL DEFAULT 0.0,
    effective_to    REAL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT 0,
    updated_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pricing_lookup ON pricing_catalog(resource_type, provider, model, operation, unit, is_active, effective_from);
CREATE INDEX IF NOT EXISTS idx_pricing_effective ON pricing_catalog(effective_from, effective_to);

CREATE TABLE IF NOT EXISTS otel_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL DEFAULT '',
    turn            INTEGER NOT NULL DEFAULT 0,
    event_type      TEXT NOT NULL DEFAULT '',
    action          TEXT NOT NULL DEFAULT '',
    plan            TEXT NOT NULL DEFAULT '',
    tier            TEXT NOT NULL DEFAULT '',
    provider        TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    tool_name       TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT '',
    latency_ms      REAL NOT NULL DEFAULT 0.0,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0.0,
    details_json    TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_otel_session ON otel_events(session_id);
CREATE INDEX IF NOT EXISTS idx_otel_event_type ON otel_events(event_type);
CREATE INDEX IF NOT EXISTS idx_otel_created ON otel_events(created_at);

CREATE TABLE IF NOT EXISTS conversation_scores (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT NOT NULL,
    turn_number       INTEGER NOT NULL DEFAULT 1,
    org_id            TEXT NOT NULL DEFAULT '',
    agent_name        TEXT NOT NULL DEFAULT '',
    sentiment         TEXT NOT NULL DEFAULT 'neutral',
    sentiment_score   REAL NOT NULL DEFAULT 0.0,
    relevance_score   REAL NOT NULL DEFAULT 0.0,
    coherence_score   REAL NOT NULL DEFAULT 0.0,
    helpfulness_score REAL NOT NULL DEFAULT 0.0,
    quality_overall   REAL NOT NULL DEFAULT 0.0,
    topic             TEXT NOT NULL DEFAULT '',
    intent            TEXT NOT NULL DEFAULT '',
    has_tool_failure  INTEGER NOT NULL DEFAULT 0,
    created_at        REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_scores_session ON conversation_scores(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_scores_org ON conversation_scores(org_id);
CREATE INDEX IF NOT EXISTS idx_conv_scores_agent ON conversation_scores(agent_name);

CREATE TABLE IF NOT EXISTS conversation_analytics (
    session_id          TEXT PRIMARY KEY,
    org_id              TEXT NOT NULL DEFAULT '',
    agent_name          TEXT NOT NULL DEFAULT '',
    avg_sentiment_score REAL NOT NULL DEFAULT 0.0,
    dominant_sentiment  TEXT NOT NULL DEFAULT 'neutral',
    sentiment_trend     TEXT NOT NULL DEFAULT 'stable',
    avg_quality         REAL NOT NULL DEFAULT 0.0,
    topics_json         TEXT NOT NULL DEFAULT '[]',
    total_turns         INTEGER NOT NULL DEFAULT 0,
    tool_failure_count  INTEGER NOT NULL DEFAULT 0,
    created_at          REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_org ON conversation_analytics(org_id);
CREATE INDEX IF NOT EXISTS idx_conv_analytics_agent ON conversation_analytics(agent_name);

CREATE TABLE IF NOT EXISTS config_audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    action          TEXT NOT NULL DEFAULT '',
    field_changed   TEXT NOT NULL DEFAULT '',
    old_value       TEXT NOT NULL DEFAULT '',
    new_value       TEXT NOT NULL DEFAULT '',
    change_reason   TEXT NOT NULL DEFAULT '',
    changed_by      TEXT NOT NULL DEFAULT '',
    image_id        TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_config_audit_org ON config_audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_config_audit_agent ON config_audit_log(agent_name);
CREATE INDEX IF NOT EXISTS idx_config_audit_created ON config_audit_log(created_at);

CREATE TABLE IF NOT EXISTS gold_images (
    image_id         TEXT PRIMARY KEY,
    org_id           TEXT NOT NULL DEFAULT '',
    name             TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    config_json      TEXT NOT NULL DEFAULT '{}',
    config_hash      TEXT NOT NULL DEFAULT '',
    version          TEXT NOT NULL DEFAULT '1.0.0',
    category         TEXT NOT NULL DEFAULT 'general',
    is_active        INTEGER NOT NULL DEFAULT 1,
    created_by       TEXT NOT NULL DEFAULT '',
    approved_by      TEXT NOT NULL DEFAULT '',
    approved_at      REAL,
    created_at       REAL NOT NULL DEFAULT 0,
    updated_at       REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gold_org ON gold_images(org_id);
CREATE INDEX IF NOT EXISTS idx_gold_active ON gold_images(is_active);

CREATE TABLE IF NOT EXISTS compliance_checks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id            TEXT NOT NULL DEFAULT '',
    agent_name        TEXT NOT NULL DEFAULT '',
    image_id          TEXT NOT NULL DEFAULT '',
    image_name        TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'unchecked',
    drift_count       INTEGER NOT NULL DEFAULT 0,
    drift_fields      TEXT NOT NULL DEFAULT '[]',
    drift_details_json TEXT NOT NULL DEFAULT '{}',
    checked_by        TEXT NOT NULL DEFAULT '',
    created_at        REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_compliance_org ON compliance_checks(org_id);
CREATE INDEX IF NOT EXISTS idx_compliance_agent ON compliance_checks(agent_name);
CREATE INDEX IF NOT EXISTS idx_compliance_image ON compliance_checks(image_id);

CREATE TABLE IF NOT EXISTS issues (
    issue_id         TEXT PRIMARY KEY,
    org_id           TEXT NOT NULL DEFAULT '',
    agent_name       TEXT NOT NULL DEFAULT '',
    title            TEXT NOT NULL DEFAULT '',
    description      TEXT NOT NULL DEFAULT '',
    category         TEXT NOT NULL DEFAULT 'unknown',
    severity         TEXT NOT NULL DEFAULT 'low',
    status           TEXT NOT NULL DEFAULT 'open',
    source           TEXT NOT NULL DEFAULT 'auto',
    source_session_id TEXT NOT NULL DEFAULT '',
    source_turn      INTEGER NOT NULL DEFAULT 0,
    suggested_fix    TEXT NOT NULL DEFAULT '',
    metadata_json    TEXT NOT NULL DEFAULT '{}',
    created_at       REAL NOT NULL DEFAULT 0,
    updated_at       REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_issues_org ON issues(org_id);
CREATE INDEX IF NOT EXISTS idx_issues_agent ON issues(agent_name);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_severity ON issues(severity);
CREATE INDEX IF NOT EXISTS idx_issues_created ON issues(created_at);

CREATE TABLE IF NOT EXISTS security_scans (
    scan_id          TEXT PRIMARY KEY,
    org_id           TEXT NOT NULL DEFAULT '',
    agent_name       TEXT NOT NULL DEFAULT '',
    scan_type        TEXT NOT NULL DEFAULT 'full',
    status           TEXT NOT NULL DEFAULT 'pending',
    total_probes     INTEGER NOT NULL DEFAULT 0,
    passed           INTEGER NOT NULL DEFAULT 0,
    failed           INTEGER NOT NULL DEFAULT 0,
    errors           INTEGER NOT NULL DEFAULT 0,
    risk_score       REAL NOT NULL DEFAULT 0.0,
    risk_level       TEXT NOT NULL DEFAULT 'unknown',
    started_at       REAL,
    completed_at     REAL,
    created_at       REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scans_org ON security_scans(org_id);
CREATE INDEX IF NOT EXISTS idx_scans_agent ON security_scans(agent_name);
CREATE INDEX IF NOT EXISTS idx_scans_status ON security_scans(status);
CREATE INDEX IF NOT EXISTS idx_scans_created ON security_scans(created_at);

CREATE TABLE IF NOT EXISTS security_findings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id          TEXT NOT NULL DEFAULT '',
    org_id           TEXT NOT NULL DEFAULT '',
    agent_name       TEXT NOT NULL DEFAULT '',
    probe_id         TEXT NOT NULL DEFAULT '',
    probe_name       TEXT NOT NULL DEFAULT '',
    category         TEXT NOT NULL DEFAULT '',
    layer            TEXT NOT NULL DEFAULT '',
    severity         TEXT NOT NULL DEFAULT 'info',
    status           TEXT NOT NULL DEFAULT 'open',
    title            TEXT NOT NULL DEFAULT '',
    description      TEXT NOT NULL DEFAULT '',
    evidence         TEXT NOT NULL DEFAULT '',
    remediation      TEXT NOT NULL DEFAULT '',
    aivss_vector     TEXT NOT NULL DEFAULT '',
    aivss_score      REAL NOT NULL DEFAULT 0.0,
    created_at       REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_findings_scan ON security_findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_org ON security_findings(org_id);
CREATE INDEX IF NOT EXISTS idx_findings_agent ON security_findings(agent_name);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON security_findings(severity);

CREATE TABLE IF NOT EXISTS agent_risk_profiles (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id              TEXT NOT NULL DEFAULT '',
    agent_name          TEXT NOT NULL DEFAULT '',
    risk_score          REAL NOT NULL DEFAULT 0.0,
    risk_level          TEXT NOT NULL DEFAULT 'unknown',
    aivss_vector_json   TEXT NOT NULL DEFAULT '{}',
    last_scan_id        TEXT NOT NULL DEFAULT '',
    findings_summary_json TEXT NOT NULL DEFAULT '{}',
    created_at          REAL NOT NULL DEFAULT 0,
    updated_at          REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_risk_org ON agent_risk_profiles(org_id);
CREATE INDEX IF NOT EXISTS idx_risk_agent ON agent_risk_profiles(agent_name);

CREATE TABLE IF NOT EXISTS vapi_calls (
    call_id         TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    phone_number    TEXT NOT NULL DEFAULT '',
    direction       TEXT NOT NULL DEFAULT 'outbound',
    status          TEXT NOT NULL DEFAULT 'pending',
    duration_seconds REAL NOT NULL DEFAULT 0.0,
    transcript      TEXT NOT NULL DEFAULT '',
    cost_usd        REAL NOT NULL DEFAULT 0.0,
    vapi_assistant_id TEXT NOT NULL DEFAULT '',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    started_at      REAL,
    ended_at        REAL,
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_org ON vapi_calls(org_id);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_agent ON vapi_calls(agent_name);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_status ON vapi_calls(status);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_created ON vapi_calls(created_at);

CREATE TABLE IF NOT EXISTS vapi_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id         TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    event_type      TEXT NOT NULL DEFAULT '',
    payload_json    TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vapi_events_call ON vapi_events(call_id);
CREATE INDEX IF NOT EXISTS idx_vapi_events_type ON vapi_events(event_type);

CREATE TABLE IF NOT EXISTS voice_calls (
    call_id         TEXT PRIMARY KEY,
    platform        TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    phone_number    TEXT NOT NULL DEFAULT '',
    direction       TEXT NOT NULL DEFAULT 'outbound',
    status          TEXT NOT NULL DEFAULT 'pending',
    duration_seconds REAL NOT NULL DEFAULT 0.0,
    transcript      TEXT NOT NULL DEFAULT '',
    cost_usd        REAL NOT NULL DEFAULT 0.0,
    platform_agent_id TEXT NOT NULL DEFAULT '',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    started_at      REAL,
    ended_at        REAL,
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_voice_calls_platform ON voice_calls(platform);
CREATE INDEX IF NOT EXISTS idx_voice_calls_org ON voice_calls(org_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_agent ON voice_calls(agent_name);
CREATE INDEX IF NOT EXISTS idx_voice_calls_status ON voice_calls(status);
CREATE INDEX IF NOT EXISTS idx_voice_calls_created ON voice_calls(created_at);

CREATE TABLE IF NOT EXISTS voice_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id         TEXT NOT NULL DEFAULT '',
    platform        TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    event_type      TEXT NOT NULL DEFAULT '',
    payload_json    TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_voice_events_call ON voice_events(call_id);
CREATE INDEX IF NOT EXISTS idx_voice_events_platform ON voice_events(platform);
CREATE INDEX IF NOT EXISTS idx_voice_events_type ON voice_events(event_type);

CREATE TABLE IF NOT EXISTS projects (
    project_id      TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    default_env     TEXT NOT NULL DEFAULT 'development',
    default_plan    TEXT NOT NULL DEFAULT 'standard',
    settings_json   TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT 0,
    updated_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);

CREATE TABLE IF NOT EXISTS environments (
    env_id          TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL DEFAULT 'development',
    plan            TEXT NOT NULL DEFAULT '',
    provider_config_json TEXT NOT NULL DEFAULT '{}',
    secrets_json    TEXT NOT NULL DEFAULT '{}',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_env_project ON environments(project_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    project_id      TEXT NOT NULL DEFAULT '',
    user_id         TEXT NOT NULL DEFAULT '',
    action          TEXT NOT NULL,
    resource_type   TEXT NOT NULL DEFAULT '',
    resource_id     TEXT NOT NULL DEFAULT '',
    changes_json    TEXT NOT NULL DEFAULT '{}',
    ip_address      TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

CREATE TABLE IF NOT EXISTS event_types (
    event_type      TEXT PRIMARY KEY,
    category        TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    schema_json     TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS policy_templates (
    policy_id       TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    policy_json     TEXT NOT NULL DEFAULT '{}',
    is_default      INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL DEFAULT 0,
    updated_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_policy_org ON policy_templates(org_id);

CREATE TABLE IF NOT EXISTS slo_definitions (
    slo_id          TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    env             TEXT NOT NULL DEFAULT '',
    metric          TEXT NOT NULL,
    threshold       REAL NOT NULL,
    operator        TEXT NOT NULL DEFAULT 'gte',
    window_hours    INTEGER NOT NULL DEFAULT 24,
    alert_on_breach INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_slo_org ON slo_definitions(org_id);
CREATE INDEX IF NOT EXISTS idx_slo_agent ON slo_definitions(agent_name);

CREATE TABLE IF NOT EXISTS release_channels (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL,
    channel         TEXT NOT NULL DEFAULT 'draft',
    version         TEXT NOT NULL,
    config_json     TEXT NOT NULL DEFAULT '{}',
    promoted_by     TEXT NOT NULL DEFAULT '',
    promoted_at     REAL,
    created_at      REAL NOT NULL DEFAULT 0,
    UNIQUE(agent_name, channel)
);
CREATE INDEX IF NOT EXISTS idx_release_agent ON release_channels(agent_name);

CREATE TABLE IF NOT EXISTS canary_splits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name      TEXT NOT NULL,
    env             TEXT NOT NULL DEFAULT 'production',
    primary_version TEXT NOT NULL,
    canary_version  TEXT NOT NULL,
    canary_weight   REAL NOT NULL DEFAULT 0.1,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workflows (
    workflow_id     TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    steps_json      TEXT NOT NULL DEFAULT '[]',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_workflow_org ON workflows(org_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id            TEXT PRIMARY KEY,
    workflow_id       TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'running',
    steps_status_json TEXT NOT NULL DEFAULT '{}',
    dag_json          TEXT NOT NULL DEFAULT '{}',
    reflection_json   TEXT NOT NULL DEFAULT '{}',
    trace_id          TEXT NOT NULL DEFAULT '',
    total_cost_usd    REAL NOT NULL DEFAULT 0.0,
    started_at        REAL NOT NULL DEFAULT 0,
    completed_at      REAL
);
CREATE INDEX IF NOT EXISTS idx_wfrun_workflow ON workflow_runs(workflow_id);

CREATE TABLE IF NOT EXISTS retention_policies (
    policy_id       TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    resource_type   TEXT NOT NULL,
    retention_days  INTEGER NOT NULL DEFAULT 90,
    redact_pii      INTEGER NOT NULL DEFAULT 0,
    redact_fields   TEXT NOT NULL DEFAULT '[]',
    archive_before_delete INTEGER NOT NULL DEFAULT 1,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_retention_org ON retention_policies(org_id);

CREATE TABLE IF NOT EXISTS secrets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          TEXT NOT NULL DEFAULT '',
    project_id      TEXT NOT NULL DEFAULT '',
    env             TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    value_encrypted TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT 0,
    updated_at      REAL NOT NULL DEFAULT 0,
    UNIQUE(org_id, project_id, env, name)
);
CREATE INDEX IF NOT EXISTS idx_secrets_org ON secrets(org_id);

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
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mcp_org ON mcp_servers(org_id);

CREATE TABLE IF NOT EXISTS gpu_endpoints (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id     TEXT NOT NULL UNIQUE,
    org_id          TEXT NOT NULL DEFAULT '',
    provider        TEXT NOT NULL DEFAULT 'gmi',
    gpu_type        TEXT NOT NULL DEFAULT 'h100',
    gpu_count       INTEGER NOT NULL DEFAULT 1,
    model_id        TEXT NOT NULL DEFAULT '',
    api_base        TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'provisioning',
    hourly_rate_usd REAL NOT NULL DEFAULT 2.98,
    started_at      REAL,
    stopped_at      REAL,
    total_hours     REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gpu_endpoint_id ON gpu_endpoints(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_gpu_status ON gpu_endpoints(status);
CREATE INDEX IF NOT EXISTS idx_gpu_org ON gpu_endpoints(org_id);

CREATE TABLE IF NOT EXISTS job_queue (
    job_id          TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL,
    task            TEXT NOT NULL,
    idempotency_key TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending',
    priority        INTEGER NOT NULL DEFAULT 0,
    retries         INTEGER NOT NULL DEFAULT 0,
    max_retries     INTEGER NOT NULL DEFAULT 3,
    result_json     TEXT NOT NULL DEFAULT '{}',
    error           TEXT NOT NULL DEFAULT '',
    session_id      TEXT NOT NULL DEFAULT '',
    scheduled_at    REAL,
    started_at      REAL,
    completed_at    REAL,
    created_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_job_status ON job_queue(status);
CREATE INDEX IF NOT EXISTS idx_job_agent ON job_queue(agent_name);
CREATE INDEX IF NOT EXISTS idx_job_idempotency ON job_queue(idempotency_key);

CREATE TABLE IF NOT EXISTS autoresearch_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    mode            TEXT NOT NULL DEFAULT 'agent',
    primary_metric  TEXT NOT NULL DEFAULT 'pass_rate',
    max_iterations  INTEGER NOT NULL DEFAULT 0,
    proposer_model  TEXT NOT NULL DEFAULT '',
    proposer_provider TEXT NOT NULL DEFAULT '',
    backend         TEXT NOT NULL DEFAULT 'in-process',
    status          TEXT NOT NULL DEFAULT 'running',
    total_iterations INTEGER NOT NULL DEFAULT 0,
    baseline_score  REAL NOT NULL DEFAULT 0.0,
    best_score      REAL NOT NULL DEFAULT 0.0,
    improvements_kept INTEGER NOT NULL DEFAULT 0,
    experiments_discarded INTEGER NOT NULL DEFAULT 0,
    experiments_crashed INTEGER NOT NULL DEFAULT 0,
    best_config_json TEXT NOT NULL DEFAULT '{}',
    applied         INTEGER NOT NULL DEFAULT 0,
    total_inference_cost_usd REAL NOT NULL DEFAULT 0.0,
    total_gpu_cost_usd REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    elapsed_seconds REAL NOT NULL DEFAULT 0.0,
    started_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    completed_at    REAL,
    source          TEXT NOT NULL DEFAULT 'backend',
    error_message   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ar_runs_agent ON autoresearch_runs(agent_name);
CREATE INDEX IF NOT EXISTS idx_ar_runs_org ON autoresearch_runs(org_id);

CREATE TABLE IF NOT EXISTS autoresearch_experiments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL DEFAULT '',
    org_id          TEXT NOT NULL DEFAULT '',
    agent_name      TEXT NOT NULL DEFAULT '',
    iteration       INTEGER NOT NULL DEFAULT 0,
    hypothesis      TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    modification_json TEXT NOT NULL DEFAULT '{}',
    config_before_json TEXT NOT NULL DEFAULT '{}',
    config_after_json TEXT NOT NULL DEFAULT '{}',
    score_before    REAL NOT NULL DEFAULT 0.0,
    score_after     REAL NOT NULL DEFAULT 0.0,
    improvement     REAL NOT NULL DEFAULT 0.0,
    primary_metric  TEXT NOT NULL DEFAULT 'pass_rate',
    all_metrics_json TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'discard',
    val_bpb         REAL NOT NULL DEFAULT 0.0,
    peak_vram_mb    REAL NOT NULL DEFAULT 0.0,
    training_seconds REAL NOT NULL DEFAULT 0.0,
    num_steps       INTEGER NOT NULL DEFAULT 0,
    num_params_m    REAL NOT NULL DEFAULT 0.0,
    inference_cost_usd REAL NOT NULL DEFAULT 0.0,
    gpu_cost_usd    REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    commit_hash     TEXT NOT NULL DEFAULT '',
    error_message   TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS idx_ar_exp_run ON autoresearch_experiments(run_id);
CREATE INDEX IF NOT EXISTS idx_ar_exp_agent ON autoresearch_experiments(agent_name);
"""


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
            # Fresh database — create everything from scratch.
            # SCHEMA_SQL covers tables up to ~V13.  We then run only
            # post-SCHEMA_SQL migrations to add newer tables (e.g. V15
            # agents table) without replaying all 13 old migrations.
            self.conn.executescript(SCHEMA_SQL)
            self._migrate_post_schema(current)
        else:
            # Existing database — apply all pending migrations
            self._migrate(current)
        self._ensure_runtime_tables()
        self._ensure_runtime_columns()

        self.conn.execute(
            "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        self.conn.commit()
        logger.info("Database initialized at %s (schema v%d)", self.path, SCHEMA_VERSION)

    def _ensure_runtime_tables(self) -> None:
        """Ensure operational tables exist even on partially migrated DBs."""
        self.conn.executescript(RUNTIME_TABLES_SQL)

    def _ensure_runtime_columns(self) -> None:
        """Add runtime observability columns for legacy SQLite databases."""
        try:
            turn_cols = {row[1] for row in self.conn.execute("PRAGMA table_info(turns)").fetchall()}
            session_cols = {row[1] for row in self.conn.execute("PRAGMA table_info(sessions)").fetchall()}
        except Exception:
            return
        try:
            api_key_cols = {row[1] for row in self.conn.execute("PRAGMA table_info(api_keys)").fetchall()}
        except Exception:
            api_key_cols = set()  # table may not exist yet (created in migration v2→v3)
        try:
            issue_cols = {row[1] for row in self.conn.execute("PRAGMA table_info(issues)").fetchall()}
        except Exception:
            issue_cols = set()
        try:
            billing_cols = {row[1] for row in self.conn.execute("PRAGMA table_info(billing_records)").fetchall()}
        except Exception:
            billing_cols = set()
        if "execution_mode" not in turn_cols:
            self.conn.execute(
                "ALTER TABLE turns ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'sequential'"
            )
        if "plan_json" not in turn_cols:
            self.conn.execute(
                "ALTER TABLE turns ADD COLUMN plan_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "reflection_json" not in turn_cols:
            self.conn.execute(
                "ALTER TABLE turns ADD COLUMN reflection_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "org_id" not in session_cols:
            self.conn.execute(
                "ALTER TABLE sessions ADD COLUMN org_id TEXT NOT NULL DEFAULT ''"
            )
        if "project_id" not in session_cols:
            self.conn.execute(
                "ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT ''"
            )
        if api_key_cols:
            if "project_id" not in api_key_cols:
                self.conn.execute(
                    "ALTER TABLE api_keys ADD COLUMN project_id TEXT NOT NULL DEFAULT ''"
                )
            if "env" not in api_key_cols:
                self.conn.execute(
                    "ALTER TABLE api_keys ADD COLUMN env TEXT NOT NULL DEFAULT ''"
                )
        if issue_cols:
            if "fix_applied" not in issue_cols:
                self.conn.execute(
                    "ALTER TABLE issues ADD COLUMN fix_applied INTEGER NOT NULL DEFAULT 0"
                )
            if "assigned_to" not in issue_cols:
                self.conn.execute(
                    "ALTER TABLE issues ADD COLUMN assigned_to TEXT NOT NULL DEFAULT ''"
                )
            if "resolved_by" not in issue_cols:
                self.conn.execute(
                    "ALTER TABLE issues ADD COLUMN resolved_by TEXT NOT NULL DEFAULT ''"
                )
            if "resolved_at" not in issue_cols:
                self.conn.execute("ALTER TABLE issues ADD COLUMN resolved_at REAL")
        if billing_cols:
            if "pricing_source" not in billing_cols:
                self.conn.execute(
                    "ALTER TABLE billing_records ADD COLUMN pricing_source TEXT NOT NULL DEFAULT 'fallback_env'"
                )
            if "pricing_key" not in billing_cols:
                self.conn.execute(
                    "ALTER TABLE billing_records ADD COLUMN pricing_key TEXT NOT NULL DEFAULT ''"
                )
            if "unit" not in billing_cols:
                self.conn.execute(
                    "ALTER TABLE billing_records ADD COLUMN unit TEXT NOT NULL DEFAULT ''"
                )
            if "unit_price_usd" not in billing_cols:
                self.conn.execute(
                    "ALTER TABLE billing_records ADD COLUMN unit_price_usd REAL NOT NULL DEFAULT 0.0"
                )
            if "quantity" not in billing_cols:
                self.conn.execute(
                    "ALTER TABLE billing_records ADD COLUMN quantity REAL NOT NULL DEFAULT 0.0"
                )
            if "pricing_version" not in billing_cols:
                self.conn.execute(
                    "ALTER TABLE billing_records ADD COLUMN pricing_version TEXT NOT NULL DEFAULT ''"
                )
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(org_id)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)")
        try:
            wfr_cols = {
                row[1] for row in self.conn.execute("PRAGMA table_info(workflow_runs)").fetchall()
            }
        except Exception:
            wfr_cols = set()
        if "dag_json" not in wfr_cols:
            self.conn.execute(
                "ALTER TABLE workflow_runs ADD COLUMN dag_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "reflection_json" not in wfr_cols:
            self.conn.execute(
                "ALTER TABLE workflow_runs ADD COLUMN reflection_json TEXT NOT NULL DEFAULT '{}'"
            )

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
        if from_version < 5:
            logger.info("Migrating database from v%d to v5 (middleware, skills, async memory)", from_version)
            existing_turn_cols = {
                row[1] for row in self.conn.execute("PRAGMA table_info(turns)").fetchall()
            }
            existing_session_cols = {
                row[1] for row in self.conn.execute("PRAGMA table_info(sessions)").fetchall()
            }
            for stmt in MIGRATION_V4_TO_V5.split(";"):
                stmt = stmt.strip()
                if not stmt:
                    continue
                if "ALTER TABLE" in stmt and "ADD COLUMN" in stmt:
                    col_name = stmt.split("ADD COLUMN")[1].strip().split()[0]
                    if col_name in existing_turn_cols or col_name in existing_session_cols:
                        continue
                try:
                    self.conn.execute(stmt)
                except sqlite3.OperationalError as exc:
                    if "duplicate column" not in str(exc).lower() and "already exists" not in str(exc).lower():
                        logger.debug("v5 migration stmt skipped: %s", exc)
            self._seed_middleware_event_types()
            self.conn.commit()
        if from_version < 6:
            logger.info("Migrating database from v%d to v6 (conversation intelligence)", from_version)
            try:
                self.conn.executescript(MIGRATION_V5_TO_V6)
            except sqlite3.OperationalError as exc:
                logger.debug("v6 migration partial: %s", exc)
            self._seed_conversation_intel_event_types()
            self.conn.commit()
        if from_version < 7:
            logger.info("Migrating database from v%d to v7 (gold images, config compliance)", from_version)
            try:
                self.conn.executescript(MIGRATION_V6_TO_V7)
            except sqlite3.OperationalError as exc:
                logger.debug("v7 migration partial: %s", exc)
            self._seed_gold_image_event_types()
            self.conn.commit()
        if from_version < 8:
            logger.info("Migrating database from v%d to v8 (session tenancy columns)", from_version)
            existing_session_cols = {
                row[1] for row in self.conn.execute("PRAGMA table_info(sessions)").fetchall()
            }
            for stmt in MIGRATION_V7_TO_V8.split(";"):
                stmt = stmt.strip()
                if not stmt:
                    continue
                if "ALTER TABLE" in stmt and "ADD COLUMN" in stmt:
                    col_name = stmt.split("ADD COLUMN")[1].strip().split()[0]
                    if col_name in existing_session_cols:
                        continue
                try:
                    self.conn.execute(stmt)
                except sqlite3.OperationalError as exc:
                    if "duplicate column" not in str(exc).lower() and "already exists" not in str(exc).lower():
                        logger.debug("v8 migration stmt skipped: %s", exc)
            self.conn.commit()
        if from_version < 9:
            logger.info("Migrating database from v%d to v9 (issue tracking)", from_version)
            try:
                self.conn.executescript(MIGRATION_V8_TO_V9)
            except sqlite3.OperationalError as exc:
                logger.debug("v9 migration partial: %s", exc)
            self._seed_issue_event_types()
            self.conn.commit()
        if from_version < 10:
            logger.info("Migrating database from v%d to v10 (security red-teaming, AIVSS)", from_version)
            try:
                self.conn.executescript(MIGRATION_V9_TO_V10)
            except sqlite3.OperationalError as exc:
                logger.debug("v10 migration partial: %s", exc)
            self._seed_security_event_types()
            self.conn.commit()
        if from_version < 11:
            logger.info("Migrating database from v%d to v11 (Vapi voice integration)", from_version)
            try:
                self.conn.executescript(MIGRATION_V10_TO_V11)
            except sqlite3.OperationalError as exc:
                logger.debug("v11 migration partial: %s", exc)
            self.conn.commit()
        if from_version < 12:
            logger.info("Migrating database from v%d to v12 (generic voice platform tables)", from_version)
            try:
                self.conn.executescript(MIGRATION_V11_TO_V12)
            except sqlite3.OperationalError as exc:
                logger.debug("v12 migration partial: %s", exc)
            self.conn.commit()
        if from_version < 13:
            logger.info("Migrating database from v%d to v13 (pricing catalog + billing snapshots)", from_version)
            existing_billing_cols = {
                row[1] for row in self.conn.execute("PRAGMA table_info(billing_records)").fetchall()
            }
            for stmt in MIGRATION_V12_TO_V13.split(";"):
                stmt = stmt.strip()
                if not stmt:
                    continue
                if "ALTER TABLE" in stmt and "ADD COLUMN" in stmt:
                    col_name = stmt.split("ADD COLUMN")[1].strip().split()[0]
                    if col_name in existing_billing_cols:
                        continue
                try:
                    self.conn.execute(stmt)
                except sqlite3.OperationalError as exc:
                    if "duplicate column" not in str(exc).lower() and "already exists" not in str(exc).lower():
                        raise
            self.conn.commit()
        if from_version < 14:
            logger.info("Migrating database from v%d to v14 (autoresearch observability)", from_version)
            try:
                self.conn.executescript(MIGRATION_V13_TO_V14)
            except sqlite3.OperationalError as exc:
                logger.debug("v14 migration partial: %s", exc)
            self.conn.commit()
        if from_version < 15:
            logger.info("Migrating database from v%d to v15 (agents registry table)", from_version)
            try:
                self.conn.executescript(MIGRATION_V14_TO_V15)
            except sqlite3.OperationalError as exc:
                logger.debug("v15 migration partial: %s", exc)
            self.conn.commit()

    def _migrate_post_schema(self, from_version: int) -> None:
        """Run only migrations that add tables beyond what SCHEMA_SQL provides.

        SCHEMA_SQL covers tables up to ~V13.  This method runs V14+ so
        that fresh databases get the agents table etc. without replaying
        all 13 early migrations (which do ALTER TABLE on existing tables
        and cause noise on a clean schema).
        """
        if from_version < 14:
            try:
                self.conn.executescript(MIGRATION_V13_TO_V14)
            except sqlite3.OperationalError as exc:
                logger.debug("v14 post-schema partial: %s", exc)
            self.conn.commit()
        if from_version < 15:
            try:
                self.conn.executescript(MIGRATION_V14_TO_V15)
            except sqlite3.OperationalError as exc:
                logger.debug("v15 post-schema partial: %s", exc)
            self.conn.commit()

    def _seed_security_event_types(self) -> None:
        """Seed security event types."""
        try:
            self.conn.execute("SELECT 1 FROM event_types LIMIT 1")
        except sqlite3.OperationalError:
            return
        events = [
            ("security.scan_started", "security", "Security scan started"),
            ("security.scan_completed", "security", "Security scan completed"),
            ("security.finding_detected", "security", "Security vulnerability found"),
            ("security.risk_updated", "security", "Agent risk profile updated"),
        ]
        for event_type, category, description in events:
            self.conn.execute(
                "INSERT OR IGNORE INTO event_types (event_type, category, description) VALUES (?, ?, ?)",
                (event_type, category, description),
            )

    def _seed_issue_event_types(self) -> None:
        """Seed issue tracking event types."""
        try:
            self.conn.execute("SELECT 1 FROM event_types LIMIT 1")
        except sqlite3.OperationalError:
            return
        events = [
            ("issue.created", "issues", "Issue auto-created from failure"),
            ("issue.triaged", "issues", "Issue triaged and categorized"),
            ("issue.resolved", "issues", "Issue resolved"),
            ("issue.fix_suggested", "issues", "Remediation fix suggested"),
        ]
        for event_type, category, description in events:
            self.conn.execute(
                "INSERT OR IGNORE INTO event_types (event_type, category, description) VALUES (?, ?, ?)",
                (event_type, category, description),
            )

    def _seed_gold_image_event_types(self) -> None:
        """Seed gold image event types."""
        try:
            self.conn.execute("SELECT 1 FROM event_types LIMIT 1")
        except sqlite3.OperationalError:
            return
        events = [
            ("gold_image.created", "config", "Gold image created"),
            ("gold_image.updated", "config", "Gold image updated"),
            ("gold_image.approved", "config", "Gold image approved"),
            ("compliance.checked", "config", "Agent compliance checked against gold image"),
            ("compliance.drift_detected", "config", "Config drift detected from gold image"),
            ("config.changed", "config", "Agent configuration changed"),
        ]
        for event_type, category, description in events:
            self.conn.execute(
                "INSERT OR IGNORE INTO event_types (event_type, category, description) VALUES (?, ?, ?)",
                (event_type, category, description),
            )

    def _seed_conversation_intel_event_types(self) -> None:
        """Seed conversation intelligence event types."""
        try:
            self.conn.execute("SELECT 1 FROM event_types LIMIT 1")
        except sqlite3.OperationalError:
            return
        events = [
            ("intel.scored", "intelligence", "Turn scored for sentiment and quality"),
            ("intel.session_analyzed", "intelligence", "Session conversation analytics computed"),
            ("intel.quality_alert", "intelligence", "Quality score dropped below threshold"),
            ("intel.sentiment_alert", "intelligence", "Negative sentiment detected"),
        ]
        for event_type, category, description in events:
            self.conn.execute(
                "INSERT OR IGNORE INTO event_types (event_type, category, description) VALUES (?, ?, ?)",
                (event_type, category, description),
            )

    def _seed_middleware_event_types(self) -> None:
        """Seed middleware-related event types."""
        try:
            self.conn.execute("SELECT 1 FROM event_types LIMIT 1")
        except sqlite3.OperationalError:
            return
        events = [
            ("middleware.loop_warning", "middleware", "Loop detection issued a warning"),
            ("middleware.loop_hard_stop", "middleware", "Loop detection forced a hard stop"),
            ("middleware.summarized", "middleware", "Context was summarized to save tokens"),
            ("middleware.halt", "middleware", "Middleware halted agent execution"),
            ("skill.loaded", "skill", "Skill was loaded from filesystem"),
            ("skill.enabled", "skill", "Skill was enabled"),
            ("skill.disabled", "skill", "Skill was disabled"),
            ("memory.fact_extracted", "memory", "Fact extracted from conversation"),
            ("memory.update_queued", "memory", "Memory update queued for processing"),
        ]
        for event_type, category, description in events:
            self.conn.execute(
                "INSERT OR IGNORE INTO event_types (event_type, category, description) VALUES (?, ?, ?)",
                (event_type, category, description),
            )

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
        """Get the next pending job (highest priority, oldest first).

        Uses BEGIN IMMEDIATE to prevent TOCTOU race where two workers
        could claim the same job via a non-atomic SELECT then UPDATE.
        """
        now = time.time()
        self.conn.execute("BEGIN IMMEDIATE")
        row = self.conn.execute(
            """SELECT * FROM job_queue WHERE status = 'pending'
            AND (scheduled_at IS NULL OR scheduled_at <= ?)
            ORDER BY priority DESC, created_at ASC LIMIT 1""",
            (now,),
        ).fetchone()
        if not row:
            self.conn.commit()
            return None
        job = dict(row)
        self.conn.execute(
            "UPDATE job_queue SET status = 'running', started_at = ? WHERE job_id = ?",
            (now, job["job_id"]),
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

    _RETENTION_ALLOWED_TABLES = frozenset({
        "sessions", "turns", "errors", "feedback", "cost_ledger",
        "job_queue", "workflow_runs", "traces", "billing",
    })

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
            if table not in self._RETENTION_ALLOWED_TABLES:
                deleted[table] = -1
                continue
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
        eval_passed = record.get("eval_passed")
        session_values = [
            record["session_id"],
            record.get("org_id", ""),
            record.get("project_id", ""),
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
            1 if eval_passed else (0 if eval_passed is not None else None),
            record.get("eval_task_name", ""),
            json.dumps(record.get("eval_conditions", {})) if record.get("eval_conditions") else "{}",
            record.get("trace_id", ""),
            record.get("parent_session_id", ""),
            record.get("depth", 0),
            record.get("timestamp", time.time()),
            record.get("ended_at"),
        ]
        placeholders = ", ".join(["?"] * len(session_values))
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO sessions (
                    session_id, org_id, project_id, agent_id, agent_name, agent_version, model,
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
                    """
                + placeholders
                + """)""",
                tuple(session_values),
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
                        execution_mode, plan_json, reflection_json,
                        started_at, ended_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                        turn.get("execution_mode", "sequential"),
                        json.dumps(turn.get("plan_artifact", {})),
                        json.dumps(turn.get("reflection", {})),
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

    def runtime_insights(self, since: float | None = None, limit_sessions: int = 200) -> dict[str, Any]:
        """Aggregate runtime telemetry from turn artifacts for portal observability."""
        session_sql = "SELECT session_id FROM sessions WHERE 1=1"
        params: list[Any] = []
        if since:
            session_sql += " AND created_at >= ?"
            params.append(since)
        session_sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit_sessions)
        session_rows = self.conn.execute(session_sql, params).fetchall()
        session_ids = [r["session_id"] for r in session_rows]
        if not session_ids:
            return {
                "sessions_scanned": 0,
                "turns_scanned": 0,
                "parallel_turns": 0,
                "sequential_turns": 0,
                "parallel_ratio": 0.0,
                "avg_reflection_confidence": 0.0,
                "next_actions": {},
                "tool_failures_total": 0,
            }

        placeholders = ",".join("?" for _ in session_ids)
        turn_rows = self.conn.execute(
            f"SELECT execution_mode, reflection_json FROM turns WHERE session_id IN ({placeholders})",
            session_ids,
        ).fetchall()

        turns_scanned = len(turn_rows)
        parallel_turns = 0
        sequential_turns = 0
        confidence_sum = 0.0
        confidence_count = 0
        next_actions: dict[str, int] = {}
        tool_failures_total = 0

        for row in turn_rows:
            execution_mode = (row["execution_mode"] or "sequential") if "execution_mode" in row.keys() else "sequential"
            if execution_mode == "parallel":
                parallel_turns += 1
            else:
                sequential_turns += 1

            reflection_raw = row["reflection_json"] if "reflection_json" in row.keys() else "{}"
            try:
                reflection = json.loads(reflection_raw) if isinstance(reflection_raw, str) else {}
            except Exception:
                reflection = {}
            conf = reflection.get("confidence")
            if isinstance(conf, (int, float)):
                confidence_sum += float(conf)
                confidence_count += 1
            next_action = str(reflection.get("next_action", "") or "").strip()
            if next_action:
                next_actions[next_action] = next_actions.get(next_action, 0) + 1
            failures = reflection.get("tool_failures", [])
            if isinstance(failures, list):
                tool_failures_total += len(failures)

        return {
            "sessions_scanned": len(session_ids),
            "turns_scanned": turns_scanned,
            "parallel_turns": parallel_turns,
            "sequential_turns": sequential_turns,
            "parallel_ratio": (parallel_turns / turns_scanned) if turns_scanned else 0.0,
            "avg_reflection_confidence": (confidence_sum / confidence_count) if confidence_count else 0.0,
            "next_actions": next_actions,
            "tool_failures_total": tool_failures_total,
        }

    def get_turns(self, session_id: str) -> list[dict[str, Any]]:
        """Return all turns for a session, ordered by turn number."""
        rows = self.conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY turn_number",
            (session_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def session_runtime_profile(self, session_id: str) -> dict[str, Any]:
        """Return runtime profile for a session from turn-level artifacts."""
        rows = self.conn.execute(
            "SELECT turn_number, execution_mode, plan_json, reflection_json FROM turns WHERE session_id = ? ORDER BY turn_number",
            (session_id,),
        ).fetchall()
        profile_turns: list[dict[str, Any]] = []
        for row in rows:
            plan_raw = row["plan_json"] if "plan_json" in row.keys() else "{}"
            reflection_raw = row["reflection_json"] if "reflection_json" in row.keys() else "{}"
            try:
                plan = json.loads(plan_raw) if isinstance(plan_raw, str) else {}
            except Exception:
                plan = {}
            try:
                reflection = json.loads(reflection_raw) if isinstance(reflection_raw, str) else {}
            except Exception:
                reflection = {}
            profile_turns.append({
                "turn_number": row["turn_number"],
                "execution_mode": row["execution_mode"] if "execution_mode" in row.keys() else "sequential",
                "plan_artifact": plan,
                "reflection": reflection,
            })

        return {
            "session_id": session_id,
            "turn_count": len(profile_turns),
            "turns": profile_turns,
        }

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

    # ── Conversation Intelligence ──────────────────────────────────

    def insert_conversation_score(
        self,
        session_id: str,
        turn_number: int,
        org_id: str = "",
        agent_name: str = "",
        sentiment: str = "neutral",
        sentiment_score: float = 0.0,
        sentiment_confidence: float = 0.0,
        relevance_score: float = 0.0,
        coherence_score: float = 0.0,
        helpfulness_score: float = 0.0,
        safety_score: float = 1.0,
        quality_overall: float = 0.0,
        topic: str = "",
        intent: str = "",
        has_tool_failure: bool = False,
        has_hallucination_risk: bool = False,
        scorer_model: str = "",
    ) -> int:
        """Record a per-turn conversation score."""
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO conversation_scores (
                    session_id, turn_number, org_id, agent_name,
                    sentiment, sentiment_score, sentiment_confidence,
                    relevance_score, coherence_score, helpfulness_score,
                    safety_score, quality_overall,
                    topic, intent, has_tool_failure, has_hallucination_risk,
                    scorer_model
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    session_id, turn_number, org_id, agent_name,
                    sentiment, sentiment_score, sentiment_confidence,
                    relevance_score, coherence_score, helpfulness_score,
                    safety_score, quality_overall,
                    topic, intent, int(has_tool_failure), int(has_hallucination_risk),
                    scorer_model,
                ),
            )
            return cur.lastrowid

    def upsert_conversation_analytics(
        self,
        session_id: str,
        org_id: str = "",
        agent_name: str = "",
        avg_sentiment_score: float = 0.0,
        dominant_sentiment: str = "neutral",
        sentiment_trend: str = "stable",
        avg_quality: float = 0.0,
        min_quality: float = 0.0,
        max_quality: float = 0.0,
        topics: list[str] | None = None,
        intents: list[str] | None = None,
        failure_patterns: list[str] | None = None,
        total_turns: int = 0,
        tool_failure_count: int = 0,
        hallucination_risk_count: int = 0,
        task_completed: int = 0,
    ) -> None:
        """Insert or update session-level analytics."""
        self.conn.execute(
            """INSERT INTO conversation_analytics (
                session_id, org_id, agent_name,
                avg_sentiment_score, dominant_sentiment, sentiment_trend,
                avg_quality, min_quality, max_quality,
                topics_json, intents_json, failure_patterns_json,
                total_turns, tool_failure_count, hallucination_risk_count,
                task_completed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                avg_sentiment_score = excluded.avg_sentiment_score,
                dominant_sentiment = excluded.dominant_sentiment,
                sentiment_trend = excluded.sentiment_trend,
                avg_quality = excluded.avg_quality,
                min_quality = excluded.min_quality,
                max_quality = excluded.max_quality,
                topics_json = excluded.topics_json,
                intents_json = excluded.intents_json,
                failure_patterns_json = excluded.failure_patterns_json,
                total_turns = excluded.total_turns,
                tool_failure_count = excluded.tool_failure_count,
                hallucination_risk_count = excluded.hallucination_risk_count,
                task_completed = excluded.task_completed
            """,
            (
                session_id, org_id, agent_name,
                avg_sentiment_score, dominant_sentiment, sentiment_trend,
                avg_quality, min_quality, max_quality,
                json.dumps(topics or []), json.dumps(intents or []),
                json.dumps(failure_patterns or []),
                total_turns, tool_failure_count, hallucination_risk_count,
                task_completed,
            ),
        )
        self.conn.commit()

    def query_conversation_scores(
        self,
        session_id: str | None = None,
        org_id: str = "",
        agent_name: str = "",
        sentiment: str = "",
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Query per-turn conversation scores."""
        sql = "SELECT * FROM conversation_scores WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if session_id:
            sql += " AND session_id = ?"
            params.append(session_id)
        if agent_name:
            sql += " AND agent_name = ?"
            params.append(agent_name)
        if sentiment:
            sql += " AND sentiment = ?"
            params.append(sentiment)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def query_conversation_analytics(
        self,
        org_id: str = "",
        agent_name: str = "",
        since: float = 0,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Query session-level conversation analytics."""
        sql = "SELECT * FROM conversation_analytics WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if agent_name:
            sql += " AND agent_name = ?"
            params.append(agent_name)
        if since > 0:
            sql += " AND created_at >= ?"
            params.append(since)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            for key in ("topics_json", "intents_json", "failure_patterns_json"):
                d[key] = json.loads(d.get(key, "[]"))
            result.append(d)
        return result

    def conversation_intel_summary(
        self,
        org_id: str = "",
        agent_name: str = "",
        since: float = 0,
    ) -> dict[str, Any]:
        """Aggregate conversation intelligence summary."""
        where_parts = ["1=1"]
        params: list[Any] = []
        if org_id:
            where_parts.append("org_id = ?")
            params.append(org_id)
        if agent_name:
            where_parts.append("agent_name = ?")
            params.append(agent_name)
        if since > 0:
            where_parts.append("created_at >= ?")
            params.append(since)
        where = " AND ".join(where_parts)

        # Aggregate from conversation_scores
        score_row = self.conn.execute(
            f"""SELECT
                COUNT(*) as total_scores,
                AVG(sentiment_score) as avg_sentiment,
                AVG(quality_overall) as avg_quality,
                AVG(relevance_score) as avg_relevance,
                AVG(coherence_score) as avg_coherence,
                AVG(helpfulness_score) as avg_helpfulness,
                AVG(safety_score) as avg_safety,
                SUM(has_tool_failure) as tool_failures,
                SUM(has_hallucination_risk) as hallucination_risks
            FROM conversation_scores WHERE {where}""",
            params,
        ).fetchone()
        sr = dict(score_row) if score_row else {}

        # Sentiment breakdown
        sentiment_rows = self.conn.execute(
            f"SELECT sentiment, COUNT(*) as cnt FROM conversation_scores WHERE {where} GROUP BY sentiment",
            params,
        ).fetchall()
        sentiment_breakdown = {r["sentiment"]: r["cnt"] for r in sentiment_rows}

        # Topic breakdown (from analytics)
        analytics_rows = self.conn.execute(
            f"SELECT topics_json FROM conversation_analytics WHERE {where}",
            params,
        ).fetchall()
        topic_counts: dict[str, int] = {}
        for row in analytics_rows:
            for topic in json.loads(row["topics_json"] or "[]"):
                topic_counts[topic] = topic_counts.get(topic, 0) + 1
        top_topics = sorted(topic_counts.items(), key=lambda x: x[1], reverse=True)[:10]

        # Quality trend (last 7 data points by day)
        quality_trend = self.conn.execute(
            f"""SELECT
                DATE(created_at, 'unixepoch') as day,
                AVG(quality_overall) as avg_q,
                AVG(sentiment_score) as avg_s,
                COUNT(*) as cnt
            FROM conversation_scores WHERE {where}
            GROUP BY day ORDER BY day DESC LIMIT 30""",
            params,
        ).fetchall()

        return {
            "total_scored_turns": sr.get("total_scores", 0) or 0,
            "avg_sentiment_score": round(sr.get("avg_sentiment", 0) or 0, 3),
            "avg_quality_score": round(sr.get("avg_quality", 0) or 0, 3),
            "avg_relevance": round(sr.get("avg_relevance", 0) or 0, 3),
            "avg_coherence": round(sr.get("avg_coherence", 0) or 0, 3),
            "avg_helpfulness": round(sr.get("avg_helpfulness", 0) or 0, 3),
            "avg_safety": round(sr.get("avg_safety", 0) or 0, 3),
            "tool_failure_count": int(sr.get("tool_failures", 0) or 0),
            "hallucination_risk_count": int(sr.get("hallucination_risks", 0) or 0),
            "sentiment_breakdown": sentiment_breakdown,
            "top_topics": [{"topic": t, "count": c} for t, c in top_topics],
            "quality_trend": [dict(r) for r in quality_trend],
        }

    # ── Gold Images & Config Compliance ─────────────────────────

    def insert_gold_image(
        self,
        image_id: str,
        name: str,
        config_json: str,
        config_hash: str,
        org_id: str = "",
        description: str = "",
        version: str = "1.0.0",
        category: str = "general",
        created_by: str = "",
    ) -> None:
        """Create a new gold image."""
        self.conn.execute(
            """INSERT INTO gold_images (image_id, org_id, name, description, config_json,
               config_hash, version, category, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (image_id, org_id, name, description, config_json, config_hash,
             version, category, created_by),
        )
        self.conn.commit()

    def get_gold_image(self, image_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM gold_images WHERE image_id = ?", (image_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["config"] = json.loads(d.get("config_json", "{}"))
        return d

    def list_gold_images(self, org_id: str = "", active_only: bool = True, limit: int = 50) -> list[dict[str, Any]]:
        sql = "SELECT * FROM gold_images WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if active_only:
            sql += " AND is_active = 1"
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["config"] = json.loads(d.get("config_json", "{}"))
            result.append(d)
        return result

    def update_gold_image(self, image_id: str, **kwargs: Any) -> None:
        """Update gold image fields."""
        allowed = {"name", "description", "config_json", "config_hash", "version",
                   "category", "is_active", "approved_by", "approved_at"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return
        updates["updated_at"] = time.time()
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [image_id]
        self.conn.execute(f"UPDATE gold_images SET {set_clause} WHERE image_id = ?", values)
        self.conn.commit()

    def delete_gold_image(self, image_id: str) -> None:
        self.conn.execute("DELETE FROM gold_images WHERE image_id = ?", (image_id,))
        self.conn.commit()

    def insert_compliance_check(
        self,
        org_id: str,
        agent_name: str,
        image_id: str,
        image_name: str,
        status: str,
        drift_count: int,
        drift_fields: list[str],
        drift_details: dict[str, Any],
        checked_by: str = "",
    ) -> int:
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO compliance_checks (org_id, agent_name, image_id, image_name,
                   status, drift_count, drift_fields, drift_details_json, checked_by)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (org_id, agent_name, image_id, image_name, status, drift_count,
                 json.dumps(drift_fields), json.dumps(drift_details), checked_by),
            )
            return cur.lastrowid

    def list_compliance_checks(
        self, org_id: str = "", agent_name: str = "", limit: int = 50,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM compliance_checks WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if agent_name:
            sql += " AND agent_name = ?"
            params.append(agent_name)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["drift_fields"] = json.loads(d.get("drift_fields", "[]"))
            d["drift_details"] = json.loads(d.get("drift_details_json", "{}"))
            result.append(d)
        return result

    def insert_config_audit(
        self, org_id: str = "", agent_name: str = "", action: str = "",
        field_changed: str = "", old_value: str = "", new_value: str = "",
        change_reason: str = "", changed_by: str = "", image_id: str = "",
    ) -> None:
        self.conn.execute(
            """INSERT INTO config_audit_log (org_id, agent_name, action, field_changed,
               old_value, new_value, change_reason, changed_by, image_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (org_id, agent_name, action, field_changed, old_value, new_value,
             change_reason, changed_by, image_id),
        )
        self.conn.commit()

    def list_config_audit(
        self, org_id: str = "", agent_name: str = "", limit: int = 100,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM config_audit_log WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if agent_name:
            sql += " AND agent_name = ?"
            params.append(agent_name)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    # ── Issue Tracking ─────────────────────────────────────────────

    def insert_issue(
        self, issue_id: str, org_id: str = "", agent_name: str = "",
        title: str = "", description: str = "", category: str = "unknown",
        severity: str = "low", source: str = "auto", source_session_id: str = "",
        source_turn: int = 0, suggested_fix: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.conn.execute(
            """INSERT INTO issues (issue_id, org_id, agent_name, title, description,
               category, severity, source, source_session_id, source_turn,
               suggested_fix, metadata_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (issue_id, org_id, agent_name, title, description, category, severity,
             source, source_session_id, source_turn, suggested_fix,
             json.dumps(metadata or {})),
        )
        self.conn.commit()

    def get_issue(self, issue_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM issues WHERE issue_id = ?", (issue_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["metadata"] = json.loads(d.get("metadata_json", "{}"))
        return d

    def list_issues(
        self, org_id: str = "", agent_name: str = "", status: str = "",
        category: str = "", severity: str = "", limit: int = 50,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM issues WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if agent_name:
            sql += " AND agent_name = ?"
            params.append(agent_name)
        if status:
            sql += " AND status = ?"
            params.append(status)
        if category:
            sql += " AND category = ?"
            params.append(category)
        if severity:
            sql += " AND severity = ?"
            params.append(severity)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["metadata"] = json.loads(d.get("metadata_json", "{}"))
            result.append(d)
        return result

    def update_issue(self, issue_id: str, **kwargs: Any) -> None:
        allowed = {"title", "description", "category", "severity", "status",
                   "suggested_fix", "fix_applied", "assigned_to", "resolved_by",
                   "resolved_at"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return
        updates["updated_at"] = time.time()
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [issue_id]
        self.conn.execute(f"UPDATE issues SET {set_clause} WHERE issue_id = ?", values)
        self.conn.commit()

    def issue_summary(self, org_id: str = "", agent_name: str = "") -> dict[str, Any]:
        where_parts = ["1=1"]
        params: list[Any] = []
        if org_id:
            where_parts.append("org_id = ?")
            params.append(org_id)
        if agent_name:
            where_parts.append("agent_name = ?")
            params.append(agent_name)
        where = " AND ".join(where_parts)
        total = self.conn.execute(f"SELECT COUNT(*) as cnt FROM issues WHERE {where}", params).fetchone()
        by_status = self.conn.execute(
            f"SELECT status, COUNT(*) as cnt FROM issues WHERE {where} GROUP BY status", params
        ).fetchall()
        by_category = self.conn.execute(
            f"SELECT category, COUNT(*) as cnt FROM issues WHERE {where} GROUP BY category", params
        ).fetchall()
        by_severity = self.conn.execute(
            f"SELECT severity, COUNT(*) as cnt FROM issues WHERE {where} GROUP BY severity", params
        ).fetchall()
        return {
            "total": total["cnt"] if total else 0,
            "by_status": {r["status"]: r["cnt"] for r in by_status},
            "by_category": {r["category"]: r["cnt"] for r in by_category},
            "by_severity": {r["severity"]: r["cnt"] for r in by_severity},
        }

    # ── Programmatic Trace Query API (Phase 3 — agent consumes its own telemetry) ──

    # ── Security Scans & Risk Profiles ──────────────────────────────

    def insert_security_scan(self, scan_id: str, org_id: str = "", agent_name: str = "",
                             scan_type: str = "full", **kwargs: Any) -> None:
        self.conn.execute(
            """INSERT INTO security_scans (scan_id, org_id, agent_name, scan_type,
               status, total_probes, passed, failed, errors, risk_score, risk_level, started_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (scan_id, org_id, agent_name, scan_type,
             kwargs.get("status", "running"), kwargs.get("total_probes", 0),
             kwargs.get("passed", 0), kwargs.get("failed", 0), kwargs.get("errors", 0),
             kwargs.get("risk_score", 0.0), kwargs.get("risk_level", "unknown"),
             kwargs.get("started_at", time.time())),
        )
        self.conn.commit()

    def complete_security_scan(self, scan_id: str, **kwargs: Any) -> None:
        sets = ", ".join(f"{k} = ?" for k in kwargs)
        if "completed_at" not in kwargs:
            sets += ", completed_at = ?"
            kwargs["completed_at"] = time.time()
        if "status" not in kwargs:
            sets += ", status = ?"
            kwargs["status"] = "completed"
        vals = list(kwargs.values()) + [scan_id]
        self.conn.execute(f"UPDATE security_scans SET {sets} WHERE scan_id = ?", vals)
        self.conn.commit()

    def get_security_scan(self, scan_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM security_scans WHERE scan_id = ?", (scan_id,)).fetchone()
        return dict(row) if row else None

    def list_security_scans(self, org_id: str = "", agent_name: str = "", limit: int = 50) -> list[dict[str, Any]]:
        sql = "SELECT * FROM security_scans WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if agent_name:
            sql += " AND agent_name = ?"
            params.append(agent_name)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def insert_security_finding(self, scan_id: str, **kwargs: Any) -> int:
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO security_findings (scan_id, org_id, agent_name, probe_id,
                   probe_name, category, layer, severity, title, description, evidence,
                   remediation, aivss_vector, aivss_score)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (scan_id, kwargs.get("org_id", ""), kwargs.get("agent_name", ""),
                 kwargs.get("probe_id", ""), kwargs.get("probe_name", ""),
                 kwargs.get("category", ""), kwargs.get("layer", ""),
                 kwargs.get("severity", "info"), kwargs.get("title", ""),
                 kwargs.get("description", ""), kwargs.get("evidence", ""),
                 kwargs.get("remediation", ""), kwargs.get("aivss_vector", ""),
                 kwargs.get("aivss_score", 0.0)),
            )
            return cur.lastrowid

    def list_security_findings(self, scan_id: str = "", agent_name: str = "",
                               severity: str = "", limit: int = 100) -> list[dict[str, Any]]:
        sql = "SELECT * FROM security_findings WHERE 1=1"
        params: list[Any] = []
        if scan_id:
            sql += " AND scan_id = ?"
            params.append(scan_id)
        if agent_name:
            sql += " AND agent_name = ?"
            params.append(agent_name)
        if severity:
            sql += " AND severity = ?"
            params.append(severity)
        sql += " ORDER BY aivss_score DESC, created_at DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def upsert_risk_profile(self, agent_name: str, org_id: str = "", risk_score: float = 0.0,
                            risk_level: str = "unknown", aivss_vector: dict | None = None,
                            last_scan_id: str = "", findings_summary: dict | None = None) -> None:
        self.conn.execute(
            """INSERT INTO agent_risk_profiles (org_id, agent_name, risk_score, risk_level,
               aivss_vector_json, last_scan_id, findings_summary_json, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(agent_name) DO UPDATE SET
                   risk_score = excluded.risk_score,
                   risk_level = excluded.risk_level,
                   aivss_vector_json = excluded.aivss_vector_json,
                   last_scan_id = excluded.last_scan_id,
                   findings_summary_json = excluded.findings_summary_json,
                   updated_at = excluded.updated_at""",
            (org_id, agent_name, risk_score, risk_level,
             json.dumps(aivss_vector or {}), last_scan_id,
             json.dumps(findings_summary or {}), time.time()),
        )
        self.conn.commit()

    def get_risk_profile(self, agent_name: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM agent_risk_profiles WHERE agent_name = ?", (agent_name,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["aivss_vector"] = json.loads(d.get("aivss_vector_json", "{}"))
        d["findings_summary"] = json.loads(d.get("findings_summary_json", "{}"))
        return d

    def list_risk_profiles(self, org_id: str = "", limit: int = 50) -> list[dict[str, Any]]:
        sql = "SELECT * FROM agent_risk_profiles WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        sql += " ORDER BY risk_score DESC LIMIT ?"
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["aivss_vector"] = json.loads(d.get("aivss_vector_json", "{}"))
            d["findings_summary"] = json.loads(d.get("findings_summary_json", "{}"))
            result.append(d)
        return result

    # ── Vapi Voice Integration ───────────────────────────────────────

    def insert_vapi_call(self, call_id: str, **kwargs: Any) -> None:
        self.conn.execute(
            """INSERT INTO vapi_calls (
               call_id, org_id, agent_name, phone_number, direction, status,
               vapi_assistant_id, metadata_json, started_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(call_id) DO UPDATE SET
               org_id = excluded.org_id,
               agent_name = excluded.agent_name,
               phone_number = excluded.phone_number,
               direction = excluded.direction,
               status = excluded.status,
               vapi_assistant_id = excluded.vapi_assistant_id,
               metadata_json = excluded.metadata_json,
               started_at = excluded.started_at
            """,
            (
                call_id,
                kwargs.get("org_id", ""),
                kwargs.get("agent_name", ""),
                kwargs.get("phone_number", ""),
                kwargs.get("direction", "outbound"),
                kwargs.get("status", "pending"),
                kwargs.get("vapi_assistant_id", ""),
                json.dumps(kwargs.get("metadata", {})),
                kwargs.get("started_at", time.time()),
            ),
        )
        self.conn.commit()

    def update_vapi_call(self, call_id: str, **kwargs: Any) -> None:
        allowed = {"status", "duration_seconds", "transcript", "cost_usd", "ended_at", "agent_name"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [call_id]
        self.conn.execute(f"UPDATE vapi_calls SET {set_clause} WHERE call_id = ?", values)
        self.conn.commit()

    def get_vapi_call(self, call_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM vapi_calls WHERE call_id = ?", (call_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["metadata"] = json.loads(d.get("metadata_json", "{}"))
        return d

    def list_vapi_calls(self, org_id: str = "", agent_name: str = "",
                        status: str = "", limit: int = 50) -> list[dict[str, Any]]:
        sql = "SELECT * FROM vapi_calls WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if agent_name:
            sql += " AND agent_name = ?"
            params.append(agent_name)
        if status:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def insert_vapi_event(self, call_id: str, event_type: str,
                          payload_json: str = "{}", org_id: str = "") -> None:
        self.conn.execute(
            "INSERT INTO vapi_events (call_id, org_id, event_type, payload_json) VALUES (?, ?, ?, ?)",
            (call_id, org_id, event_type, payload_json),
        )
        self.conn.commit()

    def list_vapi_events(self, call_id: str, limit: int = 100) -> list[dict[str, Any]]:
        return [dict(r) for r in self.conn.execute(
            "SELECT * FROM vapi_events WHERE call_id = ? ORDER BY created_at DESC LIMIT ?",
            (call_id, limit),
        ).fetchall()]

    def vapi_call_summary(self, org_id: str = "") -> dict[str, Any]:
        where = "org_id = ?" if org_id else "1=1"
        params = [org_id] if org_id else []
        total = self.conn.execute(f"SELECT COUNT(*) as cnt FROM vapi_calls WHERE {where}", params).fetchone()
        by_status = self.conn.execute(
            f"SELECT status, COUNT(*) as cnt FROM vapi_calls WHERE {where} GROUP BY status", params
        ).fetchall()
        cost = self.conn.execute(
            f"SELECT COALESCE(SUM(cost_usd), 0) as total, COALESCE(SUM(duration_seconds), 0) as dur FROM vapi_calls WHERE {where}", params
        ).fetchone()
        return {
            "total_calls": total["cnt"] if total else 0,
            "by_status": {r["status"]: r["cnt"] for r in by_status},
            "total_cost_usd": round(cost["total"], 4) if cost else 0,
            "total_duration_seconds": round(cost["dur"], 1) if cost else 0,
        }

    # ── Generic Voice Platform Methods (ElevenLabs, Retell, Bland, Tavus) ──

    def insert_voice_call(self, call_id: str, platform: str, **kwargs: Any) -> None:
        self.conn.execute(
            """INSERT INTO voice_calls (
               call_id, platform, org_id, agent_name, phone_number, direction,
               status, platform_agent_id, metadata_json, started_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(call_id) DO UPDATE SET
               platform = excluded.platform,
               org_id = excluded.org_id,
               agent_name = excluded.agent_name,
               phone_number = excluded.phone_number,
               direction = excluded.direction,
               status = excluded.status,
               platform_agent_id = excluded.platform_agent_id,
               metadata_json = excluded.metadata_json,
               started_at = excluded.started_at
            """,
            (
                call_id,
                platform,
                kwargs.get("org_id", ""),
                kwargs.get("agent_name", ""),
                kwargs.get("phone_number", ""),
                kwargs.get("direction", "outbound"),
                kwargs.get("status", "pending"),
                kwargs.get("platform_agent_id", ""),
                json.dumps(kwargs.get("metadata", {})),
                kwargs.get("started_at", time.time()),
            ),
        )
        self.conn.commit()

    def update_voice_call(self, call_id: str, **kwargs: Any) -> None:
        allowed = {"status", "duration_seconds", "transcript", "cost_usd", "ended_at", "agent_name"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [call_id]
        self.conn.execute(f"UPDATE voice_calls SET {set_clause} WHERE call_id = ?", values)
        self.conn.commit()

    def get_voice_call(self, call_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM voice_calls WHERE call_id = ?", (call_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["metadata"] = json.loads(d.get("metadata_json", "{}"))
        return d

    def list_voice_calls(self, platform: str = "", org_id: str = "", agent_name: str = "",
                         status: str = "", limit: int = 50) -> list[dict[str, Any]]:
        sql = "SELECT * FROM voice_calls WHERE 1=1"
        params: list[Any] = []
        if platform:
            sql += " AND platform = ?"
            params.append(platform)
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if agent_name:
            sql += " AND agent_name = ?"
            params.append(agent_name)
        if status:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def insert_voice_event(self, call_id: str, platform: str, event_type: str,
                           payload_json: str = "{}", org_id: str = "") -> None:
        self.conn.execute(
            "INSERT INTO voice_events (call_id, platform, org_id, event_type, payload_json) VALUES (?, ?, ?, ?, ?)",
            (call_id, platform, org_id, event_type, payload_json),
        )
        self.conn.commit()

    def list_voice_events(self, call_id: str, limit: int = 100) -> list[dict[str, Any]]:
        return [dict(r) for r in self.conn.execute(
            "SELECT * FROM voice_events WHERE call_id = ? ORDER BY created_at DESC LIMIT ?",
            (call_id, limit),
        ).fetchall()]

    def voice_call_summary(self, platform: str = "", org_id: str = "") -> dict[str, Any]:
        conditions = ["1=1"]
        params: list[Any] = []
        if platform:
            conditions.append("platform = ?")
            params.append(platform)
        if org_id:
            conditions.append("org_id = ?")
            params.append(org_id)
        where = " AND ".join(conditions)
        total = self.conn.execute(f"SELECT COUNT(*) as cnt FROM voice_calls WHERE {where}", params).fetchone()
        by_platform = self.conn.execute(
            f"SELECT platform, COUNT(*) as cnt FROM voice_calls WHERE {where} GROUP BY platform", params
        ).fetchall()
        cost = self.conn.execute(
            f"SELECT COALESCE(SUM(cost_usd), 0) as total, COALESCE(SUM(duration_seconds), 0) as dur FROM voice_calls WHERE {where}", params
        ).fetchone()
        return {
            "total_calls": total["cnt"] if total else 0,
            "by_platform": {r["platform"]: r["cnt"] for r in by_platform},
            "total_cost_usd": round(cost["total"], 4) if cost else 0,
            "total_duration_seconds": round(cost["dur"], 1) if cost else 0,
        }

    # ── Programmatic Trace Query API ─────────────────────────────────

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
        spans = self.query_trace(session.get("trace_id", ""))

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

    def upsert_pricing_rate(
        self,
        *,
        provider: str,
        model: str,
        resource_type: str,
        operation: str,
        unit: str,
        unit_price_usd: float,
        currency: str = "USD",
        source: str = "manual",
        pricing_version: str = "",
        effective_from: float | None = None,
        effective_to: float | None = None,
        is_active: bool = True,
        metadata_json: str = "{}",
    ) -> int:
        """Insert pricing rate row (deactivates overlapping active rows for same key)."""
        now = time.time()
        eff_from = float(effective_from if effective_from is not None else now)
        with self.tx() as cur:
            cur.execute(
                """UPDATE pricing_catalog
                   SET is_active = 0, updated_at = ?
                   WHERE resource_type = ? AND provider = ? AND model = ? AND operation = ? AND unit = ? AND is_active = 1""",
                (now, resource_type, provider, model, operation, unit),
            )
            cur.execute(
                """INSERT INTO pricing_catalog (
                    provider, model, resource_type, operation, unit, unit_price_usd, currency,
                    source, pricing_version, effective_from, effective_to, is_active, metadata_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    provider, model, resource_type, operation, unit, float(unit_price_usd), currency,
                    source, pricing_version, eff_from, effective_to, int(bool(is_active)), metadata_json, now, now,
                ),
            )
            return int(cur.lastrowid or 0)

    def get_active_pricing_rate(
        self,
        *,
        resource_type: str,
        operation: str,
        unit: str,
        provider: str = "",
        model: str = "",
        at_ts: float | None = None,
    ) -> dict[str, Any] | None:
        """Return best active pricing row for key at timestamp.

        Resolution order:
          1) exact provider + exact model
          2) exact provider + wildcard model=''
          3) wildcard provider='' + wildcard model=''
        """
        ts = float(at_ts if at_ts is not None else time.time())
        candidates: list[tuple[str, str]] = [(provider, model), (provider, ""), ("", "")]
        for p, m in candidates:
            row = self.conn.execute(
                """SELECT * FROM pricing_catalog
                   WHERE resource_type = ? AND operation = ? AND unit = ?
                     AND provider = ? AND model = ? AND is_active = 1
                     AND effective_from <= ?
                     AND (effective_to IS NULL OR effective_to >= ?)
                   ORDER BY effective_from DESC, id DESC
                   LIMIT 1""",
                (resource_type, operation, unit, p, m, ts, ts),
            ).fetchone()
            if row:
                return dict(row)
        return None

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
        pricing_source: str = "fallback_env",
        pricing_key: str = "",
        unit: str = "",
        unit_price_usd: float = 0.0,
        quantity: float = 0.0,
        pricing_version: str = "",
    ) -> int:
        """Record a billing entry for customer charging."""
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO billing_records (
                    org_id, customer_id, agent_name, cost_type, description,
                    model, provider, input_tokens, output_tokens, inference_cost_usd,
                    gpu_type, gpu_hours, gpu_cost_usd, total_cost_usd,
                    session_id, trace_id,
                    pricing_source, pricing_key, unit, unit_price_usd, quantity, pricing_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    org_id, customer_id, agent_name, cost_type, description,
                    model, provider, input_tokens, output_tokens, inference_cost_usd,
                    gpu_type, gpu_hours, gpu_cost_usd, total_cost_usd,
                    session_id, trace_id,
                    pricing_source, pricing_key, unit, unit_price_usd, quantity, pricing_version,
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

    # ── Autoresearch ──────────────────────────────────────────────────────

    def insert_autoresearch_run(self, run: dict[str, Any]) -> int:
        """Insert an autoresearch run record. Returns the row ID."""
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO autoresearch_runs (
                    run_id, org_id, agent_name, mode, primary_metric,
                    max_iterations, proposer_model, proposer_provider, backend,
                    status, total_iterations, baseline_score, best_score,
                    improvements_kept, experiments_discarded, experiments_crashed,
                    best_config_json, applied,
                    total_inference_cost_usd, total_gpu_cost_usd, total_cost_usd,
                    elapsed_seconds, started_at, completed_at, source, error_message
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?
                )""",
                (
                    run.get("run_id", ""),
                    run.get("org_id", ""),
                    run.get("agent_name", ""),
                    run.get("mode", "agent"),
                    run.get("primary_metric", "pass_rate"),
                    run.get("max_iterations", 0),
                    run.get("proposer_model", ""),
                    run.get("proposer_provider", ""),
                    run.get("backend", "in-process"),
                    run.get("status", "running"),
                    run.get("total_iterations", 0),
                    run.get("baseline_score", 0.0),
                    run.get("best_score", 0.0),
                    run.get("improvements_kept", 0),
                    run.get("experiments_discarded", 0),
                    run.get("experiments_crashed", 0),
                    json.dumps(run.get("best_config", {})),
                    1 if run.get("applied") else 0,
                    run.get("total_inference_cost_usd", 0.0),
                    run.get("total_gpu_cost_usd", 0.0),
                    run.get("total_cost_usd", 0.0),
                    run.get("elapsed_seconds", 0.0),
                    run.get("started_at", time.time()),
                    run.get("completed_at"),
                    run.get("source", "backend"),
                    run.get("error_message", ""),
                ),
            )
            return cur.lastrowid or 0

    def update_autoresearch_run(self, run_id: str, updates: dict[str, Any]) -> None:
        """Update an autoresearch run (e.g., when completed)."""
        sets = []
        params: list[Any] = []
        for key in [
            "status", "total_iterations", "best_score",
            "improvements_kept", "experiments_discarded", "experiments_crashed",
            "applied", "total_cost_usd", "elapsed_seconds", "completed_at",
            "error_message",
        ]:
            if key in updates:
                col = key
                if key == "applied":
                    sets.append(f"{col} = ?")
                    params.append(1 if updates[key] else 0)
                elif key == "best_config":
                    sets.append("best_config_json = ?")
                    params.append(json.dumps(updates[key]))
                else:
                    sets.append(f"{col} = ?")
                    params.append(updates[key])
        if not sets:
            return
        params.append(run_id)
        with self.tx() as cur:
            cur.execute(
                f"UPDATE autoresearch_runs SET {', '.join(sets)} WHERE run_id = ?",
                params,
            )

    def insert_autoresearch_experiment(self, exp: dict[str, Any]) -> int:
        """Insert a single autoresearch experiment record."""
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO autoresearch_experiments (
                    run_id, org_id, agent_name, iteration,
                    hypothesis, description, modification_json,
                    config_before_json, config_after_json,
                    score_before, score_after, improvement, primary_metric,
                    all_metrics_json, status,
                    val_bpb, peak_vram_mb, training_seconds, num_steps, num_params_m,
                    inference_cost_usd, gpu_cost_usd, total_cost_usd,
                    commit_hash, error_message
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )""",
                (
                    exp.get("run_id", ""),
                    exp.get("org_id", ""),
                    exp.get("agent_name", ""),
                    exp.get("iteration", 0),
                    exp.get("hypothesis", ""),
                    exp.get("description", ""),
                    json.dumps(exp.get("modification", {})),
                    json.dumps(exp.get("config_before", {})),
                    json.dumps(exp.get("config_after", {})),
                    exp.get("score_before", 0.0),
                    exp.get("score_after", 0.0),
                    exp.get("improvement", 0.0),
                    exp.get("primary_metric", "pass_rate"),
                    json.dumps(exp.get("all_metrics", {})),
                    exp.get("status", "discard"),
                    exp.get("val_bpb", 0.0),
                    exp.get("peak_vram_mb", 0.0),
                    exp.get("training_seconds", 0.0),
                    exp.get("num_steps", 0),
                    exp.get("num_params_m", 0.0),
                    exp.get("inference_cost_usd", 0.0),
                    exp.get("gpu_cost_usd", 0.0),
                    exp.get("total_cost_usd", 0.0),
                    exp.get("commit_hash", ""),
                    exp.get("error_message", ""),
                ),
            )
            return cur.lastrowid or 0

    def query_autoresearch_runs(
        self, agent_name: str = "", org_id: str = "", limit: int = 50
    ) -> list[dict[str, Any]]:
        """Query autoresearch runs with optional filters."""
        sql = "SELECT * FROM autoresearch_runs WHERE 1=1"
        params: list[Any] = []
        if agent_name:
            sql += " AND agent_name = ?"
            params.append(agent_name)
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        sql += " ORDER BY started_at DESC LIMIT ?"
        params.append(limit)
        try:
            return [dict(r) for r in self.conn.execute(sql, params).fetchall()]
        except Exception:
            return []

    def query_autoresearch_experiments(
        self, run_id: str = "", agent_name: str = "", limit: int = 100
    ) -> list[dict[str, Any]]:
        """Query autoresearch experiments with optional filters."""
        sql = "SELECT * FROM autoresearch_experiments WHERE 1=1"
        params: list[Any] = []
        if run_id:
            sql += " AND run_id = ?"
            params.append(run_id)
        if agent_name:
            sql += " AND agent_name = ?"
            params.append(agent_name)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        try:
            return [dict(r) for r in self.conn.execute(sql, params).fetchall()]
        except Exception:
            return []

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


    # ── Skills CRUD ──────────────────────────────────────────────────────

    def upsert_skill(self, skill: dict[str, Any]) -> None:
        """Insert or update a skill record."""
        try:
            self.conn.execute(
                """INSERT OR REPLACE INTO skills (
                    name, description, version, license, category,
                    allowed_tools, tags, enabled, source_path, content_hash, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    skill["name"],
                    skill.get("description", ""),
                    skill.get("version", "1.0.0"),
                    skill.get("license", ""),
                    skill.get("category", "public"),
                    json.dumps(skill.get("allowed_tools", [])),
                    json.dumps(skill.get("tags", [])),
                    1 if skill.get("enabled", True) else 0,
                    skill.get("source_path", ""),
                    skill.get("content_hash", ""),
                    time.time(),
                ),
            )
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # skills table may not exist

    def list_skills(self) -> list[dict[str, Any]]:
        try:
            rows = self.conn.execute("SELECT * FROM skills ORDER BY name").fetchall()
            return [dict(r) for r in rows]
        except sqlite3.OperationalError:
            return []

    # ── Memory Facts CRUD ─────────────────────────────────────────────

    def insert_memory_fact(self, fact: dict[str, Any]) -> None:
        """Insert a memory fact (deduplicates by content_hash)."""
        try:
            self.conn.execute(
                """INSERT OR IGNORE INTO memory_facts (id, content, content_hash, category, confidence, source)
                VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    fact["id"],
                    fact["content"],
                    fact.get("content_hash", ""),
                    fact.get("category", "context"),
                    fact.get("confidence", 0.8),
                    fact.get("source", ""),
                ),
            )
            self.conn.commit()
        except sqlite3.OperationalError:
            pass

    def list_memory_facts(self, category: str = "", limit: int = 100) -> list[dict[str, Any]]:
        try:
            if category:
                rows = self.conn.execute(
                    "SELECT * FROM memory_facts WHERE category = ? ORDER BY confidence DESC LIMIT ?",
                    (category, limit),
                ).fetchall()
            else:
                rows = self.conn.execute(
                    "SELECT * FROM memory_facts ORDER BY confidence DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]
        except sqlite3.OperationalError:
            return []

    # ── Middleware Events ──────────────────────────────────────────────

    def insert_middleware_event(
        self, session_id: str, middleware_name: str, action: str,
        details: dict | None = None, turn_number: int = 0,
    ) -> None:
        """Log a middleware event (loop detection, summarization, etc.)."""
        try:
            self.conn.execute(
                """INSERT INTO middleware_events (session_id, middleware_name, action, details_json, turn_number)
                VALUES (?, ?, ?, ?, ?)""",
                (session_id, middleware_name, action, json.dumps(details or {}), turn_number),
            )
            self.conn.commit()
        except sqlite3.OperationalError:
            pass

    def query_middleware_events(
        self, session_id: str = "", middleware_name: str = "", limit: int = 100,
    ) -> list[dict[str, Any]]:
        try:
            sql = "SELECT * FROM middleware_events WHERE 1=1"
            params: list[Any] = []
            if session_id:
                sql += " AND session_id = ?"
                params.append(session_id)
            if middleware_name:
                sql += " AND middleware_name = ?"
                params.append(middleware_name)
            sql += " ORDER BY created_at DESC LIMIT ?"
            params.append(limit)
            return [dict(r) for r in self.conn.execute(sql, params).fetchall()]
        except sqlite3.OperationalError:
            return []


    # ── Agent registry CRUD ────────────────────────────────────────────────

    def upsert_agent(
        self,
        org_id: str,
        project_id: str,
        name: str,
        config_dict: dict[str, Any],
        created_by: str = "",
        agent_id: str = "",
        version: str = "",
    ) -> dict[str, Any]:
        """Insert or update an agent in the registry. Returns the row.

        Race-safe: if two concurrent inserts hit the unique constraint,
        the loser retries as an update.
        """
        import uuid as _uuid

        agent_id = agent_id or config_dict.get("agent_id", "") or _uuid.uuid4().hex
        version = version or config_dict.get("version", "0.1.0")
        description = config_dict.get("description", "")
        config_json = json.dumps(config_dict, default=str)
        now = time.time()

        # Try update first (covers the conflict path for SQLite which
        # doesn't support ON CONFLICT with all index types cleanly).
        existing = self.get_agent(org_id, project_id, name)
        if existing:
            self.conn.execute(
                "UPDATE agents SET config_json = ?, version = ?, description = ?, "
                "updated_at = ?, is_active = 1 WHERE org_id = ? AND project_id = ? AND name = ?",
                (config_json, version, description, now, org_id, project_id, name),
            )
            self.conn.commit()
            return self.get_agent(org_id, project_id, name) or {}

        try:
            self.conn.execute(
                "INSERT INTO agents (agent_id, org_id, project_id, name, description, "
                "version, config_json, is_active, created_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
                (agent_id, org_id, project_id, name, description,
                 version, config_json, created_by, now, now),
            )
            self.conn.commit()
        except Exception as exc:
            # Concurrent insert hit the unique constraint — retry as update
            msg = str(exc).lower()
            if "unique" in msg or "duplicate" in msg or "constraint" in msg:
                try:
                    self.conn.rollback()
                except Exception:
                    pass
                self.conn.execute(
                    "UPDATE agents SET config_json = ?, version = ?, description = ?, "
                    "updated_at = ?, is_active = 1 WHERE org_id = ? AND project_id = ? AND name = ?",
                    (config_json, version, description, now, org_id, project_id, name),
                )
                self.conn.commit()
            else:
                raise
        return self.get_agent(org_id, project_id, name) or {}

    def get_agent(self, org_id: str, project_id: str, name: str) -> dict[str, Any] | None:
        """Get an agent by (org_id, project_id, name). Returns None if not found."""
        try:
            row = self.conn.execute(
                "SELECT * FROM agents WHERE org_id = ? AND project_id = ? AND name = ? AND is_active = 1",
                (org_id, project_id, name),
            ).fetchone()
            return dict(row) if row else None
        except Exception:
            return None

    def get_agent_by_name(self, name: str) -> dict[str, Any] | None:
        """Fallback lookup by name only (for CLI/single-tenant compat).

        Returns the first active agent matching the name, regardless of org/project.
        """
        try:
            row = self.conn.execute(
                "SELECT * FROM agents WHERE name = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1",
                (name,),
            ).fetchone()
            return dict(row) if row else None
        except Exception:
            return None

    def list_agents_for_org(
        self, org_id: str, project_id: str | None = None, limit: int = 200,
    ) -> list[dict[str, Any]]:
        """List active agents for an org, optionally filtered by project."""
        try:
            if project_id is not None:
                rows = self.conn.execute(
                    "SELECT * FROM agents WHERE org_id = ? AND project_id = ? AND is_active = 1 "
                    "ORDER BY updated_at DESC LIMIT ?",
                    (org_id, project_id, limit),
                ).fetchall()
            else:
                rows = self.conn.execute(
                    "SELECT * FROM agents WHERE org_id = ? AND is_active = 1 "
                    "ORDER BY updated_at DESC LIMIT ?",
                    (org_id, limit),
                ).fetchall()
            return [dict(r) for r in rows]
        except Exception:
            return []

    def delete_agent(self, org_id: str, project_id: str, name: str) -> bool:
        """Soft-delete an agent (set is_active = 0). Returns True if a row was updated."""
        try:
            cur = self.conn.execute(
                "UPDATE agents SET is_active = 0, updated_at = ? "
                "WHERE org_id = ? AND project_id = ? AND name = ? AND is_active = 1",
                (time.time(), org_id, project_id, name),
            )
            self.conn.commit()
            return (cur.rowcount or 0) > 0
        except Exception:
            return False


def create_database(path: str | Path) -> AgentDB:
    """Create and initialize a new agent database. Idempotent."""
    db = AgentDB(path)
    db.initialize()
    return db
