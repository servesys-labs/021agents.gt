/**
 * Agent-to-Agent Payments (x-402 Protocol)
 *
 * Enables agents to charge other agents for services using OneShots credits.
 * Implements the x-402 HTTP payment protocol:
 *
 * 1. Agent A sends task to Agent B
 * 2. Agent B responds 402 with price in x-402 headers
 * 3. Agent A transfers credits to Agent B's org
 * 4. Agent A retries with payment receipt
 * 5. Agent B verifies receipt and executes
 *
 * All transfers are atomic, audited, and reversible (refund on failure).
 */

import type postgres from "postgres";
type Sql = ReturnType<typeof postgres>;

// ── Types ────────────────────────────────────────────────────

export interface AgentPricing {
  /** Cost per task in USD */
  price_per_task_usd: number;
  /** Cost per 1K tokens in USD (input + output) */
  price_per_1k_tokens_usd: number;
  /** Whether this agent requires payment */
  requires_payment: boolean;
  /** Accepted payment methods */
  accepts: ("oneshots-credits" | "stripe")[];
}

export interface PaymentReceipt {
  transfer_id: string;
  from_org: string;
  to_org: string;
  amount_usd: number;
  task_id: string;
  created_at: string;
}

export interface TransferResult {
  success: boolean;
  transfer_id?: string;
  error?: string;
  from_balance_after?: number;
}

// ── Agent Pricing ────────────────────────────────────────────

/** Get an agent's pricing from its config. Returns null if free. */
export function getAgentPricing(configJson: Record<string, unknown>): AgentPricing | null {
  const pricing = configJson.pricing as Record<string, unknown> | undefined;
  if (!pricing) return null;

  const pricePerTask = Number(pricing.price_per_task_usd ?? 0);
  const pricePerTokens = Number(pricing.price_per_1k_tokens_usd ?? 0);

  if (pricePerTask <= 0 && pricePerTokens <= 0) return null;

  return {
    price_per_task_usd: pricePerTask,
    price_per_1k_tokens_usd: pricePerTokens,
    requires_payment: true,
    accepts: ["oneshots-credits"],
  };
}

/** Build x-402 headers for a 402 Payment Required response. */
export function build402Headers(pricing: AgentPricing, agentName: string, orgId: string): Record<string, string> {
  return {
    "x-402-price": String(pricing.price_per_task_usd),
    "x-402-currency": "USD",
    "x-402-accepts": pricing.accepts.join(","),
    "x-402-payment-address": orgId,
    "x-402-agent": agentName,
    "x-402-description": `Payment required for agent: ${agentName}`,
  };
}

// ── Credit Transfer ──────────────────────────────────────────

/**
 * Transfer credits between orgs. Atomic: deducts from sender and credits to receiver
 * in a single transaction. Creates audit trail in credit_transactions for both orgs.
 */
export async function transferCredits(
  sql: Sql,
  fromOrg: string,
  toOrg: string,
  amountUsd: number,
  description: string,
  taskId: string,
): Promise<TransferResult> {
  if (amountUsd <= 0) return { success: false, error: "Amount must be positive" };
  if (fromOrg === toOrg) return { success: false, error: "Cannot transfer to self" };

  // Rate limit check — prevent high-frequency transfer abuse
  const { checkTransferRateLimit } = await import("./referrals");
  const rateLimitError = await checkTransferRateLimit(sql, fromOrg, amountUsd);
  if (rateLimitError) return { success: false, error: rateLimitError };

  // Platform fee: 10% of transfer amount
  const PLATFORM_FEE_RATE = 0.10;
  const platformFee = Math.round(amountUsd * PLATFORM_FEE_RATE * 1_000_000) / 1_000_000;
  const receiverAmount = amountUsd - platformFee;

  const transferId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const now = new Date().toISOString();

  try {
    // Caller is expected to invoke this from inside a withOrgDb callback,
    // so `sql` is already a transaction-scoped client. Nesting another
    // sql.begin() here would fail (TransactionSql has no .begin method).
    // All queries below run in the enclosing transaction and roll back
    // together if any throw.
    const deducted = await sql`
      UPDATE org_credit_balance
      SET balance_usd = balance_usd - ${amountUsd},
          lifetime_consumed_usd = lifetime_consumed_usd + ${amountUsd},
          updated_at = ${now}
      WHERE org_id = ${fromOrg} AND balance_usd >= ${amountUsd}
    `;

    if (deducted.count === 0) {
      throw new Error("Insufficient credits");
    }

    // Credit to receiver (minus platform fee)
    await sql`
      INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, lifetime_consumed_usd, updated_at)
      VALUES (${toOrg}, ${receiverAmount}, ${receiverAmount}, 0, ${now})
      ON CONFLICT (org_id) DO UPDATE
      SET balance_usd = org_credit_balance.balance_usd + ${receiverAmount},
          lifetime_purchased_usd = org_credit_balance.lifetime_purchased_usd + ${receiverAmount},
          updated_at = ${now}
    `;

    // Read updated balances
    const [fromBal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${fromOrg}`;

    // Audit trail — sender
    await sql`
      INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
      VALUES (${fromOrg}, 'transfer_out', ${-amountUsd}, ${Number(fromBal.balance_usd)}, ${description}, ${transferId}, 'a2a_payment', ${now})
    `;

    // Audit trail — receiver
    const [toBal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${toOrg}`;
    await sql`
      INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
      VALUES (${toOrg}, 'transfer_in', ${amountUsd}, ${Number(toBal.balance_usd)}, ${description}, ${transferId}, 'a2a_payment', ${now})
    `;

    const result = { from_balance_after: Number(fromBal.balance_usd) };

    // Referral earnings — distribute from platform fee to referrers (outside transaction, non-blocking)
    let referralPayout = 0;
    if (platformFee > 0) {
      try {
        const { distributeReferralEarnings } = await import("./referrals");
        const payouts = await distributeReferralEarnings(sql, toOrg, amountUsd, transferId, fromOrg);
        referralPayout = payouts.total_payout;
      } catch {} // non-blocking — if referral system fails, platform keeps full fee
    }

    // Platform retains: total fee minus referral payouts
    const platformRetained = platformFee - referralPayout;
    if (platformRetained > 0) {
      // Fetch actual platform balance for audit accuracy
      const [platformBal] = await sql`
        SELECT balance_usd FROM org_credit_balance WHERE org_id = 'platform'
      `.catch(() => [{ balance_usd: 0 }]);
      await sql`
        INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
        VALUES ('platform', 'transfer_in', ${platformRetained}, ${Number(platformBal?.balance_usd ?? 0)}, ${'Platform fee: ' + description}, ${transferId}, 'marketplace_fee', ${now})
      `.catch(() => {});
    }

    return {
      success: true,
      transfer_id: transferId,
      from_balance_after: result.from_balance_after,
    };
  } catch (err: any) {
    if (err.message === "Insufficient credits") {
      return { success: false, error: "Insufficient credits" };
    }
    return { success: false, error: `Transfer failed: ${err.message}` };
  }
}

/**
 * Verify a payment receipt — check that the transfer exists and matches the expected amount.
 */
export async function verifyPaymentReceipt(
  sql: Sql,
  transferId: string,
  expectedToOrg: string,
  minAmount: number,
): Promise<{ valid: boolean; error?: string }> {
  try {
    const rows = await sql`
      SELECT amount_usd, org_id FROM credit_transactions
      WHERE reference_id = ${transferId} AND type = 'transfer_in'
      LIMIT 1
    `;
    if (rows.length === 0) return { valid: false, error: "Transfer not found" };

    const tx = rows[0];
    if (String(tx.org_id) !== expectedToOrg) return { valid: false, error: "Transfer recipient mismatch" };
    if (Math.abs(Number(tx.amount_usd)) < minAmount) return { valid: false, error: "Insufficient payment amount" };

    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: `Verification failed: ${err.message}` };
  }
}

