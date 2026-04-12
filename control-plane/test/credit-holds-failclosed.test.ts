import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

import { reserveCreditHold, settleCreditHold, reclaimExpiredCreditHolds } from "../src/logic/credits";
import { buildDbClientMock, mockEnv, type MockSqlFn } from "./helpers/test-env";

let mockSql: MockSqlFn = (async () => []) as unknown as MockSqlFn;
vi.mock("../src/db/client", () => buildDbClientMock(() => mockSql));

import { publicAgentRoutes } from "../src/routes/public-api";
import type { CurrentUser } from "../src/auth/types";
import type { Env } from "../src/env";

type HoldRow = {
  hold_id: string;
  org_id: string;
  session_id: string;
  hold_amount_usd: number;
  status: "active" | "settled" | "released" | "expired";
  expires_at: string;
  actual_cost_usd?: number;
  settled_at?: string;
  locked?: boolean;
};

function createBillingSqlState(initialBalance = 5) {
  const state = {
    balance: initialBalance,
    reserved: 0,
    holds: new Map<string, HoldRow>(),
    holdBySession: new Map<string, string>(),
    billingExceptions: [] as Array<{ org_id: string; kind: string; amount_usd: number; resolved_at: string | null; hold_id?: string; session_id?: string }>,
  };

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");

    if (query.includes("SELECT name FROM agents WHERE name =")) {
      return [{ name: String(values[0]) }];
    }
    if (query.includes("INSERT INTO conversations")) return [{ conversation_id: String(values[0]) }];
    if (query.includes("INSERT INTO conversation_messages")) return [{ id: 1 }];
    if (query.includes("UPDATE conversations SET message_count")) return [{ conversation_id: String(values[0] || "") }];
    if (query.includes("SELECT response_body FROM idempotency_cache")) return [];
    if (query.includes("SELECT auto_redact_pii FROM org_settings")) return [{ auto_redact_pii: false }];

    if (query.includes("SELECT COALESCE(SUM(amount_usd), 0) AS total") && query.includes("FROM billing_exceptions")) {
      const total = state.billingExceptions
        .filter((r) => r.kind === "unrecovered_cost" && r.resolved_at === null)
        .reduce((s, r) => s + r.amount_usd, 0);
      return [{ total }];
    }

    if (query.includes("FROM credit_holds") && query.includes("WHERE org_id = ?") && query.includes("session_id = ?") && query.includes("status = 'active'")) {
      const orgId = String(values[0]);
      const sessionId = String(values[1]);
      const holdId = state.holdBySession.get(`${orgId}:${sessionId}`);
      if (!holdId) return [];
      const hold = state.holds.get(holdId);
      if (!hold || hold.status !== "active") return [];
      return [{ hold_id: hold.hold_id, hold_amount_usd: hold.hold_amount_usd, expires_at: hold.expires_at }];
    }

    if (query.includes("UPDATE org_credit_balance") && query.includes("balance_usd = balance_usd -") && query.includes("reserved_usd = reserved_usd +")) {
      const amount = Number(values[0]);
      if (state.balance < amount) return [];
      state.balance -= amount;
      state.reserved += amount;
      return [{ balance_usd: state.balance, reserved_usd: state.reserved }];
    }

    if (query.includes("INSERT INTO credit_holds") && query.includes("ON CONFLICT (org_id, session_id) DO NOTHING")) {
      // Real INSERT param order (credits.ts:134-141): [holdId, orgId, sessionId,
      // parentHoldId, agentName, safeAmount, expiresAt]. 'active' is a string
      // literal, not a parameter, so expires_at lives at position 6, not 7.
      const holdId = String(values[0]);
      const orgId = String(values[1]);
      const sessionId = String(values[2]);
      const amount = Number(values[5]);
      const expiresAt = String(values[6]);
      const key = `${orgId}:${sessionId}`;
      if (state.holdBySession.has(key)) return [];
      state.holds.set(holdId, {
        hold_id: holdId,
        org_id: orgId,
        session_id: sessionId,
        hold_amount_usd: amount,
        status: "active",
        expires_at: expiresAt,
      });
      state.holdBySession.set(key, holdId);
      return [{ hold_id: holdId, hold_amount_usd: amount, expires_at: expiresAt }];
    }

    if (query.includes("UPDATE org_credit_balance") && query.includes("balance_usd = balance_usd +") && query.includes("reserved_usd = GREATEST(0, reserved_usd -")) {
      const amount = Number(values[0]);
      state.balance += amount;
      state.reserved = Math.max(0, state.reserved - amount);
      return [{ org_id: "org-1" }];
    }

    if (query.includes("FROM credit_holds") && query.includes("WHERE hold_id = ? AND org_id = ?") && query.includes("FOR UPDATE")) {
      const holdId = String(values[0]);
      const hold = state.holds.get(holdId);
      if (!hold) return [];
      hold.locked = true;
      return [{ hold_id: hold.hold_id, hold_amount_usd: hold.hold_amount_usd, status: hold.status, actual_cost_usd: hold.actual_cost_usd }];
    }

    if (query.includes("SELECT balance_usd, reserved_usd") && query.includes("FROM org_credit_balance")) {
      return [{ balance_usd: state.balance, reserved_usd: state.reserved }];
    }

    if (query.includes("SET balance_usd = GREATEST(0, balance_usd +") && query.includes("lifetime_consumed_usd = lifetime_consumed_usd +")) {
      const holdAmount = Number(values[0]);
      const charged = Number(values[1]);
      state.balance = Math.max(0, state.balance + holdAmount - charged);
      state.reserved = Math.max(0, state.reserved - holdAmount);
      return [{ balance_usd: state.balance }];
    }

    if (query.includes("UPDATE credit_holds") && query.includes("SET status = 'settled'")) {
      // Real UPDATE param order (credits.ts:236-243): [now, safeActualCost,
      // sessionId, holdId]. 'settled' is a literal.
      const actual = Number(values[1]);
      const holdId = String(values[3]);
      const hold = state.holds.get(holdId);
      if (!hold) return [];
      hold.status = "settled";
      hold.actual_cost_usd = actual;
      hold.locked = false;
      return [{ hold_id: holdId }];
    }

    if (query.includes("INSERT INTO billing_exceptions")) {
      // Two INSERTs hit this path. Both have kind as a SQL literal, so we
      // detect which one by substring matching the literal in the query text.
      // - Settle debt (credits.ts:257-263): params = [orgId, sessionId,
      //   holdId, excessUsd, holdAmount, safeActualCost, chargedUsd, now]
      // - Reclaim mismatch (credits.ts:348-354): params = [orgId, sessionId,
      //   holdId, amount]
      // In both cases the amount the test cares about lives at position 3.
      const orgId = String(values[0]);
      const sessionId = values[1] ? String(values[1]) : undefined;
      const holdId = values[2] ? String(values[2]) : undefined;
      let kind: string;
      if (query.includes("'unrecovered_cost'")) kind = "unrecovered_cost";
      else if (query.includes("'reclaim_mismatch'")) kind = "reclaim_mismatch";
      else kind = "unknown";
      const amount = Number(values[3] || 0);
      state.billingExceptions.push({ org_id: orgId, session_id: sessionId, hold_id: holdId, kind, amount_usd: amount, resolved_at: null });
      return [{ id: state.billingExceptions.length }];
    }

    if (query.includes("UPDATE credit_holds") && query.includes("SET status = ?") && query.includes("AND status = 'active'")) {
      const status = String(values[0]) as HoldRow["status"];
      const holdId = String(values[2]);
      const hold = state.holds.get(holdId);
      if (!hold || hold.status !== "active") return [];
      hold.status = status;
      hold.locked = false;
      return [{ hold_id: holdId }];
    }

    if (query.includes("SELECT hold_id, org_id, hold_amount_usd, session_id") && query.includes("FOR UPDATE SKIP LOCKED")) {
      const out: any[] = [];
      for (const hold of state.holds.values()) {
        if (hold.status !== "active") continue;
        if (new Date(hold.expires_at).getTime() >= Date.now()) continue;
        if (hold.locked) continue;
        hold.locked = true;
        out.push({
          hold_id: hold.hold_id,
          org_id: hold.org_id,
          hold_amount_usd: hold.hold_amount_usd,
          session_id: hold.session_id,
        });
      }
      return out;
    }

    if (query.includes("UPDATE credit_holds") && query.includes("SET status = 'expired'")) {
      const holdId = String(values[0]);
      const hold = state.holds.get(holdId);
      if (!hold || hold.status !== "active") return [];
      hold.status = "expired";
      hold.locked = false;
      return [{ hold_id: holdId }];
    }

    if (query.includes("INSERT INTO credit_transactions")) return [{ id: 1 }];

    throw new Error(`Unhandled SQL in test double: ${query}`);
  }) as unknown as MockSqlFn;

  return { state, sql };
}

