import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { mockEnv, buildDbClientMock, type MockSqlFn } from "./helpers/test-env";

// Shared tagged-template sql mock — individual tests replace its
// implementation by assigning mockSql directly.
let mockSql: MockSqlFn = (async () => []) as unknown as MockSqlFn;

vi.mock("../src/db/client", () => buildDbClientMock(() => mockSql));

// Route import MUST come after the vi.mock call so the mocked db/client
// is resolved when the routes file loads.
import { voiceRoutes } from "../src/routes/voice";
import { verifyWebhookHmac } from "../src/logic/voice-webhook";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function makeUser(orgId = "org-a"): CurrentUser {
  return {
    user_id: "u-1",
    email: "u@test.com",
    name: "User",
    org_id: orgId,
    project_id: "",
    env: "",
    role: "admin",
    scopes: ["*"],
    auth_method: "jwt",
  };
}

function buildApp(orgId = "org-a") {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    c.set("user", makeUser(orgId));
    await next();
  });
  app.route("/", voiceRoutes);
  return app;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("voice routes", () => {
  beforeEach(() => {
  });

  it("GET unknown platform calls is treated as an agent_name lookup", async () => {
    // The /{platform}/calls route changed semantics: if the path segment
    // isn't a known voice platform (vapi, tavus, etc.), it's treated as
    // an agent_name filter and returns the agent's call history from
    // voice_calls. Result: 200 with `platform: "all"` instead of 404.
    mockSql = (async (strings: TemplateStringsArray) => {
      const q = strings.join("?");
      if (q.includes("FROM voice_calls") && q.includes("agent_name")) return [];
      return [];
    }) as unknown as MockSqlFn;
    const app = buildApp();
    const res = await app.request("/elevenlabs/calls", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { calls: unknown[]; platform: string };
    expect(body.platform).toBe("all");
    expect(Array.isArray(body.calls)).toBe(true);
  });

  it("GET vapi call detail is org-scoped (404 other org)", async () => {
    mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join("?");
      if (q.includes("FROM voice_calls") && q.includes("org_id")) {
        return [];
      }
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request("/vapi/calls/call-1", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("GET vapi call detail returns row when org matches", async () => {
    mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join("?");
      // RLS: org scoping now handled by withOrgDb, query only filters by call_id/platform.
      if (q.includes("FROM voice_calls")) {
        return [{ call_id: "call-1", org_id: "org-a", platform: "vapi" }];
      }
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request("/vapi/calls/call-1", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { call_id: string };
    expect(body.call_id).toBe("call-1");
  });

  it("GET vapi call events is org-scoped", async () => {
    mockSql = (async (strings: TemplateStringsArray) => {
      const q = strings.join("?");
      if (q.includes("SELECT 1 FROM voice_calls")) return [];
      if (q.includes("voice_call_events")) return [{ id: 1 }];
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request("/vapi/calls/x/events", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("GET tavus call detail is org-scoped", async () => {
    mockSql = (async () => []) as unknown as MockSqlFn;
    const app = buildApp("org-a");
    const res = await app.request("/tavus/calls/conv-1", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("GET tavus call events includes platform and respects org", async () => {
    mockSql = (async (strings: TemplateStringsArray) => {
      const q = strings.join("?");
      if (q.includes("SELECT 1 FROM voice_calls")) return [{ "?": 1 }];
      if (q.includes("voice_call_events")) return [{ evt: 1 }];
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp("org-a");
    const res = await app.request("/tavus/calls/c1/events", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; platform: string };
    expect(body.platform).toBe("tavus");
    expect(body.events.length).toBe(1);
  });

  it("POST /vapi/webhook rejects unsigned payload when secret unset (hardened)", async () => {
    // April 2026 hardening: verifyWebhookHmac now rejects empty-secret
    // configs so an unconfigured webhook can't accept arbitrary Vapi
    // payloads. Production this surfaces as a 401 in wrangler logs
    // and tells the operator they forgot to set VAPI_WEBHOOK_SECRET.
    mockSql = (async () => []) as unknown as MockSqlFn;
    const app = buildApp();
    const payload = { message: { type: "call.started", call: { id: "c1" } } };
    const res = await app.request("/vapi/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, mockEnv({ VAPI_WEBHOOK_SECRET: undefined }));
    expect(res.status).toBe(401);
  });

  it("POST /vapi/webhook rejects bad signature when secret set", async () => {
    mockSql = (async () => []) as unknown as MockSqlFn;
    const app = buildApp();
    const raw = JSON.stringify({ ok: true });
    const res = await app.request("/vapi/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vapi-signature": "deadbeef",
      },
      body: raw,
    }, mockEnv({ VAPI_WEBHOOK_SECRET: "sec" }));
    expect(res.status).toBe(401);
  });

  it("POST /vapi/webhook accepts valid signature", async () => {
    mockSql = (async () => []) as unknown as MockSqlFn;
    const app = buildApp();
    const raw = JSON.stringify({ message: { type: "hang", call: { id: "c9" } } });
    const sig = await hmacHex("whsec", raw);
    const res = await app.request("/vapi/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vapi-signature": sig,
      },
      body: raw,
    }, mockEnv({ VAPI_WEBHOOK_SECRET: "whsec" }));
    expect(res.status).toBe(200);
  });

  it("POST /tavus/webhook returns 404 for unknown path platform", async () => {
    const app = buildApp();
    const res = await app.request("/unknown/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("POST /tavus/webhook rejects unsigned payload without secret (hardened)", async () => {
    // Same hardening as /vapi/webhook — a Tavus webhook with no
    // TAVUS_WEBHOOK_SECRET configured cannot accept unsigned events.
    mockSql = (async () => []) as unknown as MockSqlFn;
    const app = buildApp();
    const res = await app.request("/tavus/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "conversation.started", conversation_id: "t1" }),
    }, mockEnv());
    expect(res.status).toBe(401);
  });

  it("POST /vapi/calls returns 400 without API key", async () => {
    mockSql = (async () => []) as unknown as MockSqlFn;
    const app = buildApp();
    const res = await app.request("/vapi/calls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone_number_id: "pn_1",
        customer_phone: "+15551234567",
        assistant_id: "asst_1",
      }),
    }, mockEnv({ VAPI_API_KEY: undefined }));
    expect(res.status).toBe(400);
  });

  describe("outbound API proxy", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("POST /vapi/calls proxies to Vapi and persists", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ id: "vapi-new-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      ) as any;

      mockSql = (async () => []) as unknown as MockSqlFn;
      const app = buildApp("org-x");
      const res = await app.request("/vapi/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number_id: "pn_1",
          customer_phone: "+15551234567",
          assistant_id: "asst_1",
          agent_name: "agent-a",
        }),
      }, mockEnv({ VAPI_API_KEY: "vk_test" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { call_id: string; status: string };
      expect(body.call_id).toBe("vapi-new-1");
      expect(body.status).toBe("initiated");
      expect(globalThis.fetch).toHaveBeenCalled();
      const fetchUrl = (globalThis.fetch as any).mock.calls[0][0] as string;
      expect(String(fetchUrl)).toContain("api.vapi.ai/call");
    });

    it("DELETE /vapi/calls/:id proxies end call", async () => {
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as any;
      mockSql = (async () => []) as unknown as MockSqlFn;
      const app = buildApp();
      const res = await app.request("/vapi/calls/abc", { method: "DELETE" }, mockEnv({ VAPI_API_KEY: "vk" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ended: boolean };
      expect(body.ended).toBe(true);
    });

    it("POST /tavus/calls creates conversation via Tavus API", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ conversation_id: "tv-99" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      ) as any;
      mockSql = (async () => []) as unknown as MockSqlFn;
      const app = buildApp("org-z");
      const res = await app.request("/tavus/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona_id: "p1", context: "hi", agent_name: "a1" }),
      }, mockEnv({ TAVUS_API_KEY: "tk" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { conversation_id: string };
      expect(body.conversation_id).toBe("tv-99");
    });

    it("POST /tavus/calls returns 400 without Tavus key", async () => {
      mockSql = (async () => []) as unknown as MockSqlFn;
      const app = buildApp();
      const res = await app.request("/tavus/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona_id: "p1" }),
      }, mockEnv({ TAVUS_API_KEY: undefined }));
      expect(res.status).toBe(400);
    });
  });
});

describe("verifyWebhookHmac", () => {
  it("returns false when secret empty (hardened)", async () => {
    // April 2026 hardening: empty secret = unconfigured webhook = reject.
    // Any 200 here would mean the webhook accepts arbitrary payloads
    // without verification, which is the exact attack surface the
    // hardening was added to close.
    const ok = await verifyWebhookHmac("", new ArrayBuffer(0), "");
    expect(ok).toBe(false);
  });

  it("returns false when signature missing even with valid secret", async () => {
    const ok = await verifyWebhookHmac("whsec", new ArrayBuffer(0), "");
    expect(ok).toBe(false);
  });
});
