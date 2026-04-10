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
