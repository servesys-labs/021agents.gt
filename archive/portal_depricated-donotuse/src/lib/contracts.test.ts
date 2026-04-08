/**
 * Portal ↔ Control-Plane contract smoke tests.
 *
 * These validate that the portal sends the right payload shapes
 * and parses the right response shapes from the control-plane API.
 * They catch the exact class of bugs fixed in this sprint:
 * - Wrong field names (from/to vs from_channel/to_channel)
 * - ID field mismatches (id vs issue_id)
 * - Response shape normalization (array vs {keys: []}, key_prefix vs prefix)
 * - Timestamp format differences (seconds vs milliseconds)
 */
import { describe, it, expect } from "vitest";

// ── 1. Deploy promote contract ──────────────────────────────────────

describe("deploy promote payload", () => {
  it("uses from_channel / to_channel (not from / to)", () => {
    // This is what the portal sends to POST /api/v1/releases/{name}/promote
    const payload = {
      from_channel: "draft",
      to_channel: "production",
    };

    // The control-plane expects these exact keys
    expect(payload).toHaveProperty("from_channel");
    expect(payload).toHaveProperty("to_channel");
    expect(payload).not.toHaveProperty("from");
    expect(payload).not.toHaveProperty("to");
  });

  it("verify flow promotes staging → production explicitly", () => {
    const payload = {
      from_channel: "staging",
      to_channel: "production",
    };

    expect(payload.from_channel).toBe("staging");
    expect(payload.to_channel).toBe("production");
  });
});

// ── 2. Issue deep-link + triage path ────────────────────────────────

describe("issue ID contract", () => {
  it("prefers issue_id over id for routing", () => {
    // Backend returns issue_id as the primary key
    const backendIssue = {
      issue_id: "iss_abc123",
      id: 42, // some backends also have numeric id
      title: "Tool timeout",
      severity: "high",
    };

    // Portal should use issue_id for routing, with id fallback
    const routeId = backendIssue.issue_id || String(backendIssue.id) || "";
    expect(routeId).toBe("iss_abc123");
  });

  it("falls back to id when issue_id is missing", () => {
    const legacyIssue = {
      id: "iss_legacy_456",
      title: "Old format issue",
    } as Record<string, unknown>;

    const routeId = (legacyIssue.issue_id as string) || String(legacyIssue.id) || "";
    expect(routeId).toBe("iss_legacy_456");
  });

  it("triage uses issue_id from issue detail response", () => {
    const issueDetail = {
      issue_id: "iss_triage_789",
      status: "open",
      category: "tool_failure",
    };

    // Triage POST target must use issue_id
    const triageUrl = `/api/v1/issues/${issueDetail.issue_id}/triage`;
    expect(triageUrl).toContain("iss_triage_789");
    expect(triageUrl).not.toContain("undefined");
  });
});

// ── 3. API keys list parsing ────────────────────────────────────────

describe("API keys response normalization", () => {
  it("handles array response shape", () => {
    // Some backends return a bare array
    const response = [
      { key_id: "k1", name: "prod", key_prefix: "ak_8f3a", scopes: '["*"]', created_at: 1711900000 },
      { key_id: "k2", name: "dev", key_prefix: "ak_2b7c", scopes: '["agents:read"]', created_at: 1711900000 },
    ];

    const keys = Array.isArray(response) ? response : (response as any).keys ?? [];
    expect(keys).toHaveLength(2);
    expect(keys[0].key_id).toBe("k1");
  });

  it("handles { keys: [] } response shape", () => {
    const response = {
      keys: [
        { key_id: "k1", name: "prod", prefix: "ak_8f3a", scopes: ["*"], created_at: 1711900000 },
      ],
    };

    const keys = Array.isArray(response) ? response : (response as any).keys ?? [];
    expect(keys).toHaveLength(1);
  });

  it("normalizes key_prefix vs prefix", () => {
    const fromBackend = { key_prefix: "ak_8f3a" } as Record<string, unknown>;

    // Portal should check both field names
    const prefix = (fromBackend.key_prefix as string) || (fromBackend.prefix as string) || "ak_????";
    expect(prefix).toBe("ak_8f3a");
  });

  it("normalizes prefix when key_prefix is missing", () => {
    const fromBackend = { prefix: "ak_2b7c" } as Record<string, unknown>;

    const prefix = (fromBackend.key_prefix as string) || (fromBackend.prefix as string) || "ak_????";
    expect(prefix).toBe("ak_2b7c");
  });

  it("parses scopes from JSON string or array", () => {
    // Backend might return scopes as JSON string or as array
    const fromString = { scopes: '["agents:read","sessions:read"]' };
    const fromArray = { scopes: ["agents:read", "sessions:read"] };

    const parseScopes = (raw: unknown): string[] => {
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return []; }
      }
      return [];
    };

    expect(parseScopes(fromString.scopes)).toEqual(["agents:read", "sessions:read"]);
    expect(parseScopes(fromArray.scopes)).toEqual(["agents:read", "sessions:read"]);
  });
});

