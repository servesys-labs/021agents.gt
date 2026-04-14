/**
 * Live Platform E2E Tests — SDK-First
 *
 * Uses AgentClient from agents/client for chat (WebSocket RPC).
 * Uses REST for gateway control-plane (auth, billing, CRUD).
 *
 * Hits REAL Workers AI models via deployed Cloudflare Workers.
 *
 * Run:
 *   E2E_BASE_URL=https://agent-harness.servesys.workers.dev \
 *   E2E_GATEWAY_URL=https://agent-harness-gateway.servesys.workers.dev \
 *   E2E_TOKEN=jwt \
 *   npx vitest run test/e2e/
 */

import { describe, it, expect } from "vitest";
import { AgentClient } from "agents/client";

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:8787";
const GATEWAY_URL = process.env.E2E_GATEWAY_URL || BASE_URL.replace("8787", "8788");
const TOKEN = process.env.E2E_TOKEN || "";
const TIMEOUT = 90_000;

const LIVE = !!process.env.E2E_BASE_URL;
const test = LIVE ? it : it.skip;

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  };
}

// Build DO name from JWT claims
function buildDoName(): string {
  if (!TOKEN) return "test-default";
  try {
    const payload = JSON.parse(atob(TOKEN.split(".")[1]));
    const orgId = payload.org_id || "";
    const userId = payload.user_id || "";
    const shortOrg = orgId.length > 12 ? orgId.slice(-8) : orgId;
    const shortUser = userId.length > 12 ? userId.slice(-8) : userId;
    const orgPrefix = shortOrg ? `${shortOrg}-` : "";
    let name = shortUser
      ? `${orgPrefix}default-u-${shortUser}`
      : `${orgPrefix}default`;
    if (name.length > 63) name = name.slice(0, 63);
    return name;
  } catch { return "test-default"; }
}