/**
 * Refund a transfer — reverse the credit flow on task failure.
 */
export async function refundTransfer(
  sql: Sql,
  transferId: string,
  fromOrg: string,
  toOrg: string,
  amountUsd: number,
  reason: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const now = new Date().toISOString();
    const refundId = `refund-${transferId}`;

    // Idempotency: check if already refunded
    const existing = await sql`
      SELECT 1 FROM credit_transactions WHERE reference_id = ${refundId} LIMIT 1
    `;
    if (existing.length > 0) return { success: true }; // already refunded

    // Caller runs this inside a withOrgDb callback — `sql` is already a
    // transaction-scoped client, so all queries below share one
    // transaction and roll back together on throw. Nesting sql.begin()
    // would fail (TransactionSql has no .begin method).
    {
      // Deduct from receiver (only if they have enough)
      const deducted = await sql`
        UPDATE org_credit_balance
        SET balance_usd = balance_usd - ${amountUsd}, updated_at = ${now}
        WHERE org_id = ${toOrg} AND balance_usd >= ${amountUsd}
      `;
      if (deducted.count === 0) {
        // Receiver doesn't have enough — partial refund of what they have
        const [receiverBal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${toOrg}`;
        const available = Math.max(0, Number(receiverBal?.balance_usd || 0));
        if (available > 0) {
          await sql`UPDATE org_credit_balance SET balance_usd = 0, updated_at = ${now} WHERE org_id = ${toOrg}`;
          await sql`UPDATE org_credit_balance SET balance_usd = balance_usd + ${available}, updated_at = ${now} WHERE org_id = ${fromOrg}`;
          const [senderBalPartial] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${fromOrg}`;
          await sql`INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
            VALUES (${fromOrg}, 'refund', ${available}, ${Number(senderBalPartial.balance_usd)}, ${reason + ' (partial)'}, ${refundId}, 'a2a_refund', ${now})`;
          console.warn(`[refund] Partial refund $${available} of $${amountUsd} — receiver ${toOrg} had insufficient balance`);
        }
      } else {
        // Full refund path
        await sql`UPDATE org_credit_balance SET balance_usd = balance_usd + ${amountUsd}, updated_at = ${now} WHERE org_id = ${fromOrg}`;

        // Audit trails
        const [senderBal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${fromOrg}`;
        const [receiverBal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${toOrg}`;
        await sql`INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
          VALUES (${fromOrg}, 'refund', ${amountUsd}, ${Number(senderBal.balance_usd)}, ${reason}, ${refundId}, 'a2a_refund', ${now})`;
        await sql`INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
          VALUES (${toOrg}, 'refund', ${-amountUsd}, ${Number(receiverBal.balance_usd)}, ${'Refund debit: ' + reason}, ${refundId + '-debit'}, 'a2a_refund', ${now})`;
      }
    }

    return { success: true };
  } catch (err: any) {
    console.error(`[refund] Failed for transfer ${transferId}: ${err.message}`);
    return { success: false, error: `Refund failed: ${err.message}` };
  }
}
