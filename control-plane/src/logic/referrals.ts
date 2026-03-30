/**
 * Agentic Referral Program
 *
 * Earn when agents you referred transact on the network.
 * No buy-in. No recruiting incentive. Revenue from real transactions only.
 *
 * Fee split: platform takes 10% of every A2A transfer.
 *   L1 referrer (referred the earning org): 5% of transfer
 *   L2 referrer (referred the L1 referrer): 2% of transfer
 *   Platform retains: remaining 3%
 *
 * Capped at 2 levels — no infinite chain.
 */

import type postgres from "postgres";
type Sql = ReturnType<typeof postgres>;

// ── Constants ────────────────────────────────────────────────

export const L1_RATE = 0.05;  // 5% of total transfer to direct referrer
export const L2_RATE = 0.02;  // 2% of total transfer to second-level referrer
export const PLATFORM_BASE_RATE = 0.10; // 10% total platform fee
// Platform keeps: PLATFORM_BASE_RATE - L1_RATE - L2_RATE = 3% (when both levels exist)

// ── Referral Code Management ─────────────────────────────────

export async function createReferralCode(
  sql: Sql,
  orgId: string,
  opts: { code?: string; label?: string; userId?: string; maxUses?: number } = {},
): Promise<{ code: string }> {
  const code = opts.code || `ref-${orgId.slice(0, 6)}-${Math.random().toString(36).slice(2, 6)}`;

  await sql`
    INSERT INTO referral_codes (code, org_id, user_id, label, max_uses)
    VALUES (${code}, ${orgId}, ${opts.userId || ''}, ${opts.label || 'Referral link'}, ${opts.maxUses || null})
  `;

  return { code };
}

export async function getOrgReferralCodes(sql: Sql, orgId: string): Promise<any[]> {
  return sql`
    SELECT code, label, uses, max_uses, is_active, created_at
    FROM referral_codes WHERE org_id = ${orgId} ORDER BY created_at DESC
  `;
}

// ── Apply Referral (during signup) ───────────────────────────

export async function applyReferralCode(
  sql: Sql,
  referredOrgId: string,
  code: string,
): Promise<{ success: boolean; referrer_org_id?: string; error?: string }> {
  // Check if already referred
  const existing = await sql`SELECT 1 FROM referrals WHERE referred_org_id = ${referredOrgId} LIMIT 1`;
  if (existing.length > 0) return { success: false, error: "Org already has a referrer" };

  // Validate code
  const [codeRow] = await sql`
    SELECT org_id, user_id, uses, max_uses, is_active FROM referral_codes WHERE code = ${code}
  `;
  if (!codeRow) return { success: false, error: "Invalid referral code" };
  if (!codeRow.is_active) return { success: false, error: "Referral code is inactive" };
  if (codeRow.max_uses && codeRow.uses >= codeRow.max_uses) return { success: false, error: "Referral code has reached max uses" };
  if (String(codeRow.org_id) === referredOrgId) return { success: false, error: "Cannot refer yourself" };

  // Create referral relationship
  await sql`
    INSERT INTO referrals (referrer_org_id, referred_org_id, referrer_user_id, referral_code)
    VALUES (${codeRow.org_id}, ${referredOrgId}, ${codeRow.user_id || ''}, ${code})
  `;

  // Increment usage counter
  await sql`UPDATE referral_codes SET uses = uses + 1 WHERE code = ${code}`;

  return { success: true, referrer_org_id: String(codeRow.org_id) };
}

// ── Distribute Referral Earnings (called from transferCredits) ─

/**
 * Calculate and distribute referral earnings from a platform fee.
 * Called after every A2A credit transfer.
 *
 * @param receiverOrgId - The org that EARNED (received payment for A2A task)
 * @param transferAmount - Total transfer amount (before platform fee)
 * @param transferId - For audit trail linkage
 * @returns Total referral payouts made
 */