// Get WebSocket host from BASE_URL
function getWsHost(): string {
  return BASE_URL.replace("https://", "").replace("http://", "");
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 0: INFRASTRUCTURE HEALTH
// ═══════════════════════════════════════════════════════════════════

describe("Stage 0: Infrastructure Health", () => {
  test("agent worker is alive", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.features).toContain("think");
  }, TIMEOUT);

  test("gateway is alive", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/health`);
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("gateway → Postgres is connected", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/health/detailed`);
    const body = await res.json() as any;
    expect(body.checks?.database?.ok).toBe(true);
  }, TIMEOUT);

  test("gateway → agent worker service binding works", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/health/detailed`);
    const body = await res.json() as any;
    expect(body.checks?.agent_core?.ok).toBe(true);
  }, TIMEOUT);

  test("auth rejects missing token", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/agents`);
    expect(res.status).toBe(401);
  }, TIMEOUT);

  test("auth accepts valid JWT", async () => {
    if (!TOKEN) return;
    const res = await fetch(`${GATEWAY_URL}/api/v1/agents`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 1: GATEWAY CRUD — Control-plane endpoints via REST
// ═══════════════════════════════════════════════════════════════════

describe("Stage 1: Gateway CRUD", () => {
  test("agents list", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/agents`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("skills list", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/skills`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("guardrails list", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/guardrails`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("sessions list", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/sessions`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("org current", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/orgs/current`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.org_id).toBeDefined();
  }, TIMEOUT);

  test("auth/me", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/auth/me`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.email).toBeDefined();
  }, TIMEOUT);

  test("credits balance", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/credits/balance`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(typeof body.balance_usd).toBe("number");
  }, TIMEOUT);

  test("usage", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/usage`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  test("marketplace search", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/marketplace/search`, { headers: headers() });
    expect(res.status).toBe(200);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 2: AGENT CLIENT — SDK AgentClient WebSocket connection
// ═══════════════════════════════════════════════════════════════════

describe("Stage 2: AgentClient Connection", () => {
  test("AgentClient connects to agent worker DO", async () => {
    const doName = buildDoName();
    const host = getWsHost();

    const client = new AgentClient({
      agent: "chat-agent",
      name: doName,
      host,
      query: TOKEN ? { token: TOKEN } : undefined,
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 10_000);
      const origOpen = client.onopen;
      client.onopen = (event: Event) => {
        clearTimeout(timeout);
        origOpen?.call(client, event);
        resolve();
      };
      const origError = client.onerror;
      client.onerror = (event: Event) => {
        clearTimeout(timeout);
        origError?.call(client, event);
        reject(new Error("WebSocket error"));
      };
    });

    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  }, TIMEOUT);

  test("AgentClient can call @callable methods via RPC", async () => {
    const doName = buildDoName();
    const host = getWsHost();

    const client = new AgentClient({
      agent: "chat-agent",
      name: doName,
      host,
      query: TOKEN ? { token: TOKEN } : undefined,
    });

    await client.ready;

    // Call getTenants — a simple @callable method
    try {
      const tenants = await client.call("getTenants") as any[];
      expect(Array.isArray(tenants)).toBe(true);
      expect(tenants.length).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  }, TIMEOUT);

  test("AgentClient can list MCP servers", async () => {
    const doName = buildDoName();
    const host = getWsHost();

    const client = new AgentClient({
      agent: "chat-agent",
      name: doName,
      host,
      query: TOKEN ? { token: TOKEN } : undefined,
    });

    await client.ready;

    try {
      const result = await client.call("listServers") as any;
      expect(result).toBeDefined();
      expect(typeof result.live_tool_count).toBe("number");
    } finally {
      client.close();
    }
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 3: CHAT — Send message via SDK chat protocol
// ═══════════════════════════════════════════════════════════════════

describe("Stage 3: Chat via WebSocket", () => {
  test("send chat message and receive response", async () => {
    const doName = buildDoName();
    const host = getWsHost();

    const client = new AgentClient({
      agent: "chat-agent",
      name: doName,
      host,
      query: TOKEN ? { token: TOKEN } : undefined,
    });

    await client.ready;

    // Collect messages
    const received: any[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Chat timeout")), 60_000);
      const origMsg = client.onmessage;
      client.onmessage = (event: MessageEvent) => {
        origMsg?.call(client, event);
        try {
          const data = JSON.parse(event.data);
          received.push(data);
          // Chat response with done flag
          if (data.type === "cf_agent_use_chat_response" && data.done) {
            clearTimeout(timeout);
            resolve();
          }
          // Also accept cf_agent_chat_messages as completion
          if (data.type === "cf_agent_chat_messages") {
            clearTimeout(timeout);
            resolve();
          }
        } catch {}
      };
    });

    // Send chat request — Think expects init.body wrapper with stringified UIMessage
    const chatBody = JSON.stringify({
      messages: [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Reply with exactly one word: hello" }] }],
      trigger: "submit-message",
    });
    client.send(JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: crypto.randomUUID(),
      init: { method: "POST", body: chatBody },
    }));

    await done;
    client.close();

    // Should have received at least one response
    expect(received.length).toBeGreaterThan(0);
    // Should have chat-related messages
    const chatMsgs = received.filter(m =>
      m.type === "cf_agent_use_chat_response" || m.type === "cf_agent_chat_messages"
    );
    expect(chatMsgs.length).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 4: LATENCY — TTFT SLO
// ═══════════════════════════════════════════════════════════════════

describe("Stage 4: Latency SLOs", () => {
  test("TTFT under 15 seconds via WebSocket", async () => {
    const doName = buildDoName();
    const host = getWsHost();

    const client = new AgentClient({
      agent: "chat-agent",
      name: doName,
      host,
      query: TOKEN ? { token: TOKEN } : undefined,
    });

    await client.ready;

    const start = Date.now();
    let ttft = 0;

    const firstToken = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("TTFT timeout")), 15_000);
      const origMsg = client.onmessage;
      client.onmessage = (event: MessageEvent) => {
        origMsg?.call(client, event);
        try {
          const data = JSON.parse(event.data);
          if (data.type === "cf_agent_use_chat_response" && !ttft) {
            ttft = Date.now() - start;
            clearTimeout(timeout);
            resolve();
          }
        } catch {}
      };
    });

    const ttftBody = JSON.stringify({
      messages: [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Hi" }] }],
      trigger: "submit-message",
    });
    client.send(JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: crypto.randomUUID(),
      init: { method: "POST", body: ttftBody },
    }));

    await firstToken;
    client.close();

    expect(ttft).toBeGreaterThan(0);
    expect(ttft).toBeLessThan(15_000);
  }, TIMEOUT);
});
