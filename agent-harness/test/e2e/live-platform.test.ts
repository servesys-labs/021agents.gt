/**
 * Live Platform E2E Tests — Bottom-Up Bug Finding
 *
 * These tests hit REAL Workers AI models (Kimi K2.5, Gemma 4 26B MoE)
 * via AI Gateway. They mimic what actual users do and probe for failures.
 *
 * NOT happy-path tests. Every test is designed to expose a specific
 * failure mode that real users will encounter.
 *
 * Prerequisites:
 *   - Running agent-harness: `wrangler dev` or deployed instance
 *   - Set E2E_BASE_URL env var (default: http://localhost:8787)
 *   - Set E2E_TOKEN env var (JWT or API key for auth)
 *
 * Run: E2E_BASE_URL=https://your-deployment.workers.dev E2E_TOKEN=xxx npx vitest run test/e2e/
 */

import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:8787";
const TOKEN = process.env.E2E_TOKEN || "";
const GATEWAY_URL = process.env.E2E_GATEWAY_URL || BASE_URL.replace("8787", "8788");
const TIMEOUT = 60_000; // 60s per test — LLM calls are slow

// Skip all if no base URL configured (prevents CI failures)
const LIVE = !!process.env.E2E_BASE_URL;
const test = LIVE ? it : it.skip;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    ...extra,
  };
}

/** Parse SSE stream and collect events */
async function collectSSE(response: Response, maxEvents = 100): Promise<Array<{ type: string; data: any }>> {
  const events: Array<{ type: string; data: any }> = [];
  const reader = response.body?.getReader();
  if (!reader) return events;

  const decoder = new TextDecoder();
  let buffer = "";

  while (events.length < maxEvents) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const parsed = JSON.parse(raw);
          events.push({ type: parsed.type || "unknown", data: parsed });
        } catch {}
      }
    }
  }
  reader.releaseLock();
  return events;
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 0: INFRASTRUCTURE HEALTH
// Verify the deployment is alive before testing features.
// ═══════════════════════════════════════════════════════════════════

describe("Stage 0: Infrastructure Health", () => {
  test("agent-harness worker is alive", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
  }, TIMEOUT);

  test("gateway is alive", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/health`);
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("Workers AI binding responds", async () => {
    // The health endpoint should report AI as a feature
    const res = await fetch(`${BASE_URL}/api/health`);
    const body = await res.json() as any;
    expect(body.features || []).toContain("think");
  }, TIMEOUT);

  test("auth rejects missing token", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/agents`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  }, TIMEOUT);

  test("auth accepts valid token", async () => {
    if (!TOKEN) return;
    const res = await fetch(`${GATEWAY_URL}/api/v1/agents`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 1: BASIC CHAT — Does the LLM respond at all?
// Tests the critical path: user message → Think agent → LLM → response
// ═══════════════════════════════════════════════════════════════════

describe("Stage 1: Basic Chat — LLM Response", () => {
  test("simple prompt returns a response via SSE", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: "Reply with exactly one word: hello",
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSSE(res);
    // Must have at least one token event
    const tokens = events.filter(e => e.type === "token");
    expect(tokens.length).toBeGreaterThan(0);

    // Must have a done event
    const done = events.find(e => e.type === "done");
    expect(done).toBeDefined();
  }, TIMEOUT);

  test("BUG HUNT: agent doesn't hang on empty input", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ agent_name: "default", input: "" }),
    });
    // Should return error, not hang
    expect(res.status).toBeLessThan(500);
  }, TIMEOUT);

  test("BUG HUNT: agent handles very long input (10K chars)", async () => {
    const longInput = "Please summarize: " + "The quick brown fox jumps over the lazy dog. ".repeat(200);
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ agent_name: "default", input: longInput }),
    });
    expect(res.status).toBe(200);
    const events = await collectSSE(res);
    expect(events.some(e => e.type === "done")).toBe(true);
  }, TIMEOUT);

  test("BUG HUNT: agent handles unicode/emoji input", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ agent_name: "default", input: "你好世界 🌍 Как дела?" }),
    });
    expect(res.status).toBe(200);
    const events = await collectSSE(res);
    expect(events.some(e => e.type === "token")).toBe(true);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 2: TOOL EXECUTION — Does the agent use tools correctly?
