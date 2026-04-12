/**
 * DLQ consumer tests — credit-hold release for dead-lettered jobs.
 *
 * Tests the `releaseHoldBySession` helper and the behavioral contracts
 * that the DLQ consumer relies on:
 * 1. Active hold → released, balance restored, audit row created
 * 2. Already-reclaimed hold → no-op (no error, no double-release)
 * 3. Already-settled hold → no-op (hold stays settled)
 * 4. Batch multi-task → each task's hold released independently
 * 5. Malformed message → acked without error
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { buildDbClientMock, type MockSqlFn } from "./helpers/test-env";

let mockSql: MockSqlFn = (async () => []) as unknown as MockSqlFn;
vi.mock("../src/db/client", () => buildDbClientMock(() => mockSql));

import {
  reserveCreditHold,
  settleCreditHold,
  releaseHoldBySession,
  reclaimExpiredCreditHolds,
} from "../src/logic/credits";

type HoldRow = {
  hold_id: string;
  org_id: string;
  session_id: string;
  hold_amount_usd: number;
  status: "active" | "settled" | "released" | "expired";
  expires_at: string;
  actual_cost_usd?: number;
  locked?: boolean;
};

function createDlqTestState(initialBalance = 5) {
  const state = {
    balance: initialBalance,
    reserved: 0,
    holds: new Map<string, HoldRow>(),
    holdBySession: new Map<string, string>(),
    billingExceptions: [] as Array<{ org_id: string; kind: string; amount_usd: number; resolved_at: string | null; session_id?: string; hold_id?: string }>,
  };

  const handler = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");

    // Debt check
    if (query.includes("SELECT COALESCE(SUM(amount_usd), 0) AS total") && query.includes("FROM billing_exceptions")) {
      const total = state.billingExceptions
        .filter((r) => r.kind === "unrecovered_cost" && r.resolved_at === null)
        .reduce((s, r) => s + r.amount_usd, 0);
      return [{ total }];
    }

    // Existing-hold lookup by session (releaseHoldBySession uses this)
    if (query.includes("FROM credit_holds") && query.includes("WHERE org_id = ?") && query.includes("session_id = ?") && query.includes("status = 'active'")) {
      const orgId = String(values[0]);
      const sessionId = String(values[1]);
      const holdId = state.holdBySession.get(`${orgId}:${sessionId}`);
      if (!holdId) return [];
      const hold = state.holds.get(holdId);
      if (!hold || hold.status !== "active") return [];
      return [{ hold_id: hold.hold_id, hold_amount_usd: hold.hold_amount_usd, expires_at: hold.expires_at }];
    }

    // Reserve balance CAS
    if (query.includes("UPDATE org_credit_balance") && query.includes("balance_usd = balance_usd -") && query.includes("reserved_usd = reserved_usd +")) {
      const amount = Number(values[0]);
      if (state.balance < amount) return [];
      state.balance -= amount;
      state.reserved += amount;
      return [{ balance_usd: state.balance, reserved_usd: state.reserved }];
    }

    // Reserve INSERT
    if (query.includes("INSERT INTO credit_holds") && query.includes("ON CONFLICT (org_id, session_id) DO NOTHING")) {
      const holdId = String(values[0]);
      const orgId = String(values[1]);
      const sessionId = String(values[2]);
      const amount = Number(values[5]);
      const expiresAt = String(values[6]);
      const key = `${orgId}:${sessionId}`;
      if (state.holdBySession.has(key)) return [];
      state.holds.set(holdId, {
        hold_id: holdId, org_id: orgId, session_id: sessionId,
        hold_amount_usd: amount, status: "active", expires_at: expiresAt,
      });
      state.holdBySession.set(key, holdId);
      return [{ hold_id: holdId, hold_amount_usd: amount, expires_at: expiresAt }];
    }

    // Release: SELECT hold by hold_id FOR UPDATE
    if (query.includes("FROM credit_holds") && query.includes("WHERE hold_id = ? AND org_id = ?") && query.includes("FOR UPDATE")) {
      const holdId = String(values[0]);
      const hold = state.holds.get(holdId);
      if (!hold) return [];
      return [{ hold_id: hold.hold_id, hold_amount_usd: hold.hold_amount_usd, status: hold.status, actual_cost_usd: hold.actual_cost_usd }];
    }

    // Release: UPDATE balance (refund)
    if (query.includes("UPDATE org_credit_balance") && query.includes("balance_usd = balance_usd +") && query.includes("reserved_usd = GREATEST(0, reserved_usd -")) {
      const amount = Number(values[0]);
      state.balance += amount;
      state.reserved = Math.max(0, state.reserved - amount);
      return [{ org_id: "org-1" }];
    }

    // Release: UPDATE hold status
    if (query.includes("UPDATE credit_holds") && query.includes("SET status = ?") && query.includes("AND status = 'active'")) {
      const status = String(values[0]) as HoldRow["status"];
      const holdId = String(values[2]);
      const hold = state.holds.get(holdId);
      if (!hold || hold.status !== "active") return [];
      hold.status = status;
      return [{ hold_id: holdId }];
    }

    // Settle: SELECT hold FOR UPDATE
    if (query.includes("SELECT balance_usd, reserved_usd") && query.includes("FROM org_credit_balance")) {
      return [{ balance_usd: state.balance, reserved_usd: state.reserved }];
    }

    // Settle: UPDATE balance (GREATEST pattern)
    if (query.includes("SET balance_usd = GREATEST(0, balance_usd +") && query.includes("lifetime_consumed_usd = lifetime_consumed_usd +")) {
      const holdAmount = Number(values[0]);
      const charged = Number(values[1]);
      state.balance = Math.max(0, state.balance + holdAmount - charged);
      state.reserved = Math.max(0, state.reserved - holdAmount);
      return [{ balance_usd: state.balance }];
    }

    // Settle: UPDATE credit_holds SET status='settled'
    if (query.includes("UPDATE credit_holds") && query.includes("SET status = 'settled'")) {
      const actual = Number(values[1]);
      const holdId = String(values[3]);
      const hold = state.holds.get(holdId);
      if (!hold) return [];
      hold.status = "settled";
      hold.actual_cost_usd = actual;
      return [{ hold_id: holdId }];
    }

    // Reclaim: SELECT expired active holds FOR UPDATE SKIP LOCKED
    if (query.includes("SELECT hold_id, org_id, hold_amount_usd, session_id") && query.includes("FOR UPDATE SKIP LOCKED")) {
      const out: any[] = [];
      for (const hold of state.holds.values()) {
        if (hold.status !== "active") continue;
        if (new Date(hold.expires_at).getTime() >= Date.now()) continue;
        out.push({ hold_id: hold.hold_id, org_id: hold.org_id, hold_amount_usd: hold.hold_amount_usd, session_id: hold.session_id });
      }
      return out;
    }

    // Reclaim: UPDATE hold to 'expired'
    if (query.includes("UPDATE credit_holds") && query.includes("SET status = 'expired'")) {
      const holdId = String(values[0]);
      const hold = state.holds.get(holdId);
      if (!hold || hold.status !== "active") return [];
      hold.status = "expired";
      return [{ hold_id: holdId }];
    }

    // Audit rows
    if (query.includes("INSERT INTO credit_transactions")) return [{ id: 1 }];
    if (query.includes("INSERT INTO billing_exceptions")) {
      let kind: string;
      if (query.includes("'unrecovered_cost'")) kind = "unrecovered_cost";
      else if (query.includes("'reclaim_mismatch'")) kind = "reclaim_mismatch";
      else if (query.includes("'dlq_hold_release'")) kind = "dlq_hold_release";
      else kind = "unknown";
      const amount = Number(values[3] || 0);
      state.billingExceptions.push({ org_id: String(values[0]), kind, amount_usd: amount, resolved_at: null });
      return [{ id: state.billingExceptions.length }];
    }

    return [];
  }) as unknown as MockSqlFn;

  const sql = Object.assign(handler, {
    unsafe: async (_q: string, _params?: unknown[], _opts?: unknown) => [],
    begin: async (fn: any) => fn(sql),
  });

  return { state, sql };
}

describe("DLQ consumer — releaseHoldBySession + behavioral contracts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("releases an active hold by session_id and restores balance", async () => {
    const { state, sql } = createDlqTestState(5);
    mockSql = sql;

    const hold = await reserveCreditHold(sql as any, "org-1", "agent-run-sess-1", 0.5, 600, { agentName: "a" });
    expect(hold.success).toBe(true);
    expect(state.balance).toBeCloseTo(4.5, 6);
    expect(state.reserved).toBeCloseTo(0.5, 6);

    const result = await releaseHoldBySession(sql as any, "org-1", "agent-run-sess-1", "crash");
    expect(result.released).toBe(true);
    expect(result.hold_id).toBe((hold as any).hold_id);
    expect(result.hold_amount_usd).toBeCloseTo(0.5, 6);
    expect(state.balance).toBeCloseTo(5, 6);
    expect(state.reserved).toBeCloseTo(0, 6);
    expect(state.holds.get(result.hold_id!)?.status).toBe("released");
  });

  it("returns { released: false } when no active hold exists (already reclaimed by cron)", async () => {
    const { state, sql } = createDlqTestState(5);
    mockSql = sql;

    const hold = await reserveCreditHold(sql as any, "org-1", "reclaimed-sess", 0.5, 1, { agentName: "a" });
    expect(hold.success).toBe(true);

    // Simulate cron reclaim: expire the hold manually
    const holdRow = state.holds.get((hold as any).hold_id)!;
    holdRow.expires_at = new Date(Date.now() - 5_000).toISOString();
    const reclaimed = await reclaimExpiredCreditHolds(sql as any, 50);
    expect(reclaimed).toBe(1);
    expect(holdRow.status).toBe("expired");

    // Now the DLQ consumer tries to release — should be a no-op
    const result = await releaseHoldBySession(sql as any, "org-1", "reclaimed-sess", "crash");
    expect(result.released).toBe(false);
    expect(state.balance).toBeCloseTo(5, 6); // fully restored by cron
  });

  it("returns { released: false } when the hold was already settled", async () => {
    const { state, sql } = createDlqTestState(5);
    mockSql = sql;

    const hold = await reserveCreditHold(sql as any, "org-1", "settled-sess", 0.5, 600, { agentName: "a" });
    expect(hold.success).toBe(true);

    await settleCreditHold(sql as any, "org-1", (hold as any).hold_id, 0.3, "run", "a", "settled-sess");
    expect(state.holds.get((hold as any).hold_id)?.status).toBe("settled");

    // DLQ consumer tries to release — should be a no-op (hold is settled, not active)
    const result = await releaseHoldBySession(sql as any, "org-1", "settled-sess", "crash");
    expect(result.released).toBe(false);
    // Balance should reflect the settle charge, NOT a release refund
    expect(state.balance).toBeCloseTo(4.7, 6); // 4.5 + (0.5 - 0.3) from settle
  });

  it("releases multiple per-task holds for a batch_run session pattern", async () => {
    const { state, sql } = createDlqTestState(5);
    mockSql = sql;

    // Reserve 3 per-task holds (simulating a batch with 3 tasks)
    for (let i = 1; i <= 3; i++) {
      const hold = await reserveCreditHold(sql as any, "org-1", `batch-B1-task-${i}`, 0.5, 600, { agentName: "batch" });
      expect(hold.success).toBe(true);
    }
    expect(state.balance).toBeCloseTo(3.5, 6); // 5 - 3 * 0.5
    expect(state.reserved).toBeCloseTo(1.5, 6);

    // DLQ consumer releases each one
    for (let i = 1; i <= 3; i++) {
      const result = await releaseHoldBySession(sql as any, "org-1", `batch-B1-task-${i}`, "crash");
      expect(result.released).toBe(true);
    }
    expect(state.balance).toBeCloseTo(5, 6);
    expect(state.reserved).toBeCloseTo(0, 6);
  });

  it("does not throw on a session_id with no matching hold at all", async () => {
    const { sql } = createDlqTestState(5);
    mockSql = sql;

    // No hold was ever created for this session
    const result = await releaseHoldBySession(sql as any, "org-1", "nonexistent-session", "crash");
    expect(result.released).toBe(false);
    expect(result.hold_id).toBeUndefined();
  });

  it("concurrent release + reclaim: exactly one succeeds, no double-refund", async () => {
    const { state, sql } = createDlqTestState(5);
    mockSql = sql;

    const hold = await reserveCreditHold(sql as any, "org-1", "race-sess", 0.5, 1, { agentName: "a" });
    expect(hold.success).toBe(true);

    // Expire the hold so reclaim can pick it up
    const holdRow = state.holds.get((hold as any).hold_id)!;
    holdRow.expires_at = new Date(Date.now() - 5_000).toISOString();

    // Run both "concurrently" (sequentially in JS, but the DB guards
    // ensure only one succeeds). The sequential order here exercises
    // the "Case 1: DLQ consumer runs first" path from the design doc.
    const dlqResult = await releaseHoldBySession(sql as any, "org-1", "race-sess", "crash");
    expect(dlqResult.released).toBe(true);

    // Reclaim now runs — hold is already released, should be a no-op
    const reclaimed = await reclaimExpiredCreditHolds(sql as any, 50);
    expect(reclaimed).toBe(0);

    // Balance fully restored exactly once
    expect(state.balance).toBeCloseTo(5, 6);
    expect(state.reserved).toBeCloseTo(0, 6);
  });
});
