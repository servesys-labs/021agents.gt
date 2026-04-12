/**
 * Credit system logic — atomic balance operations with audit trail.
 *
 * All values are in USD with 6 decimal places (numeric(20,6) in Postgres).
 * No rounding, no minimums — exact cost tracking down to $0.000001.
 *
 * All mutations use atomic SQL (UPDATE ... SET balance = balance +/- X)
 * to prevent race conditions. Every mutation writes an immutable
 * credit_transactions row for audit.
 */
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

export const DEFAULT_CREDIT_HOLD_USD = 0.5;
export const DEFAULT_CREDIT_HOLD_TTL_SECONDS = 600;

type CreditHoldFailureReason = "insufficient" | "db_error";

type ReserveCreditHoldResult =
  | { success: true; hold_id: string; hold_amount_usd: number; expires_at: string }
  | { success: false; reason: CreditHoldFailureReason }
  | { success: false; reason: "debt_pending"; debt_amount_usd: number };

type SettleCreditHoldResult = {
  success: boolean;
  charged_usd: number;
  excess_usd: number;
  debt_created: boolean;
  balance_after_usd: number;
  exception?: string;
};

function normalizePositiveAmount(value: number | undefined, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

// ── Read ──────────────────────────────────────────────────────────

export async function getBalance(
  sql: Sql,
  orgId: string,
): Promise<{ balance_usd: number; lifetime_purchased_usd: number; lifetime_consumed_usd: number }> {
  const rows = await sql`
    SELECT balance_usd, lifetime_purchased_usd, lifetime_consumed_usd
    FROM org_credit_balance
    WHERE org_id = ${orgId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return { balance_usd: 0, lifetime_purchased_usd: 0, lifetime_consumed_usd: 0 };
  }
  const r = rows[0];
  return {
    balance_usd: Number(r.balance_usd),
    lifetime_purchased_usd: Number(r.lifetime_purchased_usd),
    lifetime_consumed_usd: Number(r.lifetime_consumed_usd),
  };
}

export async function hasCredits(
  sql: Sql,
  orgId: string,
  requiredUsd: number = 0,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM org_credit_balance
    WHERE org_id = ${orgId} AND balance_usd >= ${requiredUsd}
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function reserveCreditHold(
  sql: Sql,
  orgId: string,
  sessionId: string,
  holdAmountUsd: number = DEFAULT_CREDIT_HOLD_USD,
  ttlSeconds?: number,
  opts: { parentHoldId?: string; agentName?: string } = {},
): Promise<ReserveCreditHoldResult> {
  const safeAmount = normalizePositiveAmount(holdAmountUsd, DEFAULT_CREDIT_HOLD_USD);
  const safeTtl = Math.max(30, Math.floor(normalizePositiveAmount(ttlSeconds, DEFAULT_CREDIT_HOLD_TTL_SECONDS)));
  const debtRows = await sql`
    SELECT COALESCE(SUM(amount_usd), 0) AS total
    FROM billing_exceptions
    WHERE org_id = ${orgId}
      AND kind = 'unrecovered_cost'
      AND resolved_at IS NULL
  `;
  const debtAmount = Number(debtRows[0]?.total || 0);
  if (debtAmount > 0) {
    return { success: false, reason: "debt_pending", debt_amount_usd: debtAmount };
  }

  const existing = await sql`
    SELECT hold_id, hold_amount_usd, expires_at
    FROM credit_holds
    WHERE org_id = ${orgId}
      AND session_id = ${sessionId}
      AND status = 'active'
    LIMIT 1
  `;
  if (existing.length > 0) {
    return {
      success: true,
      hold_id: String(existing[0].hold_id),
      hold_amount_usd: Number(existing[0].hold_amount_usd || 0),
      expires_at: new Date(existing[0].expires_at).toISOString(),
    };
  }

  const holdId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + safeTtl * 1000).toISOString();

  const updated = await sql`
    UPDATE org_credit_balance
    SET balance_usd = balance_usd - ${safeAmount},
        reserved_usd = reserved_usd + ${safeAmount},
        updated_at = now()
    WHERE org_id = ${orgId}
      AND balance_usd >= ${safeAmount}
    RETURNING balance_usd, reserved_usd
  `;

  if (updated.length === 0) {
    return { success: false, reason: "insufficient" };
  }

  const inserted = await sql`
    INSERT INTO credit_holds
      (hold_id, org_id, session_id, parent_hold_id, agent_name, hold_amount_usd, status, expires_at)
    VALUES
      (${holdId}, ${orgId}, ${sessionId}, ${opts.parentHoldId || null}, ${opts.agentName || ""}, ${safeAmount}, 'active', ${expiresAt})
    ON CONFLICT (org_id, session_id) DO NOTHING
    RETURNING hold_id, hold_amount_usd, expires_at
  `;

  if (inserted.length === 0) {
    await sql`
      UPDATE org_credit_balance
      SET balance_usd = balance_usd + ${safeAmount},
          reserved_usd = GREATEST(0, reserved_usd - ${safeAmount}),
          updated_at = now()
      WHERE org_id = ${orgId}
    `;
    const raced = await sql`
      SELECT hold_id, hold_amount_usd, expires_at
      FROM credit_holds
      WHERE org_id = ${orgId}
        AND session_id = ${sessionId}
        AND status = 'active'
      LIMIT 1
    `;
    if (raced.length > 0) {
      return {
        success: true,
        hold_id: String(raced[0].hold_id),
        hold_amount_usd: Number(raced[0].hold_amount_usd || 0),
        expires_at: new Date(raced[0].expires_at).toISOString(),
      };
    }
    return { success: false, reason: "db_error" };
  }

  return {
    success: true,
    hold_id: String(inserted[0].hold_id),
    hold_amount_usd: Number(inserted[0].hold_amount_usd || 0),
    expires_at: new Date(inserted[0].expires_at).toISOString(),
  };
}

export async function settleCreditHold(
  sql: Sql,
  orgId: string,
  holdId: string,
  actualCostUsd: number,
  description: string,
  agentName: string,
  sessionId: string,
): Promise<SettleCreditHoldResult> {
  const safeActualCost = Math.max(0, Number(actualCostUsd) || 0);
  const [hold] = await sql`
    SELECT hold_id, hold_amount_usd, status, actual_cost_usd
    FROM credit_holds
    WHERE hold_id = ${holdId} AND org_id = ${orgId}
    FOR UPDATE
  `.catch(() => []);

  if (!hold) {
    return { success: false, charged_usd: 0, excess_usd: 0, debt_created: false, balance_after_usd: 0, exception: "hold_missing" };
  }
  if (String(hold.status) !== "active") {
    return { success: true, charged_usd: Number(hold.actual_cost_usd || 0), excess_usd: 0, debt_created: false, balance_after_usd: 0, exception: "already_settled" };
  }

  const [balanceRow] = await sql`
    SELECT balance_usd, reserved_usd
    FROM org_credit_balance
    WHERE org_id = ${orgId}
    FOR UPDATE
  `.catch(() => []);

  if (!balanceRow) {
    return { success: false, charged_usd: 0, excess_usd: 0, debt_created: false, balance_after_usd: 0, exception: "balance_row_missing" };
  }

  const balanceBefore = Number(balanceRow.balance_usd || 0);
  const holdAmount = Number(hold.hold_amount_usd || 0);
  const availableToCharge = Math.max(0, balanceBefore + holdAmount);
  const chargedUsd = Math.max(0, Math.min(safeActualCost, availableToCharge));
  const excessUsd = Math.max(0, safeActualCost - chargedUsd);
  const now = new Date().toISOString();

  const updated = await sql`
    UPDATE org_credit_balance
    SET balance_usd = GREATEST(0, balance_usd + ${holdAmount} - ${chargedUsd}),
        reserved_usd = GREATEST(0, reserved_usd - ${holdAmount}),
        lifetime_consumed_usd = lifetime_consumed_usd + ${chargedUsd},
        last_deduction_at = ${now},
        updated_at = ${now}
    WHERE org_id = ${orgId}
    RETURNING balance_usd
  `.catch(() => []);

  if (!updated || updated.length === 0) {
    return { success: false, charged_usd: 0, excess_usd: excessUsd, debt_created: false, balance_after_usd: 0, exception: "balance_update_failed" };
  }

  const balanceAfter = Number(updated[0].balance_usd || 0);
  await sql`
    UPDATE credit_holds
    SET status = 'settled',
        settled_at = ${now},
        actual_cost_usd = ${safeActualCost},
        session_id = COALESCE(NULLIF(${sessionId}, ''), session_id)
    WHERE hold_id = ${holdId}
  `;

  if (chargedUsd > 0) {
    await sql`
      INSERT INTO credit_transactions
        (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, agent_name, session_id, created_at)
      VALUES
        (${orgId}, 'burn', ${-chargedUsd}, ${balanceAfter}, ${description}, ${holdId}, 'agent_run_hold_settle', ${agentName}, ${sessionId}, ${now})
    `.catch(() => {});
  }

  let debtCreated = false;
  if (excessUsd > 0) {
    debtCreated = true;
    await sql`
      INSERT INTO billing_exceptions
        (org_id, session_id, hold_id, kind, amount_usd, exception_type, expected_usd, actual_usd, charged_usd, error_message, created_at)
      VALUES
        (${orgId}, ${sessionId || null}, ${holdId}, 'unrecovered_cost', ${excessUsd}, 'hold_underrun',
         ${holdAmount}, ${safeActualCost}, ${chargedUsd}, 'Unrecovered run cost under fail-closed policy', ${now})
    `;
    console.warn(`[credit] debt created org=${orgId} hold=${holdId} excess_usd=${excessUsd.toFixed(6)}`);
  }

  return { success: true, charged_usd: chargedUsd, excess_usd: excessUsd, debt_created: debtCreated, balance_after_usd: balanceAfter };
}

export async function releaseCreditHold(
  sql: Sql,
  orgId: string,
  holdId: string,
  reason: "user_cancel" | "crash" | "expired",
): Promise<void> {
  const [hold] = await sql`
    SELECT hold_amount_usd, status
    FROM credit_holds
    WHERE hold_id = ${holdId} AND org_id = ${orgId}
    FOR UPDATE
  `.catch(() => []);

  if (!hold || String(hold.status) !== "active") return;

  const holdAmount = Number(hold.hold_amount_usd || 0);
  const releaseStatus = reason === "expired" ? "expired" : "released";
  const now = new Date().toISOString();

  const releasedBalance = await sql`
    UPDATE org_credit_balance
    SET balance_usd = balance_usd + ${holdAmount},
        reserved_usd = GREATEST(0, reserved_usd - ${holdAmount}),
        updated_at = ${now}
    WHERE org_id = ${orgId}
    RETURNING org_id
  `;
  if (releasedBalance.length === 0) {
    throw new Error(`releaseCreditHold: missing balance row for org ${orgId}`);
  }

  const updatedHold = await sql`
    UPDATE credit_holds
    SET status = ${releaseStatus}, settled_at = ${now}
    WHERE hold_id = ${holdId} AND status = 'active'
    RETURNING hold_id
  `;
  if (updatedHold.length === 0) {
    throw new Error(`releaseCreditHold: hold ${holdId} was not active`);
  }
}

export async function reclaimExpiredCreditHolds(
  sql: Sql,
  limit: number = 200,
): Promise<number> {
  const rows = await sql`
    SELECT hold_id, org_id, hold_amount_usd, session_id
    FROM credit_holds
    WHERE status = 'active' AND expires_at < now()
    ORDER BY expires_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT ${Math.max(1, Math.min(1000, limit))}
  `;

  let reclaimed = 0;
  for (const row of rows) {
    const holdId = String(row.hold_id);
    const orgId = String(row.org_id);
    const amount = Number(row.hold_amount_usd || 0);
    const holdUpdated = await sql`
      UPDATE credit_holds
      SET status = 'expired', settled_at = now()
      WHERE hold_id = ${holdId} AND status = 'active'
      RETURNING hold_id
    `;
    if (holdUpdated.length === 0) continue;
    const balanceUpdated = await sql`
      UPDATE org_credit_balance
      SET balance_usd = balance_usd + ${amount},
          reserved_usd = GREATEST(0, reserved_usd - ${amount}),
          updated_at = now()
      WHERE org_id = ${orgId}
      RETURNING org_id
    `;
    if (balanceUpdated.length === 0) {
      throw new Error(`reclaimExpiredCreditHolds: missing balance row for org ${orgId}`);
    }
    await sql`
      INSERT INTO billing_exceptions
        (org_id, session_id, hold_id, kind, amount_usd, exception_type, expected_usd, actual_usd, charged_usd, error_message, created_at)
      VALUES
        (${orgId}, ${String(row.session_id || "") || null}, ${holdId}, 'reclaim_mismatch',
         0, 'reclaim_expired_hold', ${amount}, 0, 0, 'Hold expired before settle', now())
    `;
    reclaimed++;
  }
  return reclaimed;
}

export async function collectOutstandingCreditDebt(
  sql: Sql,
  orgId: string,
): Promise<{ collected_usd: number; remaining_usd: number }> {
  const debtRows = await sql`
    SELECT id, amount_usd
    FROM billing_exceptions
    WHERE org_id = ${orgId}
      AND kind = 'unrecovered_cost'
      AND resolved_at IS NULL
      AND amount_usd > 0
    ORDER BY created_at ASC
    FOR UPDATE
  `;
  if (debtRows.length === 0) return { collected_usd: 0, remaining_usd: 0 };

  const [bal] = await sql`
    SELECT balance_usd
    FROM org_credit_balance
    WHERE org_id = ${orgId}
    FOR UPDATE
  `;
  if (!bal) return { collected_usd: 0, remaining_usd: debtRows.reduce((s, r: any) => s + Number(r.amount_usd || 0), 0) };

  let remainingBalance = Number(bal.balance_usd || 0);
  let collected = 0;
  for (const row of debtRows as any[]) {
    if (remainingBalance <= 0) break;
    const outstanding = Number(row.amount_usd || 0);
    if (outstanding <= 0) continue;
    const applied = Math.min(outstanding, remainingBalance);
    remainingBalance -= applied;
    collected += applied;
    if (applied >= outstanding) {
      await sql`
        UPDATE billing_exceptions
        SET amount_usd = 0, resolved_at = now()
        WHERE id = ${row.id}
      `;
    } else {
      await sql`
        UPDATE billing_exceptions
        SET amount_usd = amount_usd - ${applied}
        WHERE id = ${row.id}
      `;
    }
  }

  if (collected > 0) {
    await sql`
      UPDATE org_credit_balance
      SET balance_usd = ${remainingBalance},
          lifetime_consumed_usd = lifetime_consumed_usd + ${collected},
          updated_at = now()
      WHERE org_id = ${orgId}
    `;
    await sql`
      INSERT INTO credit_transactions
        (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
      VALUES
        (${orgId}, 'burn', ${-collected}, ${remainingBalance}, 'Auto-collected unrecovered credit debt', '', 'debt_collect', now())
    `;
  }

  const [remaining] = await sql`
    SELECT COALESCE(SUM(amount_usd), 0) AS total
    FROM billing_exceptions
    WHERE org_id = ${orgId}
      AND kind = 'unrecovered_cost'
      AND resolved_at IS NULL
  `;
  return { collected_usd: collected, remaining_usd: Number(remaining?.total || 0) };
}

export async function writeOffOutstandingCreditDebt(
  sql: Sql,
  orgId: string,
  reason: string,
): Promise<number> {
  const note = `write_off:${reason}`.slice(0, 500);
  const updated = await sql`
    UPDATE billing_exceptions
    SET resolved_at = now(),
        error_message = CASE
          WHEN COALESCE(error_message, '') = '' THEN ${note}
          ELSE LEFT(error_message || ${` | ${note}`}, 500)
        END
    WHERE org_id = ${orgId}
      AND kind = 'unrecovered_cost'
      AND resolved_at IS NULL
    RETURNING id
  `;
  return updated.length;
}

// ── Mutations ─────────────────────────────────────────────────────

/**
 * Add credits (purchase, bonus, or adjustment).
 * Uses UPSERT so the first purchase auto-creates the balance row.
 */
export async function addCredits(
  sql: Sql,
  orgId: string,
  amountUsd: number,
  description: string,
  referenceId: string,
  referenceType: string,
): Promise<{ balance_after_usd: number }> {
  const now = new Date().toISOString();

  // Upsert balance row.
  // Some older deployments may not yet have `last_purchase_at`.
  try {
    await sql`
      INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, last_purchase_at, updated_at)
      VALUES (${orgId}, ${amountUsd}, ${amountUsd}, ${now}, ${now})
      ON CONFLICT (org_id) DO UPDATE SET
        balance_usd = org_credit_balance.balance_usd + ${amountUsd},
        lifetime_purchased_usd = org_credit_balance.lifetime_purchased_usd + ${amountUsd},
        last_purchase_at = ${now},
        updated_at = ${now}
    `;
  } catch (err: any) {
    const msg = String(err?.message || err || "");
    if (!msg.includes("last_purchase_at")) throw err;
    await sql`
      INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, updated_at)
      VALUES (${orgId}, ${amountUsd}, ${amountUsd}, ${now})
      ON CONFLICT (org_id) DO UPDATE SET
        balance_usd = org_credit_balance.balance_usd + ${amountUsd},
        lifetime_purchased_usd = org_credit_balance.lifetime_purchased_usd + ${amountUsd},
        updated_at = ${now}
    `;
  }

  // Read updated balance for the transaction log snapshot
  const [bal] = await sql`
    SELECT balance_usd FROM org_credit_balance WHERE org_id = ${orgId}
  `;
  const balanceAfter = Number(bal.balance_usd);

  // Immutable audit row
  await sql`
    INSERT INTO credit_transactions
      (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
    VALUES
      (${orgId}, 'purchase', ${amountUsd}, ${balanceAfter}, ${description}, ${referenceId}, ${referenceType}, ${now})
  `;

  // Auto-collect unresolved unrecovered debt after top-up.
  await collectOutstandingCreditDebt(sql, orgId).catch(() => {});

  return { balance_after_usd: balanceAfter };
}

/**
 * Deduct credits atomically. Returns { success: false } if balance is too low.
 * The WHERE clause `balance_usd >= X` prevents overdraft without a lock.
 * Tracks exact cost — no rounding, no minimums.
 */
export async function deductCredits(
  sql: Sql,
  orgId: string,
  amountUsd: number,
  description: string,
  agentName: string,
  sessionId: string,
): Promise<{ success: boolean; balance_after_usd: number }> {
  if (amountUsd <= 0) return { success: true, balance_after_usd: 0 };

  // Org-level daily spend cap — prevent runaway agents from burning unlimited credits
  // Default: $50/day for free, $200/day for pro. Configurable in org_settings.
  try {
    const [settings] = await sql`
      SELECT settings FROM org_settings WHERE org_id = ${orgId} LIMIT 1
    `.catch(() => [null]);
    const settingsJson = settings?.settings ? (typeof settings.settings === "string" ? JSON.parse(settings.settings) : settings.settings) : {};
    const dailyLimit = Number(settingsJson.daily_budget_usd) || 50; // default $50/day

    const [dailySpend] = await sql`
      SELECT COALESCE(SUM(ABS(amount_usd)), 0) as total
      FROM credit_transactions
      WHERE org_id = ${orgId} AND type = 'burn' AND created_at > now() - interval '24 hours'
    `.catch(() => [{ total: 0 }]);

    if (Number(dailySpend.total) + amountUsd > dailyLimit) {
      console.error(`[billing] Org ${orgId} hit daily spend cap: $${Number(dailySpend.total).toFixed(2)} + $${amountUsd} > $${dailyLimit}/day`);
      return { success: false, balance_after_usd: 0 };
    }
  } catch {} // Non-blocking — don't prevent billing if cap check fails

  // Idempotency: don't double-deduct for the same session
  // Skip check if session_id is empty (can't deduplicate without it)
  if (sessionId && sessionId.length > 3) {
    const existing = await sql`
      SELECT 1 FROM credit_transactions
      WHERE org_id = ${orgId} AND session_id = ${sessionId} AND type = 'burn'
      LIMIT 1
    `.catch(() => []);
    if (existing.length > 0) {
      const [bal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${orgId}`.catch(() => [{ balance_usd: 0 }]);
      return { success: true, balance_after_usd: Number(bal.balance_usd) };
    }
  }

  const now = new Date().toISOString();

  const updated = await sql`
    UPDATE org_credit_balance
    SET balance_usd = balance_usd - ${amountUsd},
        lifetime_consumed_usd = lifetime_consumed_usd + ${amountUsd},
        last_deduction_at = ${now},
        updated_at = ${now}
    WHERE org_id = ${orgId} AND balance_usd >= ${amountUsd}
  `;

  if (updated.count === 0) {
    return { success: false, balance_after_usd: 0 };
  }

  // Read updated balance for snapshot
  const [bal] = await sql`
    SELECT balance_usd FROM org_credit_balance WHERE org_id = ${orgId}
  `;
  const balanceAfter = Number(bal.balance_usd);

  // Audit row
  await sql`
    INSERT INTO credit_transactions
      (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, agent_name, session_id, created_at)
    VALUES
      (${orgId}, 'burn', ${-amountUsd}, ${balanceAfter}, ${description}, '', 'agent_run', ${agentName}, ${sessionId}, ${now})
  `;

  return { success: true, balance_after_usd: balanceAfter };
}

/**
 * Refund credits — same mechanics as addCredits but typed as 'refund'.
 */
export async function refundCredits(
  sql: Sql,
  orgId: string,
  amountUsd: number,
  description: string,
  referenceId: string,
): Promise<{ balance_after_usd: number }> {
  const now = new Date().toISOString();

  await sql`
    INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, updated_at)
    VALUES (${orgId}, ${amountUsd}, 0, ${now})
    ON CONFLICT (org_id) DO UPDATE SET
      balance_usd = org_credit_balance.balance_usd + ${amountUsd},
      updated_at = ${now}
  `;

  const [bal] = await sql`
    SELECT balance_usd FROM org_credit_balance WHERE org_id = ${orgId}
  `;
  const balanceAfter = Number(bal.balance_usd);

  await sql`
    INSERT INTO credit_transactions
      (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
    VALUES
      (${orgId}, 'refund', ${amountUsd}, ${balanceAfter}, ${description}, ${referenceId}, 'stripe_refund', ${now})
  `;

  return { balance_after_usd: balanceAfter };
}
