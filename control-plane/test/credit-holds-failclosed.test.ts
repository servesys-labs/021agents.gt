import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

import {
  reserveCreditHold,
  settleCreditHold,
  releaseCreditHold,
  reclaimExpiredCreditHolds,
  collectOutstandingCreditDebt,
  addCredits,
} from "../src/logic/credits";
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

    // ── Debt-collection handlers (collectOutstandingCreditDebt) ────
    // Separate from the settle path — these queries distinguish by
    // *absence* of GREATEST and by a standalone `balance_usd = ?`
    // target. Kept narrow so the existing settle handlers above still
    // match their own queries.

    if (query.includes("SELECT id, amount_usd") && query.includes("FROM billing_exceptions") && query.includes("FOR UPDATE")) {
      const rows = state.billingExceptions
        .map((r, idx) => ({ ...r, __idx: idx }))
        .filter((r) => r.kind === "unrecovered_cost" && r.resolved_at === null && r.amount_usd > 0);
      return rows.map((r) => ({ id: r.__idx + 1, amount_usd: r.amount_usd }));
    }

    if (query.includes("SELECT balance_usd") && !query.includes("reserved_usd") && query.includes("FROM org_credit_balance") && query.includes("FOR UPDATE")) {
      return [{ balance_usd: state.balance }];
    }

    if (query.includes("UPDATE billing_exceptions") && query.includes("SET amount_usd = 0") && query.includes("resolved_at = now()")) {
      const id = Number(values[0]);
      const row = state.billingExceptions[id - 1];
      if (row) {
        row.amount_usd = 0;
        row.resolved_at = new Date().toISOString();
      }
      return [];
    }

    if (query.includes("UPDATE billing_exceptions") && query.includes("SET amount_usd = amount_usd -")) {
      const applied = Number(values[0]);
      const id = Number(values[1]);
      const row = state.billingExceptions[id - 1];
      if (row) {
        row.amount_usd = Math.max(0, row.amount_usd - applied);
      }
      return [];
    }

    if (query.includes("UPDATE org_credit_balance") && query.includes("SET balance_usd = ?") && query.includes("lifetime_consumed_usd = lifetime_consumed_usd +") && !query.includes("GREATEST")) {
      state.balance = Number(values[0]);
      return [];
    }

    // ── addCredits handlers ──
    // `INSERT INTO org_credit_balance ... ON CONFLICT DO UPDATE SET balance_usd = ... + X`
    // Both the `last_purchase_at` variant and the fallback variant are
    // covered by the same substring check since both use the same
    // `INSERT INTO org_credit_balance ... ON CONFLICT (org_id) DO UPDATE`
    // shape. We treat it as an ADD to the existing balance.
    if (query.includes("INSERT INTO org_credit_balance") && query.includes("ON CONFLICT (org_id) DO UPDATE") && query.includes("balance_usd + ?")) {
      const amount = Number(values[1]); // VALUES ($orgId, $amount, $amount, ...)
      state.balance += amount;
      return [];
    }

    // Post-upsert balance read — no FOR UPDATE, no reserved_usd. Matches
    // `SELECT balance_usd FROM org_credit_balance WHERE org_id = ${orgId}`
    // called by addCredits between the upsert and the audit-row INSERT.
    if (query.includes("SELECT balance_usd FROM org_credit_balance") && !query.includes("reserved_usd") && !query.includes("FOR UPDATE")) {
      return [{ balance_usd: state.balance }];
    }

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

  // ══════════════════════════════════════════════════════════════════
  // Code-review follow-up gaps (Commit 2 regression guards)
  // ══════════════════════════════════════════════════════════════════

  // Gap A — C2 follow-up: debt gate must BLOCK new reservations
  // when unresolved debt exists, not just CREATE debt on overflow.
  // Without this test, a refactor that accidentally skips the debt
  // check in reserveCreditHold would silently pass CI — the existing
  // C2 test only verifies debt CREATION, not the GATE firing.
  it("C2 gate: reserveCreditHold blocks new holds when unresolved debt exists", async () => {
    const { state, sql } = createBillingSqlState(0.8);
    const first = await reserveCreditHold(sql as any, "org-1", "s-debt-1", 0.5, 600, { agentName: "a" });
    expect(first.success).toBe(true);
    // Overspend to create debt (same shape as C2)
    const settled = await settleCreditHold(sql as any, "org-1", (first as any).hold_id, 1.5, "run", "a", "s-debt-1");
    expect(settled.success).toBe(true);
    expect(settled.debt_created).toBe(true);
    expect(state.billingExceptions.some((r) => r.kind === "unrecovered_cost" && r.resolved_at === null)).toBe(true);

    // The gate: next reserve should be blocked with debt_pending.
    const blocked = await reserveCreditHold(sql as any, "org-1", "s-debt-2", 0.5, 600, { agentName: "a" });
    expect(blocked.success).toBe(false);
    expect((blocked as any).reason).toBe("debt_pending");
    expect((blocked as any).debt_amount_usd).toBeCloseTo(0.7, 6);
    // Balance and reserved must be untouched — the gate fires before
    // the balance CAS runs.
    expect(state.balance).toBeCloseTo(0, 6);
    expect(state.reserved).toBeCloseTo(0, 6);
  });

  // Gap B — collectOutstandingCreditDebt auto-resolves debt on top-up.
  // This exercises the addCredits → collectOutstandingCreditDebt wiring
  // that makes the debt gate self-clear after a customer tops up.
  // Without this test, the "top-up unblocks the gate" contract can
  // silently break on refactor.
  it("C2 collect: collectOutstandingCreditDebt resolves debt and unblocks the gate", async () => {
    const { state, sql } = createBillingSqlState(1.0);
    // Seed unresolved debt directly — simulates a previous overflow run
    // whose customer is now topping up.
    state.billingExceptions.push({
      org_id: "org-1",
      session_id: "s-prior",
      hold_id: "h-prior",
      kind: "unrecovered_cost",
      amount_usd: 0.6,
      resolved_at: null,
    });

    const result = await collectOutstandingCreditDebt(sql as any, "org-1");
    expect(result.collected_usd).toBeCloseTo(0.6, 6);
    expect(result.remaining_usd).toBeCloseTo(0, 6);
    expect(state.balance).toBeCloseTo(0.4, 6);
    // Debt row now resolved
    expect(state.billingExceptions[0].resolved_at).not.toBeNull();
    expect(state.billingExceptions[0].amount_usd).toBeCloseTo(0, 6);

    // Gate is clear — next reserve must succeed
    const hold = await reserveCreditHold(sql as any, "org-1", "s-post-collect", 0.3, 600, { agentName: "a" });
    expect(hold.success).toBe(true);
    expect(state.balance).toBeCloseTo(0.1, 6);
  });

  // Gap C (part 1) — C3 contract: releaseCreditHold must THROW when
  // the balance row is missing (not silently succeed). The C3 commit
  // made this throw intentional; this test pins the behavior so a
  // refactor replacing `throw` with `return` would fail CI.
  it("C3 contract: releaseCreditHold throws when balance row is missing", async () => {
    const sqlFn = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");
      // Return an active hold from the initial SELECT...
      if (query.includes("FROM credit_holds") && query.includes("FOR UPDATE")) {
        return [{ hold_id: "h-missing-bal", hold_amount_usd: 0.5, status: "active" }];
      }
      // ...but return empty from the balance UPDATE, simulating an org
      // with a hold but no org_credit_balance row (data integrity issue).
      if (query.includes("UPDATE org_credit_balance") && query.includes("RETURNING org_id")) {
        return [];
      }
      return [];
    }) as unknown as MockSqlFn;
    Object.assign(sqlFn, { unsafe: async () => [], begin: async (fn: any) => fn(sqlFn) });

    await expect(releaseCreditHold(sqlFn as any, "org-1", "h-missing-bal", "crash"))
      .rejects.toThrow(/missing balance row/);
  });

  // Gap C (part 2) — C3 contract: releaseCreditHold must THROW when
  // the hold was raced to non-active between the initial SELECT and
  // the final UPDATE (the orphaned-state window). Without this test,
  // the fail-loud signal at credits.ts:308 could silently break.
  it("C3 contract: releaseCreditHold throws when hold was raced to non-active", async () => {
    let phase = "initial";
    const sqlFn = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("FROM credit_holds") && query.includes("FOR UPDATE") && phase === "initial") {
        phase = "post-select";
        return [{ hold_id: "h-raced", hold_amount_usd: 0.5, status: "active" }];
      }
      if (query.includes("UPDATE org_credit_balance") && query.includes("RETURNING org_id")) {
        return [{ org_id: "org-1" }];
      }
      if (query.includes("UPDATE credit_holds") && query.includes("AND status = 'active'") && query.includes("RETURNING hold_id")) {
        // Simulate the race: hold flipped to non-active between SELECT
        // and the update. 0 rows → throws.
        return [];
      }
      return [];
    }) as unknown as MockSqlFn;
    Object.assign(sqlFn, { unsafe: async () => [], begin: async (fn: any) => fn(sqlFn) });

    await expect(releaseCreditHold(sqlFn as any, "org-1", "h-raced", "crash"))
      .rejects.toThrow(/hold h-raced was not active/);
  });

  // Bug 2 sequential-shape smoke test (NOT a full regression guard).
  //
  // ⚠ Honesty note from the 3rd-pass code review: this test cannot
  // actually catch a regression where settle gets rolled back by an
  // outer-txn abort, because the test double models `state` as a plain
  // JS object with zero transaction isolation. A refactor that reverts
  // the Bug 2 fix (moving settle back after the UPDATE within the
  // outer admin txn) would still pass this test — the reviewer traced
  // through three hypothetical refactors and found only "remove settle
  // entirely" is caught.
  //
  // What this test DOES verify: the happy-path ordering — settle
  // returns successfully, balance/reserved reflect the charge, hold
  // status is 'settled' — so a refactor that accidentally skips settle
  // or returns the wrong cost would fail.
  //
  // The real Bug 2 regression guard lives in
  // `test/queue-consumer-terminal-writes.test.ts`, which verifies the
  // primitive that the fix relies on: `withOrgDb` and `withAdminDb`
  // route to distinct sql handles, so an abort on one cannot affect
  // a committed write on the other.
  it("Bug 2 sequential-shape smoke test: settle returns correct state regardless of downstream ops", async () => {
    const { state, sql } = createBillingSqlState(5);
    const taskSessionId = "batch-b1-task-42";

    // 1. Reserve (simulating the per-task hold)
    const hold = await reserveCreditHold(sql as any, "org-1", taskSessionId, 0.5, 600, { agentName: "batch-agent" });
    expect(hold.success).toBe(true);
    expect(state.balance).toBeCloseTo(4.5, 6);
    expect(state.reserved).toBeCloseTo(0.5, 6);

    // 2. Simulated runtime returns a cost
    const runtimeCost = 0.3;

    // 3. Settle FIRST, in its own transaction — this is the new
    //    behavior introduced by the Bug 2 fix. After this call,
    //    the charge is committed to state regardless of whatever
    //    happens next.
    const settled = await settleCreditHold(
      sql as any,
      "org-1",
      (hold as any).hold_id,
      runtimeCost,
      "Batch run: batch-agent",
      "batch-agent",
      "rt-session-42",
    );
    expect(settled.success).toBe(true);
    expect(settled.charged_usd).toBeCloseTo(0.3, 6);

    // 4. State AFTER settle — the key invariant. Balance reflects
    //    the charge, reserved is back to 0, hold is settled.
    const balanceAfterSettle = state.balance;
    const reservedAfterSettle = state.reserved;
    expect(balanceAfterSettle).toBeCloseTo(4.7, 6); // 4.5 + (0.5 - 0.3)
    expect(reservedAfterSettle).toBeCloseTo(0, 6);

    // 5. Simulate the batch_tasks UPDATE throwing. In the OLD flow
    //    (single outer txn), this throw would have rolled back the
    //    settle. In the NEW flow, settle is in its own txn and has
    //    already committed — nothing the outer txn does can revert
    //    the billing state below.
    const simulateBatchTasksUpdateFailure = () => {
      throw new Error("simulated Hyperdrive connection loss on batch_tasks UPDATE");
    };
    try {
      simulateBatchTasksUpdateFailure();
    } catch {
      // Swallow — we only care that state survives.
    }

    // 6. Verify the billing state is untouched by the simulated failure.
    expect(state.balance).toBeCloseTo(balanceAfterSettle, 6);
    expect(state.reserved).toBeCloseTo(reservedAfterSettle, 6);
    // And the hold is recorded as settled, not active.
    const holdRow = state.holds.get((hold as any).hold_id);
    expect(holdRow?.status).toBe("settled");
    expect(holdRow?.actual_cost_usd).toBeCloseTo(0.3, 6);
  });

  // Gap B wiring — closes the addCredits → collectOutstandingCreditDebt
  // wiring gap from the 3rd-pass code review. The earlier Gap B test
  // called `collectOutstandingCreditDebt` directly, which verified the
  // function's behavior but NOT the wiring at credits.ts:511 where
  // `addCredits` invokes it. A refactor that removes that line would
  // still pass the direct test. This test exercises the full top-up
  // flow: create debt, call `addCredits`, verify the debt is resolved
  // AND a subsequent `reserveCreditHold` succeeds (gate cleared).
  it("Gap B wiring: addCredits auto-collects outstanding debt and unblocks the reserve gate", async () => {
    const { state, sql } = createBillingSqlState(0.2);
    // Seed debt directly — simulates a prior unrecovered-cost overflow.
    state.billingExceptions.push({
      org_id: "org-1",
      session_id: "s-prior",
      hold_id: "h-prior",
      kind: "unrecovered_cost",
      amount_usd: 0.5,
      resolved_at: null,
    });

    // Gate should be CLOSED at this point — any reserve attempt blocked.
    const preTopupReserve = await reserveCreditHold(sql as any, "org-1", "s-pre", 0.3, 600, { agentName: "a" });
    expect(preTopupReserve.success).toBe(false);
    expect((preTopupReserve as any).reason).toBe("debt_pending");

    // Top up via addCredits. The important bit: addCredits must call
    // collectOutstandingCreditDebt as part of its flow, NOT just add
    // the balance. We start with balance=$0.20 + debt=$0.50; after
    // top-up of $1.00, balance goes to $1.20, and debt-collection
    // should consume $0.50 of it, leaving balance=$0.70 and debt
    // resolved.
    const addResult = await addCredits(sql as any, "org-1", 1.0, "test top-up", "ref-1", "test");
    // balance_after_usd is the balance AFTER the upsert but BEFORE
    // debt collection. That's $0.20 + $1.00 = $1.20.
    expect(addResult.balance_after_usd).toBeCloseTo(1.2, 6);
    // State balance reflects the post-collection value.
    expect(state.balance).toBeCloseTo(0.7, 6); // 1.20 - 0.50 (debt collected)
    // Debt row is resolved.
    expect(state.billingExceptions[0].resolved_at).not.toBeNull();
    expect(state.billingExceptions[0].amount_usd).toBeCloseTo(0, 6);

    // Gate should now be OPEN — subsequent reserve succeeds.
    const postTopupReserve = await reserveCreditHold(sql as any, "org-1", "s-post", 0.3, 600, { agentName: "a" });
    expect(postTopupReserve.success).toBe(true);
    expect(state.balance).toBeCloseTo(0.4, 6); // 0.70 - 0.30 reserved
  });
});
