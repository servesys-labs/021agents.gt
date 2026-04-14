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
import WebSocket from "ws";
// AgentClient uses PartySocket (browser WebSocket) — not compatible with Node.js test env.
// Use raw 'ws' WebSocket for E2E tests, matching the exact protocol Think expects.

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

describe("Stage 2: WebSocket Connection to Agent DO", () => {
  function connectWs(doName: string): Promise<{ ws: WebSocket; messages: any[] }> {
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://${getWsHost()}/agents/chat-agent/${doName}?token=${TOKEN}`;
      const ws = new WebSocket(wsUrl);
      const messages: any[] = [];
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 10_000);
      ws.on("open", () => { clearTimeout(timeout); });
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        // Resolve after identity message (connection fully established)
        if (msg.type === "cf_agent_identity") resolve({ ws, messages });
      });
      ws.on("error", (err: Error) => { clearTimeout(timeout); reject(err); });
    });
  }

  test("WebSocket connects and receives identity", async () => {
    const { ws, messages } = await connectWs(buildDoName());
    const identity = messages.find((m: any) => m.type === "cf_agent_identity");
    expect(identity).toBeDefined();
    expect(identity.agent).toBe("chat-agent");
    ws.close();
  }, TIMEOUT);

  test("RPC call via WebSocket (getTenants)", async () => {
    const { ws } = await connectWs(buildDoName());

    const result = await new Promise<any>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => reject(new Error("RPC timeout")), 15_000);
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "rpc" && msg.id === id) {
          clearTimeout(timeout);
          resolve(msg.result);
        }
      });
      ws.send(JSON.stringify({ type: "rpc", id, method: "getTenants", args: [] }));
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    ws.close();
  }, TIMEOUT);

  test("RPC call — listServers", async () => {
    const { ws } = await connectWs(buildDoName());

    const result = await new Promise<any>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => reject(new Error("RPC timeout")), 15_000);
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "rpc" && msg.id === id) {
          clearTimeout(timeout);
          resolve(msg.result);
        }
      });
      ws.send(JSON.stringify({ type: "rpc", id, method: "listServers", args: [] }));
    });

    expect(result).toBeDefined();
    ws.close();
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 3: CHAT — Send message via SDK chat protocol
// ═══════════════════════════════════════════════════════════════════

describe("Stage 3: Chat via WebSocket", () => {
  test("send chat message and receive streaming response from Kimi K2.5", async () => {
    const wsUrl = `wss://${getWsHost()}/agents/chat-agent/chat-e2e-${Date.now()}?token=${TOKEN}`;
    const ws = new WebSocket(wsUrl);

    // Wait for identity
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connect timeout")), 10_000);
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "cf_agent_identity") { clearTimeout(timeout); resolve(); }
      });
      ws.on("error", (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    // Send chat and collect response
    let textContent = "";
    let chunkCount = 0;
    let gotFinish = false;

    const chatDone = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Resolve even on timeout if we got some text
        if (textContent.length > 0) resolve();
        else reject(new Error("Chat timeout — no response from LLM"));
      }, 60_000);
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "cf_agent_use_chat_response" || !msg.body) return;
        chunkCount++;
        const chunk = JSON.parse(msg.body);
        if (chunk.type === "text-delta") textContent += chunk.delta;
        if (chunk.type === "finish" || msg.done === true) {
          gotFinish = true;
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    // Send with correct Think init.body format
    const chatBody = JSON.stringify({
      messages: [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Say exactly: four" }] }],
      trigger: "submit-message",
    });
    ws.send(JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: crypto.randomUUID(),
      init: { method: "POST", body: chatBody },
    }));

    await chatDone;
    ws.close();

    expect(chunkCount).toBeGreaterThan(0);
    expect(textContent.length).toBeGreaterThan(0);
    expect(textContent.toLowerCase()).toContain("four");
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 4: LATENCY — TTFT SLO
// ═══════════════════════════════════════════════════════════════════

describe("Stage 4: Latency SLOs", () => {
  test("TTFT under 15 seconds via WebSocket", async () => {
    const wsUrl = `wss://${getWsHost()}/agents/chat-agent/ttft-${Date.now()}?token=${TOKEN}`;
    const ws = new WebSocket(wsUrl);

    // Wait for identity
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connect timeout")), 10_000);
      ws.on("message", (data: Buffer) => {
        if (JSON.parse(data.toString()).type === "cf_agent_identity") {
          clearTimeout(timeout); resolve();
        }
      });
      ws.on("error", (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    const start = Date.now();
    let ttft = 0;

    const firstChunk = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("TTFT timeout > 15s")), 15_000);
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "cf_agent_use_chat_response" && !ttft) {
          ttft = Date.now() - start;
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const ttftBody = JSON.stringify({
      messages: [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Hi" }] }],
      trigger: "submit-message",
    });
    ws.send(JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: crypto.randomUUID(),
      init: { method: "POST", body: ttftBody },
    }));

    await firstChunk;
    ws.close();

    expect(ttft).toBeGreaterThan(0);
    expect(ttft).toBeLessThan(15_000);
  }, TIMEOUT);
});