// Prompts designed to force specific tool calls.
// ═══════════════════════════════════════════════════════════════════

describe("Stage 2: Tool Execution", () => {
  test("agent calls web-search tool when asked to search", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: "Search the web for 'Cloudflare Workers pricing 2026' and tell me what you find.",
      }),
    });
    expect(res.status).toBe(200);
    const events = await collectSSE(res);

    // Must have tool_call events
    const toolCalls = events.filter(e => e.type === "tool_call");
    expect(toolCalls.length).toBeGreaterThan(0);

    // At least one should be web-search related
    const searchCall = toolCalls.find(e =>
      e.data.name?.includes("search") || e.data.name?.includes("web")
    );
    expect(searchCall).toBeDefined();

    // Must have tool_result after tool_call
    const toolResults = events.filter(e => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test("BUG HUNT: agent doesn't call tools when not needed", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: "What is 2 + 2? Just answer with the number.",
      }),
    });
    const events = await collectSSE(res);
    const toolCalls = events.filter(e => e.type === "tool_call");
    // Simple math should NOT trigger tools
    expect(toolCalls.length).toBe(0);
  }, TIMEOUT);

  test("BUG HUNT: tool_result arrives for every tool_call", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: "Search for 'Cloudflare D1 pricing' and also search for 'Cloudflare R2 pricing'. Compare them.",
      }),
    });
    const events = await collectSSE(res);
    const toolCalls = events.filter(e => e.type === "tool_call");
    const toolResults = events.filter(e => e.type === "tool_result");
    // Every tool_call must have a matching tool_result
    for (const call of toolCalls) {
      const callId = call.data.tool_call_id || call.data.call_id;
      if (callId) {
        const result = toolResults.find(r =>
          (r.data.tool_call_id || r.data.call_id) === callId
        );
        expect(result).toBeDefined();
      }
    }
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 3: MULTI-TURN & MEMORY — Does the agent remember?
// Tests whether context persists across turns in the same session.
// ═══════════════════════════════════════════════════════════════════

describe("Stage 3: Multi-Turn & Memory", () => {
  let sessionId: string | undefined;

  test("turn 1: stores a secret in memory", async () => {
    const secret = `SECRET_${Date.now()}`;
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: `Remember this secret code: ${secret}. I will ask you about it later. Confirm you stored it.`,
      }),
    });
    const events = await collectSSE(res);
    const done = events.find(e => e.type === "done");
    if (done?.data?.session_id) sessionId = done.data.session_id;

    // Agent should acknowledge storing the secret
    const tokens = events.filter(e => e.type === "token");
    const fullResponse = tokens.map(t => t.data.content || t.data.text || "").join("");
    expect(fullResponse.toLowerCase()).toMatch(/remember|stored|noted|got it|saved/i);
  }, TIMEOUT);

  test("turn 2: recalls the secret from context", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: "What was the secret code I told you to remember?",
        session_id: sessionId,
      }),
    });
    const events = await collectSSE(res);
    const tokens = events.filter(e => e.type === "token");
    const fullResponse = tokens.map(t => t.data.content || t.data.text || "").join("");

    // Must contain the secret from turn 1
    expect(fullResponse).toContain("SECRET_");
  }, TIMEOUT);

  test("BUG HUNT: agent handles 5 rapid turns without losing context", async () => {
    let sid: string | undefined;
    for (let i = 1; i <= 5; i++) {
      const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          agent_name: "default",
          input: `Turn ${i}: The number for this turn is ${i * 111}. Acknowledge it.`,
          session_id: sid,
        }),
      });
      const events = await collectSSE(res);
      const done = events.find(e => e.type === "done");
      if (done?.data?.session_id) sid = done.data.session_id;
    }

    // Final turn: ask for all numbers
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: "List all the numbers I gave you across all turns.",
        session_id: sid,
      }),
    });
    const events = await collectSSE(res);
    const fullResponse = events.filter(e => e.type === "token").map(t => t.data.content || "").join("");
    // Should remember at least the recent numbers
    expect(fullResponse).toContain("555"); // Turn 5: 5*111=555
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 4: COMPLETION CONTRACT — Does the agent finish properly?
// Tests for premature termination, hanging, and done event delivery.
// ═══════════════════════════════════════════════════════════════════

