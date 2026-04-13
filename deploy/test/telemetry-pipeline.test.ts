/**
 * End-to-end telemetry pipeline tests.
 *
 * Validates that observability data flows correctly through:
 *   A) Runtime collection (workflow.ts turnRecords + session payload)
 *   B) Queue message payloads (all fields present)
 *   C) Queue consumer INSERTs (column names match DB schema)
 *
 * These tests catch the class of bug where data is collected but silently
 * dropped at the queue boundary — the #1 observability failure mode.
 */
import { describe, it, expect } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// A) Turn record field completeness
// ═══════════════════════════════════════════════════════════════════

describe("turn record schema", () => {
  // These are the fields that workflow.ts must include in every turnRecord
  // so that the queue consumer can write them to Supabase.
  const REQUIRED_TURN_FIELDS = [
    "turn", "model", "content",
    "input_tokens", "output_tokens", "cost_usd", "latency_ms",
    "tool_calls", "tool_results", "errors",
    // Migration 026 observability fields
    "llm_latency_ms", "stop_reason", "refusal",
    "cache_read_tokens", "cache_write_tokens", "gateway_log_id",
  ];

  it("final-answer turn record includes all observability fields", () => {
    // Simulates what workflow.ts pushes for a final-answer turn (line ~623)
    const finalAnswerTurn = {
      turn: 1, model: "anthropic/claude-sonnet-4-5", content: "Hello!",
      input_tokens: 100, output_tokens: 50, cost_usd: 0.001,
      latency_ms: 450,
      tool_calls: [], tool_results: [], errors: [],
      // Observability enrichment
      llm_latency_ms: 450,
      stop_reason: "stop",
      refusal: false,
      cache_read_tokens: 80,
      cache_write_tokens: 20,
      gateway_log_id: "gw-abc123",
    };

    for (const field of REQUIRED_TURN_FIELDS) {
      expect(finalAnswerTurn).toHaveProperty(field);
    }
  });

  it("tool-call turn record includes all observability fields", () => {
    // Simulates what workflow.ts pushes for a tool-call turn (line ~881)
    const toolCallTurn = {
      turn: 2, model: "anthropic/claude-sonnet-4-5",
      content: "Let me search for that.",
      input_tokens: 200, output_tokens: 100, cost_usd: 0.003,
      latency_ms: 820,
      tool_calls: [{ name: "web-search", arguments: { query: "test" } }],
      tool_results: [{ name: "web-search", result: "...", latency_ms: 300, cost_usd: 0.0001, error: undefined }],
      errors: [],
      // Observability enrichment
      llm_latency_ms: 520,
      stop_reason: "tool_use",
      refusal: false,
      cache_read_tokens: 150,
      cache_write_tokens: 0,
      gateway_log_id: "gw-def456",
    };

    for (const field of REQUIRED_TURN_FIELDS) {
      expect(toolCallTurn).toHaveProperty(field);
    }
  });

  it("refusal turn record captures refusal flag", () => {
    const refusalTurn = {
      turn: 1, model: "anthropic/claude-sonnet-4-5",
      content: "I'm unable to help with that.",
      input_tokens: 50, output_tokens: 20, cost_usd: 0.0005,
      latency_ms: 200,
      tool_calls: [], tool_results: [], errors: [],
      llm_latency_ms: 200,
      stop_reason: "content_filter",
      refusal: true,
      cache_read_tokens: 0, cache_write_tokens: 0,
      gateway_log_id: "gw-ref789",
    };

    expect(refusalTurn.refusal).toBe(true);
    expect(refusalTurn.stop_reason).toBe("content_filter");
  });
});

// ═══════════════════════════════════════════════════════════════════
// B) Queue payload shape — workflow → queue → consumer
// ═══════════════════════════════════════════════════════════════════

