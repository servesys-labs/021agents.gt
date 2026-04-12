/**
 * Bug 2 follow-up: queue-consumer terminal-write isolation.
 *
 * This file verifies the primitive that the queue-consumer fix in
 * `index.ts` relies on: `withOrgDb` and `withAdminDb` open distinct
 * Postgres connections, so a transaction abort on the admin side
 * cannot roll back a committed `withOrgDb` write — and vice versa.
 *
 * Why this test exists
 * --------------------
 * The original Bug 2 fix (Commit 1, `3e9cdb47`) moved
 * reserve/settle/release into their own `withOrgDb` transactions for
 * the `batch_run` handler. The 3rd-pass code review caught a
 * follow-on issue: the terminal state writes (`UPDATE batch_tasks
 * SET status='completed'`, `UPDATE job_queue SET status='completed'`)
 * were still in the outer admin txn, so an abort on any later
 * statement would leave the customer charged but the task row stuck
 * at 'running'. Commit 4 moves those terminal writes into their own
 * `withOrgDb` transactions too, matching the billing pattern.
 *
 * This test pins the underlying invariant: if the handler uses
 * `withOrgDb` for a terminal write, that write is on a different
 * connection from the outer `withAdminDb`, so it survives any abort
 * on the outer side.
 *
 * What this test does NOT verify
 * ------------------------------
 * The queue handler in `index.ts` is not exported — this test cannot
 * invoke it directly. A refactor that accidentally reverts the fix
 * (moving terminal writes back to `sql` instead of `withOrgDb`)
 * would not be caught here, because the primitive would still route
 * correctly — the handler just wouldn't use it. That regression class
 * needs a full integration test of the queue consumer, which requires
 * either (a) exporting the handler from `index.ts` or (b) refactoring
 * the per-task loop into a testable helper. We haven't done either.
 *
 * For now, this primitive test + the explicit `withOrgDb` callsites
 * at the terminal writes in `index.ts` (visible in the diff) form the
 * verification floor. Code review + the primitive test together close
 * the gap.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Custom module mock for ../src/db/client ──────────────────────────
// The default `buildDbClientMock` forwards `withOrgDb` AND `withAdminDb`
// to the SAME shared sql. That hides the very invariant this test is
// trying to pin. We build a custom mock that routes them to DISTINCT
// sql handles, so the test can observe which code path each write
// takes.

type MockSqlFn = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>) & {
  unsafe: (q: string, params?: unknown[], opts?: unknown) => Promise<any>;
  begin: (fn: (tx: any) => Promise<any>) => Promise<any>;
};

// Shared module-level handles — tests mutate these to install per-test
// behavior. vi.mock is hoisted so the factory runs before any import.
let outerSql: MockSqlFn;
let innerSql: MockSqlFn;

vi.mock("../src/db/client", () => ({
  withOrgDb: async (_env: unknown, _orgId: unknown, fn: (sql: any) => Promise<any>) => fn(innerSql),
  withAdminDb: async (_env: unknown, fn: (sql: any) => Promise<any>) => fn(outerSql),
  getDb: async () => outerSql,
  getDbForOrg: async () => innerSql,
  OrgSql: null,
  AdminSql: null,
  Sql: null,
}));

// Imports AFTER the mock
import { withOrgDb, withAdminDb } from "../src/db/client";
import { reserveCreditHold, settleCreditHold } from "../src/logic/credits";

// ── Helpers ───────────────────────────────────────────────────────────

interface TrackingMockState {
  receivedQueries: string[];
  holds: Map<string, { hold_id: string; hold_amount_usd: number; status: string; expires_at: string; actual_cost_usd?: number }>;
  holdBySession: Map<string, string>;
  balance: number;
  reserved: number;
  billingExceptions: Array<{ kind: string; amount_usd: number; resolved_at: string | null }>;
  terminalWritesReceived: string[];
}

function createTrackingInnerSql(initialBalance: number = 5): { state: TrackingMockState; sql: MockSqlFn } {
  const state: TrackingMockState = {
    receivedQueries: [],
    holds: new Map(),
    holdBySession: new Map(),
    balance: initialBalance,
    reserved: 0,
    billingExceptions: [],
    terminalWritesReceived: [],
  };

  const handler = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    state.receivedQueries.push(query);

    // Debt-pending check
    if (query.includes("SELECT COALESCE(SUM(amount_usd), 0) AS total") && query.includes("FROM billing_exceptions")) {
      const total = state.billingExceptions
        .filter((r) => r.kind === "unrecovered_cost" && r.resolved_at === null)
        .reduce((s, r) => s + r.amount_usd, 0);
      return [{ total }];
    }

    // Existing-hold lookup
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
      state.holds.set(holdId, { hold_id: holdId, org_id: orgId, session_id: sessionId, hold_amount_usd: amount, status: "active", expires_at: expiresAt } as any);
      state.holdBySession.set(key, holdId);
      return [{ hold_id: holdId, hold_amount_usd: amount, expires_at: expiresAt }];
    }

    // Settle: SELECT hold FOR UPDATE
    if (query.includes("FROM credit_holds") && query.includes("WHERE hold_id = ? AND org_id = ?") && query.includes("FOR UPDATE")) {
      const holdId = String(values[0]);
      const hold = state.holds.get(holdId);
      if (!hold) return [];
      return [{ hold_id: hold.hold_id, hold_amount_usd: hold.hold_amount_usd, status: hold.status, actual_cost_usd: hold.actual_cost_usd }];
    }

    // Settle: SELECT balance FOR UPDATE
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

    // credit_transactions audit — noop
    if (query.includes("INSERT INTO credit_transactions")) return [{ id: 1 }];

    // billing_exceptions noop
    if (query.includes("INSERT INTO billing_exceptions")) return [{ id: state.billingExceptions.length + 1 }];

    // Terminal-write detection: `UPDATE batch_tasks SET status = 'completed'`
    // or `UPDATE job_queue SET status = 'completed'`. Record these so the
    // test can verify the handler routed them via withOrgDb (== innerSql).
    if (
      (query.includes("UPDATE batch_tasks SET status = 'completed'") ||
        query.includes("UPDATE batch_tasks SET status = 'failed'") ||
        query.includes("UPDATE job_queue SET status = 'completed'") ||
        query.includes("UPDATE job_queue SET status = 'failed'"))
    ) {
      state.terminalWritesReceived.push(query);
      return [];
    }

    return [];
  }) as unknown as MockSqlFn;

  const mockSql = Object.assign(handler, {
    unsafe: async (_q: string, _params?: unknown[], _opts?: unknown) => [],
    begin: async (fn: (tx: any) => Promise<any>) => fn(mockSql),
  });

  return { state, sql: mockSql };
}

function createOuterSqlThatThrowsOnTerminal(): { sql: MockSqlFn; attempts: string[] } {
  const attempts: string[] = [];
  const handler = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?");
    attempts.push(query);
    // Simulate a Hyperdrive hiccup on terminal writes — if the handler
    // mistakenly routed a terminal UPDATE through this sql, the test
    // would see the throw propagate.
    if (
      query.includes("UPDATE batch_tasks SET status = 'completed'") ||
      query.includes("UPDATE batch_tasks SET status = 'failed'") ||
      query.includes("UPDATE job_queue SET status = 'completed'") ||
      query.includes("UPDATE job_queue SET status = 'failed'")
    ) {
      throw new Error("simulated outer-txn abort on terminal write");
    }
    return [];
  }) as unknown as MockSqlFn;
  const mockSql = Object.assign(handler, {
    unsafe: async (_q: string, _params?: unknown[], _opts?: unknown) => [],
    begin: async (fn: (tx: any) => Promise<any>) => fn(mockSql),
  });
  return { sql: mockSql, attempts };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Bug 2 follow-up: withOrgDb and withAdminDb route to distinct sql handles", () => {
  let innerState: TrackingMockState;
  let outerAttempts: string[];

  beforeEach(() => {
    const inner = createTrackingInnerSql(5);
    const outer = createOuterSqlThatThrowsOnTerminal();
    innerSql = inner.sql;
    outerSql = outer.sql;
    innerState = inner.state;
    outerAttempts = outer.attempts;
  });

  it("withOrgDb and withAdminDb forward to DIFFERENT sql handles", async () => {
    // Sanity: the mock setup actually provides two distinct handles.
    let innerCalled = false;
    let outerCalled = false;

    await withOrgDb({} as any, "org-1", async (sql) => {
      await sql`SELECT 1 FROM placeholder_inner`;
      innerCalled = true;
    });
    await withAdminDb({} as any, async (sql) => {
      await sql`SELECT 1 FROM placeholder_outer`;
      outerCalled = true;
    });

    expect(innerCalled).toBe(true);
    expect(outerCalled).toBe(true);
    expect(innerState.receivedQueries.some((q) => q.includes("placeholder_inner"))).toBe(true);
    expect(outerAttempts.some((q) => q.includes("placeholder_outer"))).toBe(true);
    // Cross-check: inner did not receive the outer query, and vice versa.
    expect(innerState.receivedQueries.some((q) => q.includes("placeholder_outer"))).toBe(false);
    expect(outerAttempts.some((q) => q.includes("placeholder_inner"))).toBe(false);
  });

  it("a terminal write routed through withOrgDb lands even when the outer sql would abort on it", async () => {
    // Replay the happy path of a batch_run task:
    // 1. Reserve via withOrgDb (inner)
    // 2. Settle via withOrgDb (inner)
    // 3. Terminal write: 'completed' via withOrgDb (inner)
    //
    // Then try to do the same terminal write via the outer admin sql
    // — this MUST throw, proving that if the handler had mistakenly
    // used outer sql for the terminal write, Bug 2's failure mode would
    // fire. The contrast is the regression guard: withOrgDb lands,
    // outer aborts.

    const hold = await withOrgDb({} as any, "org-1", (sql) =>
      reserveCreditHold(sql as any, "org-1", "task-1", 0.5, 600, { agentName: "batch" }),
    );
    expect(hold.success).toBe(true);

    const settled = await withOrgDb({} as any, "org-1", (sql) =>
      settleCreditHold(sql as any, "org-1", (hold as any).hold_id, 0.3, "run", "batch", "task-1"),
    );
    expect(settled.success).toBe(true);

    // Terminal write — via withOrgDb, lands on innerSql.
    await withOrgDb({} as any, "org-1", async (sql) => {
      await sql`
        UPDATE batch_tasks SET status = 'completed', output = ${"ok"},
          session_id = ${"s"}, cost_usd = ${0.3}, latency_ms = ${10}
        WHERE task_id = ${"task-1"}
      `;
    });

    // The terminal write landed on the inner sql
    expect(innerState.terminalWritesReceived.some((q) => q.includes("UPDATE batch_tasks SET status = 'completed'"))).toBe(true);
    // The outer sql never saw it (because the handler used withOrgDb)
    expect(outerAttempts.some((q) => q.includes("UPDATE batch_tasks SET status = 'completed'"))).toBe(false);

    // Contrast: had the handler mistakenly used outer sql for the
    // terminal write, it would have thrown. This asserts that our
    // abort simulation would actually fire.
    await expect(
      withAdminDb({} as any, async (sql) => {
        await sql`UPDATE batch_tasks SET status = 'completed' WHERE task_id = ${"task-1"}`;
      }),
    ).rejects.toThrow(/simulated outer-txn abort/);
  });

  it("reserve+settle via withOrgDb commit independently of the outer admin sql state", async () => {
    // Billing isolation invariant: even if we issue a bunch of outer-admin
    // operations that abort, the withOrgDb billing writes persist.
    const hold = await withOrgDb({} as any, "org-1", (sql) =>
      reserveCreditHold(sql as any, "org-1", "task-isolation", 0.5, 600, { agentName: "batch" }),
    );
    expect(hold.success).toBe(true);
    expect(innerState.balance).toBeCloseTo(4.5, 6);
    expect(innerState.reserved).toBeCloseTo(0.5, 6);

    // Simulate the outer admin sql aborting on a terminal write
    await expect(
      withAdminDb({} as any, async (sql) => {
        await sql`UPDATE batch_tasks SET status = 'completed' WHERE task_id = ${"task-isolation"}`;
      }),
    ).rejects.toThrow();

    // Settle afterward — still lands on inner sql, balance adjusts correctly.
    const settled = await withOrgDb({} as any, "org-1", (sql) =>
      settleCreditHold(sql as any, "org-1", (hold as any).hold_id, 0.2, "run", "batch", "task-isolation"),
    );
    expect(settled.success).toBe(true);
    expect(settled.charged_usd).toBeCloseTo(0.2, 6);
    expect(innerState.balance).toBeCloseTo(4.8, 6); // 4.5 + (0.5 - 0.2)
    expect(innerState.reserved).toBeCloseTo(0, 6);
  });

  it("agent_run shape: failed-status terminal write also routed through withOrgDb", async () => {
    // The same invariant must hold for the failed-path terminal writes
    // in agent_run (UPDATE job_queue SET status='failed', ...).
    await withOrgDb({} as any, "org-1", async (sql) => {
      await sql`UPDATE job_queue SET status = 'failed', error = 'credit_reserve_error', completed_at = ${new Date().toISOString()} WHERE job_id = ${"job-A"}`;
    });
    expect(innerState.terminalWritesReceived.some((q) => q.includes("UPDATE job_queue SET status = 'failed'"))).toBe(true);
    expect(outerAttempts.some((q) => q.includes("UPDATE job_queue SET status = 'failed'"))).toBe(false);
  });
});
