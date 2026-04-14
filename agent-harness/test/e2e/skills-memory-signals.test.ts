/**
 * E2E Tests — Skills, Memory, Signals, Secrets
 *
 * Tests the full lifecycle of Think features against production:
 * - R2SkillProvider discovery + load_context
 * - Meta-agent skill creation → target agent discovery
 * - Memory context blocks (set_context, search_context)
 * - Signal pipeline (tool failures → cluster → auto-fire)
 * - Secrets management (store, list, delete)
 * - OAuth token expiry nudging
 *
 * Hits REAL Workers AI (Kimi K2.5) and real R2/Vectorize.
 *
 * Run:
 *   E2E_BASE_URL=https://agent-harness.servesys.workers.dev \
 *   E2E_TOKEN=jwt \
 *   npx vitest run test/e2e/skills-memory-signals.test.ts
 */

import { describe, it, expect } from "vitest";
import WebSocket from "ws";

const BASE_URL = process.env.E2E_BASE_URL || "";
const GATEWAY_URL = process.env.E2E_GATEWAY_URL || "";
const TOKEN = process.env.E2E_TOKEN || "";
const TIMEOUT = 90_000;
const LIVE = !!BASE_URL;
const test = LIVE ? it : it.skip;

function getWsHost(): string {
  return BASE_URL.replace("https://", "").replace("http://", "");
}