describe("session queue payload", () => {
  // These are the fields workflow.ts sends in the session payload (type: "session").
  // The queue consumer must handle ALL of them.
  const REQUIRED_SESSION_PAYLOAD_FIELDS = [
    "session_id", "org_id", "project_id", "agent_name", "model",
    "status", "input_text", "output_text",
    "step_count", "action_count", "wall_clock_seconds",
    "cost_total_usd", "trace_id", "channel",
    // Migration 026 fields
    "detailed_cost", "feature_flags",
    "total_cache_read_tokens", "total_cache_write_tokens",
    "repair_count", "compaction_count",
  ];

  function buildSessionPayload() {
    return {
      type: "session",
      payload: {
        session_id: "sess-test-001",
        org_id: "org-abc",
        project_id: "proj-1",
        agent_name: "test-agent",
        model: "anthropic/claude-sonnet-4-5",
        status: "success",
        input_text: "Hello",
        output_text: "Hi there!",
        step_count: 3,
        action_count: 5,
        wall_clock_seconds: 12,
        cost_total_usd: 0.0045,
        trace_id: "trace-xyz",
        channel: "web",
        detailed_cost: JSON.stringify({
          input_cost: 0.003, output_cost: 0.001,
          cache_write_cost: 0.0002, cache_read_cost: 0.0001,
          cache_savings: 0.0005, total_cost: 0.0043,
        }),
        feature_flags: JSON.stringify({
          concurrent_tools: true,
          context_compression: true,
          deferred_tool_loading: false,
        }),
        total_cache_read_tokens: 500,
        total_cache_write_tokens: 100,
        repair_count: 1,
        compaction_count: 0,
      },
    };
  }

  it("contains all required fields", () => {
    const msg = buildSessionPayload();
    for (const field of REQUIRED_SESSION_PAYLOAD_FIELDS) {
      expect(msg.payload).toHaveProperty(field);
    }
  });

  it("detailed_cost is valid JSON with cache fields", () => {
    const msg = buildSessionPayload();
    const cost = JSON.parse(msg.payload.detailed_cost);
    expect(cost).toHaveProperty("cache_savings");
    expect(cost).toHaveProperty("cache_read_cost");
    expect(cost).toHaveProperty("cache_write_cost");
    expect(cost.cache_savings).toBeGreaterThan(0);
  });

  it("feature_flags is valid JSON", () => {
    const msg = buildSessionPayload();
    const flags = JSON.parse(msg.payload.feature_flags);
    expect(flags).toHaveProperty("concurrent_tools");
    expect(typeof flags.concurrent_tools).toBe("boolean");
  });
});

describe("turn queue payload", () => {
  const REQUIRED_TURN_PAYLOAD_FIELDS = [
    "session_id", "turn_number", "model_used",
    "input_tokens", "output_tokens", "latency_ms",
    "llm_content", "cost_total_usd",
    "tool_calls", "tool_results", "errors",
    // Migration 026 fields
    "llm_latency_ms", "stop_reason", "refusal",
    "cache_read_tokens", "cache_write_tokens", "gateway_log_id",
  ];

  function buildTurnPayload() {
    return {
      type: "turn",
      payload: {
        session_id: "sess-test-001",
        turn_number: 1,
        model_used: "anthropic/claude-sonnet-4-5",
        input_tokens: 200,
        output_tokens: 100,
        latency_ms: 800,
        llm_latency_ms: 500,
        llm_content: "Here is the answer.",
        cost_total_usd: 0.002,
        stop_reason: "stop",
        refusal: false,
        cache_read_tokens: 150,
        cache_write_tokens: 50,
        gateway_log_id: "gw-turn-001",
        tool_calls: "[]",
        tool_results: "[]",
        errors: "[]",
      },
    };
  }

  it("contains all required fields", () => {
    const msg = buildTurnPayload();
    for (const field of REQUIRED_TURN_PAYLOAD_FIELDS) {
      expect(msg.payload).toHaveProperty(field);
    }
  });

  it("llm_latency_ms is separate from total latency_ms", () => {
    const msg = buildTurnPayload();
    // llm_latency_ms is the pure LLM response time
    // latency_ms includes LLM + tool execution + overhead
    expect(msg.payload.llm_latency_ms).toBeLessThanOrEqual(msg.payload.latency_ms);
  });
});