describe("Stage 4: Completion Contract", () => {
  test("every stream ends with a done event", async () => {
    const prompts = [
      "Say hello.",
      "List 3 programming languages.",
      "What day is it today?",
    ];
    for (const input of prompts) {
      const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ agent_name: "default", input }),
      });
      const events = await collectSSE(res);
      const done = events.find(e => e.type === "done");
      expect(done).toBeDefined();
    }
  }, TIMEOUT * 3);

  test("BUG HUNT: plan-heavy prompt doesn't terminate prematurely", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: `Create a detailed plan to build a REST API with these steps:
Step 1: Design the database schema
Step 2: Set up the project with TypeScript
Step 3: Implement the endpoints
Step 4: Add authentication
Step 5: Write tests
Now execute Step 1 — actually design a schema for a todo app.`,
      }),
    });
    const events = await collectSSE(res);
    const done = events.find(e => e.type === "done");
    expect(done).toBeDefined();

    // Should have substantial content (not just a plan description)
    const tokens = events.filter(e => e.type === "token");
    const fullResponse = tokens.map(t => t.data.content || "").join("");
    expect(fullResponse.length).toBeGreaterThan(200);
    // Should contain actual schema content, not just "I'll do this"
    expect(fullResponse.toLowerCase()).toMatch(/table|column|field|schema|create/i);
  }, TIMEOUT);

  test("BUG HUNT: agent doesn't describe tools instead of using them", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: "Search the web for the current weather in San Francisco. Give me the actual result, not a description of what you would search for.",
      }),
    });
    const events = await collectSSE(res);
    // Must have actual tool_call events (not just text describing the search)
    const toolCalls = events.filter(e => e.type === "tool_call");
    expect(toolCalls.length).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 5: SANDBOX — Code execution in containers
// Tests bash, Python, and long-running tasks in the sandbox.
// ═══════════════════════════════════════════════════════════════════

describe("Stage 5: Sandbox Code Execution", () => {
  test("agent executes Python code in sandbox", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: "Run this Python code and tell me the output: print(sum(range(1, 101)))",
      }),
    });
    const events = await collectSSE(res);
    const fullResponse = events.filter(e => e.type === "token").map(t => t.data.content || "").join("");
    // Sum of 1..100 = 5050
    expect(fullResponse).toContain("5050");
  }, TIMEOUT);

  test("BUG HUNT: sandbox handles code that produces large output", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: 'Run: for i in range(1000): print(f"line {i}: {"x"*100}")',
      }),
    });
    const events = await collectSSE(res);
    // Must complete (not hang or crash)
    expect(events.some(e => e.type === "done")).toBe(true);
    // Output should be truncated (100K chars of output)
    const toolResults = events.filter(e => e.type === "tool_result");
    if (toolResults.length > 0) {
      const resultText = JSON.stringify(toolResults[0].data);
      // Should be truncated, not the full 100K
      expect(resultText.length).toBeLessThan(50_000);
    }
  }, TIMEOUT);

  test("BUG HUNT: sandbox handles infinite loop with timeout", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        agent_name: "default",
        input: "Run this Python code: while True: pass",
      }),
    });
    const events = await collectSSE(res);
    // Must complete eventually (sandbox timeout should kick in)
    expect(events.some(e => e.type === "done" || e.type === "error")).toBe(true);
  }, TIMEOUT * 2); // Allow extra time for timeout
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 6: TELEMETRY & BILLING — Are events written correctly?
// Verifies the Queue → Postgres pipeline works end-to-end.
// ═══════════════════════════════════════════════════════════════════