function buildPublicApp(user: CurrentUser) {
  const app = new Hono<{ Bindings: Env; Variables: { user: CurrentUser } }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/v1", publicAgentRoutes);
  return app;
}

describe("credit holds fail-closed debtless", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("C1 refund: settle with actual below hold returns hold delta to balance", async () => {
    const { state, sql } = createBillingSqlState(5);
    const hold = await reserveCreditHold(sql as any, "org-1", "s-1", 0.5, 600, { agentName: "a" });
    expect(hold.success).toBe(true);
    expect(state.balance).toBeCloseTo(4.5, 6);
    expect(state.reserved).toBeCloseTo(0.5, 6);

    const settled = await settleCreditHold(sql as any, "org-1", (hold as any).hold_id, 0.03, "run", "a", "s-1");
    expect(settled.success).toBe(true);
    expect(state.balance).toBeCloseTo(4.97, 6);
    expect(state.reserved).toBeCloseTo(0, 6);
  });

  it("C2 debt creation: overflow creates unrecovered_cost debt and zeroes balance", async () => {
    const { state, sql } = createBillingSqlState(0.8);
    const hold = await reserveCreditHold(sql as any, "org-1", "s-2", 0.5, 600, { agentName: "a" });
    expect(hold.success).toBe(true); // balance=0.3 reserved=0.5
    const settled = await settleCreditHold(sql as any, "org-1", (hold as any).hold_id, 1.5, "run", "a", "s-2");
    expect(settled.success).toBe(true);
    expect(settled.charged_usd).toBeCloseTo(0.8, 6);
    expect(settled.excess_usd).toBeCloseTo(0.7, 6);
    expect(settled.debt_created).toBe(true);
    expect(state.balance).toBeCloseTo(0, 6);
    expect(state.billingExceptions.some((r) => r.kind === "unrecovered_cost" && Math.abs(r.amount_usd - 0.7) < 1e-6)).toBe(true);
  });

  it("C4/C6 idempotency: second reserve with same session reuses hold", async () => {
    const { state, sql } = createBillingSqlState(5);
    const first = await reserveCreditHold(sql as any, "org-1", "same-session", 0.5, 600, { agentName: "a" });
    const second = await reserveCreditHold(sql as any, "org-1", "same-session", 0.5, 600, { agentName: "a" });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect((first as any).hold_id).toBe((second as any).hold_id);
    expect(state.balance).toBeCloseTo(4.5, 6);
    expect(state.reserved).toBeCloseTo(0.5, 6);
  });

  it("C5 race safety: reclaim skips a hold locked by settle", async () => {
    const { state, sql } = createBillingSqlState(5);
    const hold = await reserveCreditHold(sql as any, "org-1", "race-1", 0.5, 1, { agentName: "a" });
    expect(hold.success).toBe(true);
    const holdId = (hold as any).hold_id as string;
    state.holds.get(holdId)!.expires_at = new Date(Date.now() - 5_000).toISOString();
    state.holds.get(holdId)!.locked = true; // simulate settle in-flight lock
    const reclaimed = await reclaimExpiredCreditHolds(sql as any, 50);
    expect(reclaimed).toBe(0);
    state.holds.get(holdId)!.locked = false;
    const settled = await settleCreditHold(sql as any, "org-1", holdId, 0.2, "run", "a", "race-1");
    expect(settled.success).toBe(true);
    expect(state.reserved).toBeCloseTo(0, 6);
  });

  it("C7 stream error path: runtime 503 releases hold without billing", async () => {
    const { state, sql } = createBillingSqlState(5);
    mockSql = sql;
    const app = buildPublicApp({
      user_id: "u1",
      email: "u@test.com",
      name: "User",
      org_id: "org-1",
      role: "admin",
      scopes: ["*"],
      auth_method: "api_key",
      project_id: "",
      env: "",
    });
    const env = mockEnv({
      RUNTIME: {
        fetch: async () => new Response(JSON.stringify({ error: "boom", cost_usd: 0.25 }), { status: 503 }),
      } as any,
    });
    const res = await app.request("/v1/agents/demo/run/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    }, env);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(state.balance).toBeCloseTo(5, 6);
    expect(state.reserved).toBeCloseTo(0, 6);
    expect(state.billingExceptions.find((r) => r.kind === "unrecovered_cost")).toBeUndefined();
  });

  it("C8 conversation bootstrap throw: hold is released on runtime exception", async () => {
    const { state, sql } = createBillingSqlState(5);
    mockSql = sql;
    const app = buildPublicApp({
      user_id: "u1",
      email: "u@test.com",
      name: "User",
      org_id: "org-1",
      role: "admin",
      scopes: ["*"],
      auth_method: "api_key",
      project_id: "",
      env: "",
    });
    const env = mockEnv({
      RUNTIME: {
        fetch: async () => {
          throw new Error("connection reset");
        },
      } as any,
    });
    const res = await app.request("/v1/agents/demo/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    }, env);
    expect(res.status).toBe(201);
    expect(state.balance).toBeCloseTo(5, 6);
    expect(state.reserved).toBeCloseTo(0, 6);
  });
});