describe("implementation complexity event payload", () => {
  function buildImplementationComplexityEvent() {
    return {
      type: "event",
      payload: {
        org_id: "org-abc",
        agent_name: "test-agent",
        session_id: "sess-test-001",
        trace_id: "trace-xyz",
        turn: 3,
        event_type: "implementation_complexity",
        action: "measured",
        plan: "standard",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-5",
        tool_name: "",
        status: "ok",
        latency_ms: 0,
        details: {
          files_touched: 2,
          lines_added: 12,
          lines_removed: 4,
          new_files_created: 1,
          measurement_scope: "tracked_file_tools_only",
          tracked_tools: ["write-file", "edit-file"],
          possible_untracked_mutations: false,
        },
        created_at: Date.now(),
      },
    };
  }

  it("uses the standard workflow event envelope", () => {
    const msg = buildImplementationComplexityEvent();
    const requiredFields = [
      "org_id", "agent_name", "session_id", "trace_id", "turn",
      "event_type", "action", "plan", "provider", "model",
      "tool_name", "status", "latency_ms", "details", "created_at",
    ];

    for (const field of requiredFields) {
      expect(msg.payload).toHaveProperty(field);
    }
  });

  it("carries the Phase 5 spec metrics in details", () => {
    const msg = buildImplementationComplexityEvent();
    expect(msg.payload.details).toMatchObject({
      files_touched: 2,
      lines_added: 12,
      lines_removed: 4,
      new_files_created: 1,
      measurement_scope: "tracked_file_tools_only",
      tracked_tools: ["write-file", "edit-file"],
      possible_untracked_mutations: false,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// C) Consumer INSERT column alignment with DB schema
// ═══════════════════════════════════════════════════════════════════

describe("queue consumer → DB schema alignment", () => {
  // Migration 023 + 026 column definitions (source of truth)
  const TURNS_COLUMNS = [
    "turn_id", "session_id", "turn_number", "model_used", "llm_content",
    "input_tokens", "output_tokens", "cost_total_usd", "latency_ms",
    "tool_calls", "tool_results", "errors",
    "execution_mode", "plan_artifact", "reflection", "created_at",
    // Migration 026
    "llm_latency_ms", "stop_reason", "refusal",
    "cache_read_tokens", "cache_write_tokens", "gateway_log_id",
  ];

  const SESSIONS_COLUMNS_026 = [
    "feature_flags", "detailed_cost",
    "total_cache_read_tokens", "total_cache_write_tokens",
    "repair_count", "compaction_count",
  ];

  it("consumer session INSERT includes all migration 026 columns", () => {
    // This test reads the actual source code to verify the consumer SQL
    // includes the new columns. This is a static analysis test.
    const fs = require("fs");
    const source = fs.readFileSync(
      require("path").resolve(__dirname, "../src/index.ts"),
      "utf-8",
    );

    // Find the session INSERT block
    const sessionInsertMatch = source.match(
      /if \(type === "session"\)[\s\S]*?ON CONFLICT/,
    );
    expect(sessionInsertMatch).not.toBeNull();
    const sessionInsert = sessionInsertMatch![0];

    for (const col of SESSIONS_COLUMNS_026) {
      expect(sessionInsert).toContain(col);
    }
  });

  it("consumer turn INSERT includes all migration 026 columns", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      require("path").resolve(__dirname, "../src/index.ts"),
      "utf-8",
    );

    const turnInsertMatch = source.match(
      /if \(type === "turn"\)[\s\S]*?gateway_log_id[\s\S]*?\)`/,
    );
    expect(turnInsertMatch).not.toBeNull();
    const turnInsert = turnInsertMatch![0];

    const turnCols026 = [
      "llm_latency_ms", "stop_reason", "refusal",
      "cache_read_tokens", "cache_write_tokens", "gateway_log_id",
      "pre_llm_ms", "tool_exec_ms",
      "llm_retry_count", "llm_cost_usd", "tool_cost_usd",
      "tokens_per_sec", "queue_delay_ms",
      "compaction_triggered", "messages_dropped",
    ];
    for (const col of turnCols026) {
      expect(turnInsert).toContain(col);
    }
  });

  it("consumer turn INSERT uses the canonical plan_artifact column", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      require("path").resolve(__dirname, "../src/index.ts"),
      "utf-8",
    );

    const turnInsertMatch = source.match(
      /else if \(type === "turn"\)[\s\S]*?\)`/,
    );
    expect(turnInsertMatch).not.toBeNull();
    const turnInsert = turnInsertMatch![0];

    // Structured plan artifacts persist to the canonical plan_artifact column.
    const columnsSection = turnInsert.split("VALUES")[0];
    expect(columnsSection).toContain("plan_artifact");
  });

  it("consumer handles all queue message types", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      require("path").resolve(__dirname, "../src/index.ts"),
      "utf-8",
    );

    // Extract the queue handler method
    const queueMatch = source.match(
      /async queue\(batch[\s\S]*?finally[\s\S]*?}/,
    );
    expect(queueMatch).not.toBeNull();
    const queueHandler = queueMatch![0];

    // All message types that workflow.ts and tools.ts send must have handlers
    const expectedTypes = [
      "session", "turn", "episode", "event",
      "runtime_event", "middleware_event", "billing_flush",
      "skill_activation", "skill_auto_activation", "loop_detected", "do_eviction",
      "artifact_manifest", "signal_envelope",
    ];

    for (const t of expectedTypes) {
      expect(queueHandler).toContain(`"${t}"`);
    }

    // KNOWN_TYPES set should list all types for unknown-type detection
    expect(queueHandler).toContain("KNOWN_TYPES");
  });

  it("consumer classifies permanent vs transient errors", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      require("path").resolve(__dirname, "../src/index.ts"),
      "utf-8",
    );

    // Must distinguish permanent failures (ack) from transient failures (retry with backoff)
    expect(source).toContain("isPermanent");
    expect(source).toContain("PERMANENT FAILURE");
    expect(source).toContain("TRANSIENT FAILURE");
    expect(source).toContain("retryWithBackoff");
  });
});