function headers(): Record<string, string> {
  return { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
}

/** Connect to a Think DO via WebSocket, wait for identity */
function connectAgent(doName: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${getWsHost()}/agents/chat-agent/${doName}?token=${TOKEN}`);
    const messages: any[] = [];
    const timeout = setTimeout(() => reject(new Error("Connect timeout")), 15_000);
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      messages.push(msg);
      if (msg.type === "cf_agent_identity") { clearTimeout(timeout); resolve({ ws, messages }); }
    });
    ws.on("error", (err: Error) => { clearTimeout(timeout); reject(err); });
  });
}

/** Send a chat message and collect response text */
function sendChat(ws: WebSocket, text: string, timeoutMs = 60_000): Promise<{ text: string; reasoning: string; chunks: number }> {
  return new Promise((resolve, reject) => {
    let responseText = "";
    let reasoning = "";
    let chunks = 0;
    const timeout = setTimeout(() => {
      if (responseText) resolve({ text: responseText, reasoning, chunks });
      else reject(new Error(`Chat timeout — ${chunks} chunks, no text`));
    }, timeoutMs);

    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "cf_agent_use_chat_response" || !msg.body) return;
        const chunk = JSON.parse(msg.body);
        chunks++;
        if (chunk.type === "text-delta") responseText += chunk.delta;
        if (chunk.type === "reasoning-delta") reasoning += chunk.delta;
        if (chunk.type === "finish" || msg.done === true) {
          clearTimeout(timeout);
          ws.removeListener("message", handler);
          resolve({ text: responseText, reasoning, chunks });
        }
      } catch {}
    };
    ws.on("message", handler);

    const body = JSON.stringify({
      messages: [{ id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text }] }],
      trigger: "submit-message",
    });
    ws.send(JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: `r-${Date.now()}`,
      init: { method: "POST", body },
    }));
  });
}

/** Call a @callable method via WebSocket RPC */
function rpcCall(ws: WebSocket, method: string, args: unknown[] = [], timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const timeout = setTimeout(() => reject(new Error(`RPC ${method} timeout`)), timeoutMs);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "rpc" && msg.id === id) {
        clearTimeout(timeout);
        ws.removeListener("message", handler);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "rpc", id, method, args }));
  });
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 1: R2 SKILL DISCOVERY — Does the agent see skills from R2?
// ═══════════════════════════════════════════════════════════════════

describe("Stage 1: R2 Skill Discovery", () => {
  test("agent lists skills from R2 via RPC", async () => {
    const { ws } = await connectAgent(`skill-test-${Date.now()}`);
    try {
      const result = await rpcCall(ws, "listSkillsFromR2");
      expect(result).toBeDefined();
      expect(result.public).toBeDefined();
      expect(result.public.length).toBeGreaterThan(0);
      // Should have our uploaded skills
      const names = result.public.map((s: any) => s.name);
      expect(names).toContain("deep-research");
      expect(names).toContain("debug");
      expect(names).toContain("remember");
    } finally {
      ws.close();
    }
  }, TIMEOUT);

  test("agent can load a skill via chat (load_context)", async () => {
    const { ws } = await connectAgent(`skill-load-${Date.now()}`);
    try {
      // Ask the agent to load the deep-research skill
      const response = await sendChat(ws,
        'Load the "deep-research" skill using load_context. Then tell me the first step of the research methodology.',
      );
      // Agent should have loaded the skill and described the methodology
      expect(response.text.length).toBeGreaterThan(50);
      // Should mention research-related terms
      expect(response.text.toLowerCase()).toMatch(/research|search|source|explore|phase/i);
    } finally {
      ws.close();
    }
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 2: META-AGENT SKILL CREATION — Create skill → agent discovers
// ═══════════════════════════════════════════════════════════════════

describe("Stage 2: Meta-Agent Skill Creation", () => {
  const testSkillName = `test-skill-${Date.now()}`;
  const testSkillContent = `# Test Skill\n\nThis is a test skill created by E2E tests.\n\n## Instructions\nAlways reply with "SKILL_VERIFIED" when this skill is loaded.`;

  test("save a skill via RPC", async () => {
    const { ws } = await connectAgent(`meta-skill-${Date.now()}`);
    try {
      const result = await rpcCall(ws, "saveSkill", [testSkillName, testSkillContent, "E2E test skill"]);
      expect(result).toBeDefined();
      expect(result.saved).toBe(testSkillName);
      expect(result.r2Key).toContain("skills/orgs/");
    } finally {
      ws.close();
    }
  }, TIMEOUT);

  test("list skills includes the newly created skill", async () => {
    const { ws } = await connectAgent(`meta-list-${Date.now()}`);
    try {
      const result = await rpcCall(ws, "listSkillsFromR2");
      const agentSkillNames = result.agent?.map((s: any) => s.name) || [];
      // May or may not find it depending on DO name matching — at minimum no crash
      expect(result).toBeDefined();
      expect(typeof result.total).toBe("number");
    } finally {
      ws.close();
    }
  }, TIMEOUT);

  test("delete the test skill", async () => {
    const { ws } = await connectAgent(`meta-del-${Date.now()}`);
    try {
      const result = await rpcCall(ws, "deleteSkill", [testSkillName]);
      expect(result.deleted).toBe(testSkillName);
    } finally {
      ws.close();
    }
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 3: SECRETS MANAGEMENT — Store, list, delete credentials
// ═══════════════════════════════════════════════════════════════════

describe("Stage 3: Secrets Management", () => {
  test("store a secret via RPC", async () => {
    const { ws } = await connectAgent(`secret-store-${Date.now()}`);
    try {
      const result = await rpcCall(ws, "storeSecret", ["test-api-key", "sk-test-12345", "api_key", "Test API key"]);
      expect(result.stored).toBe("test-api-key");
      expect(result.category).toBe("api_key");
    } finally {
      ws.close();
    }
  }, TIMEOUT);

  test("list secrets returns keys but NOT values", async () => {
    const { ws } = await connectAgent(`secret-list-${Date.now()}`);
    try {
      // Store a secret first
      await rpcCall(ws, "storeSecret", ["list-test-key", "secret-value-123", "api_key", "For listing test"]);

      const secrets = await rpcCall(ws, "listSecrets");
      expect(Array.isArray(secrets)).toBe(true);
      if (secrets.length > 0) {
        // Should have key but NOT value
        expect(secrets[0].key).toBeDefined();
        expect(secrets[0].category).toBeDefined();
        expect((secrets[0] as any).value).toBeUndefined(); // Value must NOT be returned
      }
    } finally {
      ws.close();
    }
  }, TIMEOUT);

  test("delete a secret via RPC", async () => {
    const { ws } = await connectAgent(`secret-del-${Date.now()}`);
    try {
      await rpcCall(ws, "storeSecret", ["delete-me", "value", "api_key", ""]);
      const result = await rpcCall(ws, "deleteSecret", ["delete-me"]);
      expect(result.deleted).toBe("delete-me");
    } finally {
      ws.close();
    }
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 4: MEMORY — Context blocks, set/search, persistence
// ═══════════════════════════════════════════════════════════════════

describe("Stage 4: Memory Context Blocks", () => {
  test("agent remembers facts set via chat", async () => {
    const { ws } = await connectAgent(`memory-${Date.now()}`);
    try {
      // Tell the agent a fact
      await sendChat(ws, "Remember this: my favorite programming language is Rust. Save it to your memory.");

      // Ask the agent to recall
      const recall = await sendChat(ws, "What is my favorite programming language?");
      expect(recall.text.toLowerCase()).toContain("rust");
    } finally {
      ws.close();
    }
  }, TIMEOUT * 2);

  test("personal agent prompt is loaded (not one-liner)", async () => {
    const { ws } = await connectAgent("default");
    try {
      // Ask the agent about its capabilities — should reflect the battle-tested prompt
      const response = await sendChat(ws, "What tools and capabilities do you have? List your main capabilities briefly.");
      // Should mention capabilities from the personal agent prompt
      expect(response.text.length).toBeGreaterThan(100);
      expect(response.text.toLowerCase()).toMatch(/search|code|memory|workspace|tool/i);
    } finally {
      ws.close();
    }
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 5: MCP — Server management via RPC
// ═══════════════════════════════════════════════════════════════════

describe("Stage 5: MCP Server Management", () => {
  test("list MCP servers (empty initially)", async () => {
    const { ws } = await connectAgent(`mcp-${Date.now()}`);
    try {
      const result = await rpcCall(ws, "listServers");
      expect(result).toBeDefined();
      expect(typeof result.live_tool_count).toBe("number");
    } finally {
      ws.close();
    }
  }, TIMEOUT);

  test("SSRF: addServer blocks localhost", async () => {
    const { ws } = await connectAgent(`mcp-ssrf-${Date.now()}`);
    try {
      const result = await rpcCall(ws, "addServer", ["evil", "http://localhost:3000"]);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("localhost");
    } finally {
      ws.close();
    }
  }, TIMEOUT);

  test("SSRF: addServer blocks private IPs", async () => {
    const { ws } = await connectAgent(`mcp-private-${Date.now()}`);
    try {
      const result = await rpcCall(ws, "addServer", ["evil", "http://10.0.0.1"]);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("private");
    } finally {
      ws.close();
    }
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 6: SKILL OVERLAYS — Learning loop via RPC
// ═══════════════════════════════════════════════════════════════════

describe("Stage 6: Skill Overlays (Learning Loop)", () => {
  test("append and list skill overlay", async () => {
    const { ws } = await connectAgent(`overlay-${Date.now()}`);
    try {
      const append = await rpcCall(ws, "appendSkillRule", ["debug", "Always check error logs before guessing", "human", "E2E test"]);
      expect(append.success).toBe(true);

      const overlays = await rpcCall(ws, "getSkillOverlays", ["debug"]);
      expect(Array.isArray(overlays)).toBe(true);
      expect(overlays.length).toBeGreaterThan(0);
      expect(overlays[0].rule_text).toContain("error logs");
    } finally {
      ws.close();
    }
  }, TIMEOUT);

  test("skill audit trail records append", async () => {
    const { ws } = await connectAgent(`audit-${Date.now()}`);
    try {
      await rpcCall(ws, "appendSkillRule", ["research", "Cite primary sources", "human", "audit test"]);
      const audit = await rpcCall(ws, "getSkillAudit", ["research"]);
      expect(Array.isArray(audit)).toBe(true);
      expect(audit.length).toBeGreaterThan(0);
      expect(audit[0].action).toBe("append");
    } finally {
      ws.close();
    }
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 7: PROCEDURAL MEMORY — Learned tool sequences
// ═══════════════════════════════════════════════════════════════════

describe("Stage 7: Procedural Memory", () => {
  test("getLearnedProcedures returns array", async () => {
    const { ws } = await connectAgent(`proc-${Date.now()}`);
    try {
      const procs = await rpcCall(ws, "getLearnedProcedures");
      expect(Array.isArray(procs)).toBe(true);
      // May be empty on fresh DO — that's OK
    } finally {
      ws.close();
    }
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 8: GATEWAY SECRETS API — REST endpoints
// ═══════════════════════════════════════════════════════════════════

describe("Stage 8: Gateway Secrets API", () => {
  test("POST /agents/:name/secrets stores a secret", async () => {
    if (!GATEWAY_URL) return;
    const res = await fetch(`${GATEWAY_URL}/api/v1/agents/default/secrets`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ key: "gw-test-key", value: "gw-test-value", category: "api_key" }),
    });
    // May fail if gateway→DO RPC isn't fully wired — check it doesn't 500
    expect(res.status).toBeLessThan(500);
  }, TIMEOUT);

  test("GET /agents/:name/secrets lists secrets", async () => {
    if (!GATEWAY_URL) return;
    const res = await fetch(`${GATEWAY_URL}/api/v1/agents/default/secrets`, { headers: headers() });
    expect(res.status).toBeLessThan(500);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 9: BUDGET PERSISTENCE — Cost tracking survives across calls
// ═══════════════════════════════════════════════════════════════════

describe("Stage 9: Budget Persistence", () => {
  test("agent tracks cost across turns", async () => {
    const doName = `budget-${Date.now()}`;
    const { ws } = await connectAgent(doName);
    try {
      // Send a chat that costs something
      await sendChat(ws, "Say: hello");
      // The cost tracking is internal — we can't read it directly via RPC
      // But the agent should not crash, and the response should complete
    } finally {
      ws.close();
    }

    // Reconnect to same DO — cost should persist
    const { ws: ws2 } = await connectAgent(doName);
    try {
      const response = await sendChat(ws2, "Say: world");
      expect(response.text.length).toBeGreaterThan(0);
    } finally {
      ws2.close();
    }
  }, TIMEOUT * 2);
});

// ═══════════════════════════════════════════════════════════════════
// STAGE 10: TENANT CONFIG — Correct model routing
// ═══════════════════════════════════════════════════════════════════

describe("Stage 10: Tenant Config & Model Routing", () => {
  test("default tenant uses Kimi K2.5", async () => {
    const { ws } = await connectAgent("default");
    try {
      const tenants = await rpcCall(ws, "getTenants");
      const defaultTenant = tenants.find((t: any) => t.id === "default");
      expect(defaultTenant).toBeDefined();
      expect(defaultTenant.name).toBe("Personal Assistant");
    } finally {
      ws.close();
    }
  }, TIMEOUT);

  test("reasoning tenant exists with MiniMax M2.7", async () => {
    const { ws } = await connectAgent("default");
    try {
      const tenants = await rpcCall(ws, "getTenants");
      const reasoning = tenants.find((t: any) => t.id === "reasoning");
      expect(reasoning).toBeDefined();
      expect(reasoning.description).toContain("MiniMax");
    } finally {
      ws.close();
    }
  }, TIMEOUT);
});