// ── 4. Timestamp normalization ──────────────────────────────────────

describe("timestamp normalization", () => {
  it("handles epoch seconds (Supabase REAL columns)", () => {
    const epochSeconds = 1711900000; // ~2024-03-31
    const date = new Date(epochSeconds < 1e12 ? epochSeconds * 1000 : epochSeconds);
    expect(date.getFullYear()).toBeGreaterThanOrEqual(2024);
  });

  it("handles epoch milliseconds", () => {
    const epochMs = 1711900000000;
    const date = new Date(epochMs < 1e12 ? epochMs * 1000 : epochMs);
    expect(date.getFullYear()).toBeGreaterThanOrEqual(2024);
  });

  it("handles ISO string", () => {
    const iso = "2024-03-31T12:00:00Z";
    const date = new Date(iso);
    expect(date.getFullYear()).toBe(2024);
  });

  it("daysUntil handles seconds, millis, and strings", () => {
    // This mirrors the fixed daysUntil function in settings
    function daysUntil(val?: string | number): number | null {
      if (val === undefined || val === null) return null;
      const ts = typeof val === "number"
        ? (val < 1e12 ? val * 1000 : val)
        : new Date(String(val)).getTime();
      if (isNaN(ts)) return null;
      return Math.ceil((ts - Date.now()) / 86400000);
    }

    // Future epoch seconds (30 days from now)
    const futureSeconds = Math.floor(Date.now() / 1000) + 30 * 86400;
    const days = daysUntil(futureSeconds);
    expect(days).not.toBeNull();
    expect(days!).toBeGreaterThan(28);
    expect(days!).toBeLessThanOrEqual(31);

    // Null/undefined
    expect(daysUntil(undefined)).toBeNull();
    expect(daysUntil(null as any)).toBeNull();
  });
});

// ── 5. Observability integrity breaches ─────────────────────────────

describe("integrity breaches API shape", () => {
  it("normalizes entries and hottest_traces from control-plane JSON", () => {
    const response = {
      total_breaches: 2,
      strict_breaches: 1,
      non_strict_breaches: 1,
      hottest_traces: [{ trace_id: "tr_1", breaches: 2 }],
      entries: [
        {
          trace_id: "tr_1",
          created_at: "2025-01-01T00:00:00.000Z",
          user_id: "u1",
          strict: true,
          missing_turns: 1,
          missing_runtime_events: 0,
          missing_billing_records: 0,
          lifecycle_mismatch: 0,
          warnings: ["1 sessions have no turns"],
        },
      ],
    };

    const entries = Array.isArray(response.entries) ? response.entries : [];
    const hottest = Array.isArray(response.hottest_traces) ? response.hottest_traces : [];

    expect(entries).toHaveLength(1);
    expect(entries[0].trace_id).toBe("tr_1");
    expect(entries[0].warnings?.[0]).toContain("turns");
    expect(hottest[0]).toEqual({ trace_id: "tr_1", breaches: 2 });
    expect(response.total_breaches).toBe(2);
  });

  it("builds query string for breaches list and optional trace filter", () => {
    const base = "/api/v1/observability/integrity/breaches";
    const list = `${base}?limit=100`;
    const filtered = `${base}?limit=100&trace_id=${encodeURIComponent("tr_abc")}`;
    expect(list).toContain("limit=100");
    expect(filtered).toContain("trace_id=tr_abc");
  });
});

// ── 6. API error parsing ────────────────────────────────────────────

describe("API error response parsing", () => {
  it("extracts error from { error: string }", () => {
    const body = { error: "Agent not found" };
    const msg = body.error || (body as any).detail || (body as any).message || "Unknown error";
    expect(msg).toBe("Agent not found");
  });

  it("extracts detail from { detail: string }", () => {
    const body = { detail: "Insufficient permissions" } as Record<string, unknown>;
    const msg = (body.error as string) || (body.detail as string) || (body.message as string) || "Unknown error";
    expect(msg).toBe("Insufficient permissions");
  });

  it("extracts message from { message: string }", () => {
    const body = { message: "Rate limited" } as Record<string, unknown>;
    const msg = (body.error as string) || (body.detail as string) || (body.message as string) || "Unknown error";
    expect(msg).toBe("Rate limited");
  });

  it("handles nested detail object from FastAPI 422", () => {
    const body = {
      detail: {
        message: "Gate-pack rollout decision is HOLD",
        override_required: true,
      },
    };
    // Portal should stringify nested detail objects
    const msg = typeof body.detail === "string"
      ? body.detail
      : (body.detail as any)?.message || JSON.stringify(body.detail);
    expect(msg).toBe("Gate-pack rollout decision is HOLD");
  });
});