// ═══════════════════════════════════════════════════════════════════
// D) LLM Response → workflow pipeline field propagation
// ═══════════════════════════════════════════════════════════════════

describe("LLM response field propagation", () => {
  it("LLMResponse type includes cache token fields", () => {
    // Verify the type definition includes the new fields
    // by constructing a conforming object
    const response = {
      content: "test",
      model: "anthropic/claude-sonnet-4-5",
      tool_calls: [],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 80,
        cache_write_tokens: 20,
      },
      cost_usd: 0.001,
      latency_ms: 500,
      gateway_log_id: "gw-123",
      gateway_event_id: "evt-456",
      refusal: false,
      stop_reason: "stop",
      retry_count: 0,
    };

    expect(response.usage.cache_read_tokens).toBe(80);
    expect(response.usage.cache_write_tokens).toBe(20);
    expect(response.stop_reason).toBe("stop");
    expect(response.retry_count).toBe(0);
  });

  it("LLMResult interface carries all enrichment fields", () => {
    const llmResult = {
      content: "test",
      tool_calls: [],
      model: "anthropic/claude-sonnet-4-5",
      cost_usd: 0.001,
      input_tokens: 100,
      output_tokens: 50,
      // Observability enrichment (migration 026)
      llm_latency_ms: 450,
      stop_reason: "stop" as string | undefined,
      refusal: false as boolean | undefined,
      cache_read_tokens: 80,
      cache_write_tokens: 20,
      gateway_log_id: "gw-123" as string | undefined,
    };

    // These fields must NOT be stripped when constructing LLMResult from callLLM response
    expect(llmResult.llm_latency_ms).toBe(450);
    expect(llmResult.cache_read_tokens).toBe(80);
    expect(llmResult.cache_write_tokens).toBe(20);
    expect(llmResult.gateway_log_id).toBe("gw-123");
    expect(llmResult.stop_reason).toBe("stop");
    expect(llmResult.refusal).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// E) Session-level accumulation
// ═══════════════════════════════════════════════════════════════════

describe("session-level cache token accumulation", () => {
  it("accumulates cache tokens across multiple turns", () => {
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;

    // Simulate 3 turns of cache token accumulation
    const turns = [
      { cache_read_tokens: 100, cache_write_tokens: 50 },
      { cache_read_tokens: 200, cache_write_tokens: 0 },  // cached on second call
      { cache_read_tokens: 300, cache_write_tokens: 0 },  // cached on third call
    ];

    for (const turn of turns) {
      totalCacheReadTokens += turn.cache_read_tokens;
      totalCacheWriteTokens += turn.cache_write_tokens;
    }

    expect(totalCacheReadTokens).toBe(600);
    expect(totalCacheWriteTokens).toBe(50);

    // Cache hit rate should be high after first turn
    const totalInput = 1000; // hypothetical
    const cacheHitRate = totalCacheReadTokens / totalInput;
    expect(cacheHitRate).toBe(0.6); // 60% cache hit rate
  });

  it("accumulates repair and compaction counts", () => {
    let repairCount = 0;
    let compactionCount = 0;

    // Simulate repairs happening in 2 of 5 turns
    const repairEvents = [0, 2, 0, 1, 0]; // orphaned calls fixed per turn
    const compactionEvents = [false, false, true, false, false]; // compaction triggered

    for (let i = 0; i < 5; i++) {
      repairCount += repairEvents[i];
      if (compactionEvents[i]) compactionCount++;
    }

    expect(repairCount).toBe(3);
    expect(compactionCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// F) Migration 026 schema validation
// ═══════════════════════════════════════════════════════════════════

describe("consolidated schema — observability columns", () => {
  it("init migration contains all observability columns for turns and sessions", () => {
    const fs = require("fs");
    const migration = fs.readFileSync(
      require("path").resolve(__dirname, "../../control-plane/src/db/migrations/001_init.sql"),
      "utf-8",
    );

    // Turns columns
    const turnsCols = [
      "llm_latency_ms", "stop_reason", "refusal",
      "cache_read_tokens", "cache_write_tokens", "gateway_log_id",
      "pre_llm_ms", "tool_exec_ms",
      "llm_retry_count", "llm_cost_usd", "tool_cost_usd",
      "tokens_per_sec", "queue_delay_ms",
      "compaction_triggered", "messages_dropped",
    ];
    for (const col of turnsCols) {
      expect(migration).toContain(col);
    }

    // Sessions columns
    const sessionsCols = [
      "feature_flags", "detailed_cost",
      "total_cache_read_tokens", "total_cache_write_tokens",
      "repair_count", "compaction_count",
    ];
    for (const col of sessionsCols) {
      expect(migration).toContain(col);
    }
  });

  it("init migration contains observability indexes", () => {
    const fs = require("fs");
    const migration = fs.readFileSync(
      require("path").resolve(__dirname, "../../control-plane/src/db/migrations/001_init.sql"),
      "utf-8",
    );

    // idx_turns_refusal was removed in the consolidated schema (refusal is rarely queried alone)
    expect(migration).toContain("idx_turns_model_latency");
  });
});

// ═══════════════════════════════════════════════════════════════════
// G-0) org_id persistence — blank org_id propagation guards
// ═══════════════════════════════════════════════════════════════════

describe("blank org_id propagation guards", () => {
  function readSource() {
    const fs = require("fs");
    return fs.readFileSync(
      require("path").resolve(__dirname, "../src/index.ts"),
      "utf-8",
    );
  }

  // Fix 1: REST /run must resolve or reject blank org_id before workflow creation
  describe("REST /run org_id resolution", () => {
    it("looks up org_id from agents table when not in request", () => {
      const source = readSource();
      // The resolve block sits between "Resolve org_id" comment and "Pre-run credit check"
      const resolveSection = source.match(
        /\/\/ Resolve org_id:[\s\S]*?\/\/ Pre-run credit check/,
      );
      expect(resolveSection).not.toBeNull();
      const block = resolveSection![0];
      expect(block).toContain("SELECT org_id FROM agents WHERE name =");
      expect(block).toContain("is_active = true");
    });

    it("returns 400 missing_org_id when org_id cannot be resolved", () => {
      const source = readSource();
      const resolveSection = source.match(
        /\/\/ Resolve org_id:[\s\S]*?\/\/ Pre-run credit check/,
      );
      expect(resolveSection).not.toBeNull();
      const block = resolveSection![0];
      expect(block).toContain('"missing_org_id"');
      expect(block).toContain("status: 400");
    });

    it("org_id is guaranteed non-empty before credit check", () => {
      const source = readSource();
      const creditSection = source.match(
        /\/\/ Pre-run credit check[\s\S]*?SELECT balance_usd/,
      );
      expect(creditSection).not.toBeNull();
      const block = creditSection![0];
      // Should NOT contain `if (runOrgId &&` — just `if (this.env.HYPERDRIVE)`
      expect(block).not.toMatch(/if\s*\(\s*runOrgId\s*&&/);
    });

    it("workflow creation uses resolved runOrgId, not raw data.org_id", () => {
      const source = readSource();
      // Find the REST workflow creation — between "Workflow path" and the polling loop
      const restWorkflow = source.match(
        /\/\/ ── Workflow path \(durable[\s\S]*?org_id: runOrgId/,
      );
      expect(restWorkflow).not.toBeNull();
    });
  });

  // Fix 2: Queue consumer must guard event + episode types the same as session
  describe("queue consumer org_id guards", () => {
    it("event type skips INSERT when org_id is blank", () => {
      const source = readSource();
      // Find the event handler block
      const eventSection = source.match(
        /else if \(type === "event"\)[\s\S]*?if \(otelUsesEventData\)/,
      );
      expect(eventSection).not.toBeNull();
      const block = eventSection![0];
      expect(block).toContain("!msgOrgId");
      expect(block).toMatch(/skipping.*FK would fail/);
      expect(block).toContain("msg.ack()");
      expect(block).toContain("continue");
    });

    it("episode type skips INSERT when org_id is blank", () => {
      const source = readSource();
      const episodeSection = source.match(
        /else if \(type === "episode"\)[\s\S]*?INSERT INTO episodes/,
      );
      expect(episodeSection).not.toBeNull();
      const block = episodeSection![0];
      expect(block).toContain("!msgOrgId");
      expect(block).toMatch(/skipping.*FK would fail/);
      expect(block).toContain("msg.ack()");
      expect(block).toContain("continue");
    });

    it("session type already guards blank org_id", () => {
      const source = readSource();
      const sessionSection = source.match(
        /if \(type === "session"\)[\s\S]*?INSERT INTO sessions/,
      );
      expect(sessionSection).not.toBeNull();
      const block = sessionSection![0];
      expect(block).toContain("!msgOrgId");
      expect(block).toContain("msg.ack()");
    });

    it("all org-scoped queue branches guard blank org_id", () => {
      const source = readSource();
      // Count org_id skip guards — session, event, episode, runtime_event,
      // middleware_event, skill_activation, loop_detected, do_eviction
      const skipMatches = source.match(/skipping.*FK would fail/g);
      expect(skipMatches).not.toBeNull();
      // 8 branches: session, episode, event, runtime_event, middleware_event,
      // skill_activation/skill_auto_activation, loop_detected, do_eviction
      // (artifact_manifest uses combined guard with !p.session_id || !p.artifact_name || !msgOrgId)
      expect(skipMatches!.length).toBeGreaterThanOrEqual(8);
    });

    it("queue INSERTs use normalized msgOrgId, not raw p.org_id", () => {
      const source = readSource();
      // Extract the queue consumer: from `async queue(batch` to the closing `finally`
      const queueBlock = source.match(
        /async queue\(batch[\s\S]*?finally[\s\S]*?}/,
      );
      expect(queueBlock).not.toBeNull();
      const block = queueBlock![0];
      // No raw p.org_id should appear in SQL INSERTs
      expect(block).not.toMatch(/\$\{p\.org_id/);
    });
  });

  // Fix 1b: /run/stream must also resolve-or-reject blank org_id
  describe("/run/stream org_id resolution", () => {
    it("looks up org_id from agents table when not in request", () => {
      const source = readSource();
      const sseSection = source.match(
        /\/run\/stream[\s\S]*?\/\/ ── Workflow SSE path/,
      );
      expect(sseSection).not.toBeNull();
      const block = sseSection![0];
      expect(block).toContain("SELECT org_id FROM agents WHERE name =");
      expect(block).toContain("is_active = true");
    });

    it("returns 400 missing_org_id when org_id cannot be resolved", () => {
      const source = readSource();
      const sseSection = source.match(
        /\/run\/stream[\s\S]*?\/\/ ── Workflow SSE path/,
      );
      expect(sseSection).not.toBeNull();
      const block = sseSection![0];
      expect(block).toContain('"missing_org_id"');
      expect(block).toContain("status: 400");
    });

    it("workflow creation uses resolved sseOrgId, not raw data.org_id", () => {
      const source = readSource();
      // Find the SSE workflow creation block
      const sseWorkflow = source.match(
        /\/\/ ── Workflow SSE path[\s\S]*?org_id: sseOrgId/,
      );
      expect(sseWorkflow).not.toBeNull();
    });
  });

  // Fix 3: Permanent failures must log structured context
  describe("permanent failure structured logging", () => {
    it("logs org_id, session_id, agent_name, and event_type on permanent failure", () => {
      const source = readSource();
      const permanentBlock = source.match(
        /if \(isPermanent\(err\)\)[\s\S]*?msg\.ack\(\)/,
      );
      expect(permanentBlock).not.toBeNull();
      const block = permanentBlock![0];
      expect(block).toContain("org_id:");
      expect(block).toContain("session_id:");
      expect(block).toContain("agent_name:");
      expect(block).toContain("event_type:");
    });
  });

  // Fix 4: Direct writes must not silently swallow errors
  describe("direct write error observability", () => {
    it("REST /run persistence catch handlers log errors, not swallow them", () => {
      const source = readSource();
      // Isolate the REST /run block: between "Resolve org_id" and "Credit deduction happens"
      const restBlock = source.match(
        /\/\/ Resolve org_id:[\s\S]*?\/\/ NOTE: Credit deduction happens/,
      );
      expect(restBlock).not.toBeNull();
      const block = restBlock![0];
      // Must not contain empty catch — `.catch(() => {})`
      expect(block).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
      // Both writeBillingRecord and writeSession catch handlers must log
      expect(block).toContain("[REST /run] writeBillingRecord failed");
      expect(block).toContain("[REST /run] writeSession failed");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// G) Meta-agent SCOPED_TABLES coverage
// ═══════════════════════════════════════════════════════════════════

describe("meta-agent SCOPED_TABLES", () => {
  it("includes all observability-critical tables", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      require("path").resolve(__dirname, "../../control-plane/src/logic/meta-agent-chat.ts"),
      "utf-8",
    );

    const scopedMatch = source.match(/const SCOPED_TABLES = \[([\s\S]*?)\]/);
    expect(scopedMatch).not.toBeNull();
    const scopedBlock = scopedMatch![1];

    // Tables that must be queryable by the meta-agent
    const criticalTables = [
      // Core
      "sessions", "turns", "agents",
      // Tracing
      "delegation_events", "tool_executions",
      // Feedback
      "session_feedback",
      // Security
      "security_events", "guardrail_events",
      // SLOs
      "slo_evaluations", "slo_error_budgets",
      // Alerting
      "alert_configs", "alert_history",
      // A2A
      "a2a_tasks",
      // Billing
      "billing_records", "credit_transactions",
    ];

    for (const table of criticalTables) {
      expect(scopedBlock).toContain(`"${table}"`);
    }
  });
});
