/**
 * Schema integration test — runs actual INSERT statements against a local
 * Postgres database to catch type mismatches, constraint violations, FK
 * errors, and JSONB casting issues that static analysis cannot detect.
 *
 * Requires: local Postgres with `agentos_test` database and schema applied.
 * Connection: postgresql://gamestart:testpass@localhost:5432/agentos_test
 *
 * Skip: set SKIP_DB_TESTS=1 to skip in CI without local PG.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const DB_URL = process.env.TEST_DATABASE_URL
  || "postgresql://gamestart:testpass@localhost:5432/agentos_test";

// Dynamic import — postgres may not be installed in all environments
let sql: any;
let connected = false;

beforeAll(async () => {
  if (process.env.SKIP_DB_TESTS === "1") return;
  try {
    const pg = (await import("postgres")).default;
    sql = pg(DB_URL, { max: 1, idle_timeout: 5, connect_timeout: 3 });
    await sql`SELECT 1`;
    connected = true;
  } catch (err) {
    console.warn(`[schema-integration] Skipping — cannot connect to ${DB_URL}: ${err}`);
  }
});

afterAll(async () => {
  if (sql) {
    // Clean up test data
    try {
      await sql`DELETE FROM billing_records WHERE description LIKE '%schema-test%'`;
      await sql`DELETE FROM credit_transactions WHERE description LIKE '%schema-test%'`;
      await sql`DELETE FROM otel_events WHERE agent_name = 'schema-test-agent'`;
      await sql`DELETE FROM runtime_events WHERE agent_name = 'schema-test-agent'`;
      await sql`DELETE FROM turns WHERE session_id LIKE 'schema-test-%'`;
      await sql`DELETE FROM sessions WHERE session_id LIKE 'schema-test-%'`;
      await sql`DELETE FROM agents WHERE name = 'schema-test-agent'`;
      await sql`DELETE FROM org_credit_balance WHERE org_id = 'org_schema_test'`;
      await sql`DELETE FROM org_members WHERE org_id = 'org_schema_test'`;
      await sql`DELETE FROM org_settings WHERE org_id = 'org_schema_test'`;
      await sql`DELETE FROM orgs WHERE org_id = 'org_schema_test'`;
      await sql`DELETE FROM users WHERE user_id = 'usr_schema_test'`;
    } catch {}
    await sql.end();
  }
});

describe.skipIf(process.env.SKIP_DB_TESTS === "1")("Schema integration — real Postgres INSERT validation", () => {
  const testSessionId = `schema-test-${Date.now()}`;
  const testTraceId = `trace-test-${Date.now()}`;

  /** Guard — skip individual test if DB not connected (e.g., docker not running) */
  function requireDb() {
    if (!connected) {
      console.warn("[schema-integration] Skipping — no DB connection");
      return false;
    }
    return true;
  }

  // ── Seed data ───────────────────────────────────────────────────

  it("seeds test user + org", async () => { if (!requireDb()) return;
    await sql`INSERT INTO users (user_id, email, name, provider, email_verified)
      VALUES ('usr_schema_test', 'schema-test@test.co', 'Test', 'email', true)
      ON CONFLICT (user_id) DO NOTHING`;
    await sql`INSERT INTO orgs (org_id, name, slug, owner_user_id, plan)
      VALUES ('org_schema_test', 'Schema Test Org', 'schema-test', 'usr_schema_test', 'free')
      ON CONFLICT (org_id) DO NOTHING`;
    await sql`INSERT INTO org_members (org_id, user_id, role)
      VALUES ('org_schema_test', 'usr_schema_test', 'owner')
      ON CONFLICT (org_id, user_id) DO NOTHING`;
    await sql`INSERT INTO org_settings (org_id, plan_type)
      VALUES ('org_schema_test', 'free')
      ON CONFLICT (org_id) DO NOTHING`;
    await sql`INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd)
      VALUES ('org_schema_test', 10.00, 10.00)
      ON CONFLICT (org_id) DO NOTHING`;
    await sql`INSERT INTO agents (agent_id, org_id, name, description, config, agent_role)
      VALUES ('agt_schema_test', 'org_schema_test', 'schema-test-agent', 'test', '{}'::jsonb, 'custom')
      ON CONFLICT (agent_id) DO NOTHING`;

    const [row] = await sql`SELECT org_id FROM orgs WHERE org_id = 'org_schema_test'`;
    expect(row.org_id).toBe("org_schema_test");
  });

  // ── Core pipeline INSERTs ───────────────────────────────────────

  it("INSERT INTO sessions — all columns valid", async () => { if (!requireDb()) return;
    await sql`INSERT INTO sessions (
      session_id, org_id, agent_name, model, status, trace_id,
      cost_total_usd, step_count, input_text, output_text, created_at
    ) VALUES (
      ${testSessionId}, 'org_schema_test', 'schema-test-agent', 'test-model',
      'success', ${testTraceId}, 0.001, 1, 'test input', 'test output', NOW()
    )`;
    const [row] = await sql`SELECT session_id FROM sessions WHERE session_id = ${testSessionId}`;
    expect(row.session_id).toBe(testSessionId);
  });

  it("INSERT INTO turns — all columns valid", async () => { if (!requireDb()) return;
    await sql`INSERT INTO turns (
      session_id, turn_number, model_used, input_tokens, output_tokens,
      cost_usd, latency_ms, stop_reason, created_at
    ) VALUES (
      ${testSessionId}, 1, 'test-model', 100, 50,
      0.001, 500, 'stop', NOW()
    )`;
    const [row] = await sql`SELECT turn_number FROM turns WHERE session_id = ${testSessionId}`;
    expect(row.turn_number).toBe(1);
  });

  it("INSERT INTO billing_records — all columns valid", async () => { if (!requireDb()) return;
    await sql`INSERT INTO billing_records (
      org_id, agent_name, cost_type, description, model, provider,
      input_tokens, output_tokens, inference_cost_usd, total_cost_usd,
      session_id, trace_id, pricing_source, pricing_key,
      unit, quantity, unit_price_usd
    ) VALUES (
      'org_schema_test', 'schema-test-agent', 'inference', 'schema-test billing',
      'test-model', 'test-provider', 100, 50, 0.001, 0.001,
      ${testSessionId}, ${testTraceId}, 'test', 'test:free',
      'session', 1, 0.001
    )`;
    const [row] = await sql`SELECT total_cost_usd FROM billing_records WHERE session_id = ${testSessionId}`;
    expect(Number(row.total_cost_usd)).toBeCloseTo(0.001);
  });

  it("INSERT INTO credit_holds — reserve lifecycle", async () => { if (!requireDb()) return;
    const holdId = `hold-test-${Date.now()}`;
    await sql`INSERT INTO credit_holds (
      hold_id, org_id, session_id, agent_name, hold_amount_usd, status, expires_at
    ) VALUES (
      ${holdId}, 'org_schema_test', ${testSessionId}, 'schema-test-agent',
      0.50, 'active', NOW() + INTERVAL '10 minutes'
    )`;
    // Settle
    await sql`UPDATE credit_holds SET status = 'settled', actual_cost_usd = 0.001, settled_at = NOW()
      WHERE hold_id = ${holdId}`;
    const [row] = await sql`SELECT status, actual_cost_usd FROM credit_holds WHERE hold_id = ${holdId}`;
    expect(row.status).toBe("settled");
  });

  it("INSERT INTO credit_transactions — burn record", async () => { if (!requireDb()) return;
    await sql`INSERT INTO credit_transactions (
      org_id, type, amount_usd, balance_after_usd, description, agent_name, session_id
    ) VALUES (
      'org_schema_test', 'burn', -0.001, 9.999, 'schema-test billing',
      'schema-test-agent', ${testSessionId}
    )`;
    const [row] = await sql`SELECT type FROM credit_transactions
      WHERE org_id = 'org_schema_test' AND description LIKE '%schema-test%'`;
    expect(row.type).toBe("burn");
  });

  it("INSERT INTO otel_events — JSONB event_data", async () => { if (!requireDb()) return;
    await sql`INSERT INTO otel_events (
      org_id, agent_name, session_id, trace_id, event_type, event_data, created_at
    ) VALUES (
      'org_schema_test', 'schema-test-agent', ${testSessionId}, ${testTraceId},
      'turn_phase', ${JSON.stringify({ action: "timing", llm_ms: 500, plan: "free" })}::jsonb, NOW()
    )`;
    const [row] = await sql`SELECT event_type FROM otel_events
      WHERE agent_name = 'schema-test-agent' LIMIT 1`;
    expect(row.event_type).toBe("turn_phase");
  });

  it("INSERT INTO runtime_events — JSONB event_data", async () => { if (!requireDb()) return;
    await sql`INSERT INTO runtime_events (
      org_id, agent_name, event_type, event_data, created_at
    ) VALUES (
      'org_schema_test', 'schema-test-agent', 'memory_agent_variant_assigned',
      ${JSON.stringify({ variant: "baseline", session_id: testSessionId })}::jsonb, NOW()
    )`;
    const [row] = await sql`SELECT event_type FROM runtime_events
      WHERE agent_name = 'schema-test-agent' LIMIT 1`;
    expect(row.event_type).toBe("memory_agent_variant_assigned");
  });

  it("INSERT INTO security_events — typed columns", async () => { if (!requireDb()) return;
    await sql`INSERT INTO security_events (
      org_id, event_type, actor_type, actor_id, severity, details, ip_address, created_at
    ) VALUES (
      'org_schema_test', 'login.success', 'user', 'usr_schema_test',
      'info', ${JSON.stringify({ test: true })}::jsonb, '127.0.0.1', NOW()
    )`;
    const [row] = await sql`SELECT event_type FROM security_events
      WHERE org_id = 'org_schema_test' LIMIT 1`;
    expect(row.event_type).toBe("login.success");
  });

  it("INSERT INTO audit_log — typed columns", async () => { if (!requireDb()) return;
    await sql`INSERT INTO audit_log (
      org_id, actor_id, action, resource_type, resource_name, details, created_at
    ) VALUES (
      'org_schema_test', 'usr_schema_test', 'auth.login', 'auth', 'usr_schema_test',
      ${JSON.stringify({ test: true })}::jsonb, NOW()
    )`;
    const [row] = await sql`SELECT action FROM audit_log
      WHERE org_id = 'org_schema_test' LIMIT 1`;
    expect(row.action).toBe("auth.login");
  });

  it("INSERT INTO middleware_events — typed columns", async () => { if (!requireDb()) return;
    await sql`INSERT INTO middleware_events (
      org_id, agent_name, middleware_name, event_type, payload, created_at
    ) VALUES (
      'org_schema_test', 'schema-test-agent', 'pre_llm', 'codemode_exec',
      ${JSON.stringify({ test: true })}::jsonb, NOW()
    )`;
    const [row] = await sql`SELECT middleware_name FROM middleware_events
      WHERE org_id = 'org_schema_test' LIMIT 1`;
    expect(row.middleware_name).toBe("pre_llm");
  });

  it("INSERT INTO session_feedback — TEXT PK", async () => { if (!requireDb()) return;
    const feedbackId = `fb-${Date.now()}`;
    await sql`INSERT INTO session_feedback (
      id, session_id, org_id, agent_name, rating, comment, created_at
    ) VALUES (
      ${feedbackId}, ${testSessionId}, 'org_schema_test', 'schema-test-agent',
      5, 'great', NOW()
    )`;
    const [row] = await sql`SELECT rating FROM session_feedback WHERE id = ${feedbackId}`;
    expect(row.rating).toBe(5);
  });

  it("INSERT INTO voice_call_events — new table", async () => { if (!requireDb()) return;
    await sql`INSERT INTO voice_call_events (
      call_id, event_type, payload, org_id, platform, created_at
    ) VALUES (
      'call-test-123', 'call.started', '{}'::jsonb, 'org_schema_test', 'vapi', NOW()
    )`;
    const [row] = await sql`SELECT platform FROM voice_call_events WHERE call_id = 'call-test-123'`;
    expect(row.platform).toBe("vapi");
  });

  it("INSERT INTO project_canvas_layouts — new table", async () => { if (!requireDb()) return;
    // Need a project first
    await sql`INSERT INTO projects (project_id, org_id, name, slug)
      VALUES ('proj_schema_test', 'org_schema_test', 'Test Project', 'test-project')
      ON CONFLICT (project_id) DO NOTHING`;
    await sql`INSERT INTO project_canvas_layouts (
      project_id, org_id, layout_json, assignments_json, updated_by
    ) VALUES (
      'proj_schema_test', 'org_schema_test', '{}'::jsonb, '{}'::jsonb, 'usr_schema_test'
    ) ON CONFLICT (project_id) DO NOTHING`;
    const [row] = await sql`SELECT project_id FROM project_canvas_layouts WHERE project_id = 'proj_schema_test'`;
    expect(row.project_id).toBe("proj_schema_test");
  });
});