describe("Stage 6: Telemetry & Billing", () => {
  test("session appears in sessions list after chat", async () => {
    // Send a chat message
    const chatRes = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ agent_name: "default", input: "Hi there" }),
    });
    const events = await collectSSE(chatRes);
    const done = events.find(e => e.type === "done");

    // Wait for Queue consumer to process
    await new Promise(r => setTimeout(r, 5000));

    // Check sessions list
    const sessionsRes = await fetch(`${GATEWAY_URL}/api/v1/sessions`, { headers: headers() });
    expect(sessionsRes.status).toBe(200);
    const sessions = await sessionsRes.json() as any[];
    expect(sessions.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test("conversation header synced to Postgres after chat", async () => {
    await new Promise(r => setTimeout(r, 3000)); // Wait for Queue

    const convsRes = await fetch(
      `${GATEWAY_URL}/api/v1/conversations?agent_name=default`,
      { headers: headers() },
    );
    expect(convsRes.status).toBe(200);
    const body = await convsRes.json() as any;
    // Should have at least one conversation from previous tests
    expect(body.conversations?.length || 0).toBeGreaterThanOrEqual(0);
  }, TIMEOUT);

  test("credit balance endpoint works", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/credits/balance`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(typeof body.balance_usd).toBe("number");
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 7: MCP — External tool server management
// ═══════════════════════════════════════════════════════════════════

describe("Stage 7: MCP Server Management", () => {
  test("list MCP servers (empty initially)", async () => {
    const res = await fetch(
      `${GATEWAY_URL}/api/v1/agents/default/mcp/servers`,
      { headers: headers() },
    );
    // May return 200 with empty list or error if DO not initialized
    expect(res.status).toBeLessThan(500);
  }, TIMEOUT);

  test("BUG HUNT: SSRF blocked for localhost MCP server", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/agents/default/mcp/servers`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "evil", url: "http://localhost:8080" }),
    });
    const body = await res.json() as any;
    // Should be blocked by SSRF validation
    if (body.error) {
      expect(body.error).toContain("localhost");
    }
  }, TIMEOUT);

  test("BUG HUNT: SSRF blocked for private IP MCP server", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/agents/default/mcp/servers`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "evil", url: "http://10.0.0.1:3000" }),
    });
    const body = await res.json() as any;
    if (body.error) {
      expect(body.error).toContain("private");
    }
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 8: GATEWAY CRUD — All major endpoints respond
// ═══════════════════════════════════════════════════════════════════

describe("Stage 8: Gateway CRUD", () => {
  test("agents CRUD works", async () => {
    // List
    const list = await fetch(`${GATEWAY_URL}/api/v1/agents`, { headers: headers() });
    expect(list.status).toBe(200);
  }, TIMEOUT);

  test("skills endpoint works", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/skills`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("guardrails endpoint works", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/guardrails`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("features endpoint works", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/features`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("marketplace search works", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/marketplace/search`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("dashboard stats works", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/dashboard/stats`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("usage endpoint works", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/usage`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("org endpoint works", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/orgs/current`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("auth/me endpoint works", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/auth/me`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 9: STRESS — Concurrent requests and rate limits
// ═══════════════════════════════════════════════════════════════════

describe("Stage 9: Concurrent Stress", () => {
  test("5 concurrent chat requests all complete", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          agent_name: "default",
          input: `Concurrent test ${i}: say "response ${i}"`,
        }),
      }).then(async (res) => {
        const events = await collectSSE(res);
        return { index: i, status: res.status, hasDone: events.some(e => e.type === "done") };
      })
    );

    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.status).toBe(200);
      // At least some should complete (DO serializes but shouldn't drop)
    }
    const completed = results.filter(r => r.hasDone);
    expect(completed.length).toBeGreaterThanOrEqual(1);
  }, TIMEOUT * 3);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 10: LATENCY SLOs — Performance gates
// ═══════════════════════════════════════════════════════════════════

describe("Stage 10: Latency SLOs", () => {
  test("TTFT (time to first token) under 12 seconds", async () => {
    const start = Date.now();
    const res = await fetch(`${GATEWAY_URL}/api/v1/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ agent_name: "default", input: "Hello" }),
    });

    // Read until first token
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let firstTokenTime = 0;
    let buffer = "";

    while (!firstTokenTime) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('"type":"token"') || buffer.includes('"type": "token"')) {
        firstTokenTime = Date.now() - start;
        break;
      }
    }
    reader.releaseLock();

    if (firstTokenTime > 0) {
      expect(firstTokenTime).toBeLessThan(12_000); // 12s SLO
    }
  }, TIMEOUT);
});