export async function distributeReferralEarnings(
  sql: Sql,
  receiverOrgId: string,
  transferAmount: number,
  transferId: string,
): Promise<{ l1_payout: number; l2_payout: number; total_payout: number }> {
  let l1Payout = 0;
  let l2Payout = 0;
  const now = new Date().toISOString();

  // Idempotency: check if earnings already distributed for this transfer
  const existing = await sql`
    SELECT 1 FROM referral_earnings WHERE transfer_id = ${transferId} LIMIT 1
  `.catch(() => []);
  if (existing.length > 0) {
    return { l1_payout: 0, l2_payout: 0, total_payout: 0 }; // already paid
  }

  // Find L1 referrer (who referred the earning org)
  const [l1Ref] = await sql`
    SELECT referrer_org_id FROM referrals
    WHERE referred_org_id = ${receiverOrgId} AND status = 'active' LIMIT 1
  `;

  if (l1Ref) {
    const l1OrgId = String(l1Ref.referrer_org_id);
    l1Payout = Math.round(transferAmount * L1_RATE * 1_000_000) / 1_000_000;

    if (l1Payout > 0) {
      // Credit L1 referrer
      await sql`
        INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, lifetime_consumed_usd, updated_at)
        VALUES (${l1OrgId}, ${l1Payout}, ${l1Payout}, 0, ${now})
        ON CONFLICT (org_id) DO UPDATE SET balance_usd = org_credit_balance.balance_usd + ${l1Payout}, updated_at = ${now}
      `;

      // Audit
      await sql`
        INSERT INTO referral_earnings (earner_org_id, source_org_id, transfer_id, level, platform_fee_usd, earning_usd, earning_rate)
        VALUES (${l1OrgId}, ${receiverOrgId}, ${transferId}, 1, ${transferAmount * PLATFORM_BASE_RATE}, ${l1Payout}, ${L1_RATE})
      `;

      await sql`
        INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
        VALUES (${l1OrgId}, 'bonus', ${l1Payout}, 0, ${'Referral earning L1: ' + receiverOrgId.slice(0, 8)}, ${transferId}, 'referral_l1', ${now})
      `.catch(() => {});

      // Find L2 referrer (who referred the L1 referrer)
      const [l2Ref] = await sql`
        SELECT referrer_org_id FROM referrals
        WHERE referred_org_id = ${l1OrgId} AND status = 'active' LIMIT 1
      `;

      if (l2Ref) {
        const l2OrgId = String(l2Ref.referrer_org_id);
        l2Payout = Math.round(transferAmount * L2_RATE * 1_000_000) / 1_000_000;

        if (l2Payout > 0) {
          // Credit L2 referrer
          await sql`
            INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, lifetime_consumed_usd, updated_at)
            VALUES (${l2OrgId}, ${l2Payout}, ${l2Payout}, 0, ${now})
            ON CONFLICT (org_id) DO UPDATE SET balance_usd = org_credit_balance.balance_usd + ${l2Payout}, updated_at = ${now}
          `;

          // Audit
          await sql`
            INSERT INTO referral_earnings (earner_org_id, source_org_id, transfer_id, level, platform_fee_usd, earning_usd, earning_rate)
            VALUES (${l2OrgId}, ${receiverOrgId}, ${transferId}, 2, ${transferAmount * PLATFORM_BASE_RATE}, ${l2Payout}, ${L2_RATE})
          `;

          await sql`
            INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
            VALUES (${l2OrgId}, 'bonus', ${l2Payout}, 0, ${'Referral earning L2: ' + receiverOrgId.slice(0, 8)}, ${transferId}, 'referral_l2', ${now})
          `.catch(() => {});
        }
      }
    }
  }

  return { l1_payout: l1Payout, l2_payout: l2Payout, total_payout: l1Payout + l2Payout };
}

// ── Referral Stats ───────────────────────────────────────────

export async function getReferralStats(sql: Sql, orgId: string): Promise<any> {
  // Direct referrals
  const referrals = await sql`
    SELECT r.referred_org_id, r.created_at, o.name as org_name
    FROM referrals r LEFT JOIN orgs o ON o.org_id = r.referred_org_id
    WHERE r.referrer_org_id = ${orgId} AND r.status = 'active'
    ORDER BY r.created_at DESC
  `.catch(() => []);

  // Earnings
  const [earnings] = await sql`
    SELECT
      COUNT(*) as total_transactions,
      COALESCE(SUM(earning_usd), 0) as total_earned_usd,
      COALESCE(SUM(earning_usd) FILTER (WHERE level = 1), 0) as l1_earned_usd,
      COALESCE(SUM(earning_usd) FILTER (WHERE level = 2), 0) as l2_earned_usd,
      COUNT(DISTINCT source_org_id) as earning_sources
    FROM referral_earnings WHERE earner_org_id = ${orgId}
  `.catch(() => [{ total_transactions: 0, total_earned_usd: 0, l1_earned_usd: 0, l2_earned_usd: 0, earning_sources: 0 }]);

  // Referral codes
  const codes = await getOrgReferralCodes(sql, orgId);

  return {
    referrals: referrals.map((r: any) => ({
      org_id: r.referred_org_id,
      org_name: r.org_name || "Unknown",
      since: r.created_at,
    })),
    total_referrals: referrals.length,
    earnings: {
      total_transactions: Number(earnings.total_transactions || 0),
      total_earned_usd: Number(earnings.total_earned_usd || 0),
      l1_earned_usd: Number(earnings.l1_earned_usd || 0),
      l2_earned_usd: Number(earnings.l2_earned_usd || 0),
      earning_sources: Number(earnings.earning_sources || 0),
    },
    codes: codes.map((c: any) => ({
      code: c.code,
      label: c.label,
      uses: c.uses,
      max_uses: c.max_uses,
      active: c.is_active,
    })),
  };
}
