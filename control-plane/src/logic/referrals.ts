/**
 * Agentic Referral Program
 *
 * Earn when agents you referred transact on the network.
 * No buy-in. No recruiting incentive. Revenue from real transactions only.
 *
 * Fee split: platform takes 10% of every A2A transfer.
 *   L1 referrer: 3% of transfer (2% after 50 active referrals)
 *   L2 referrer: 1% of transfer
 *   Platform retains: 6-7% (60-70% of fee)
 *
 * Declining rate: L1 drops from 3% to 2% after 50 active referrals.
 * Max 40% of platform fee goes to referrals (vs SaaS standard of 20-30%).
 * Capped at 2 levels — no infinite chain.
 */

import type postgres from "postgres";
type Sql = ReturnType<typeof postgres>;

// ── Constants ────────────────────────────────────────────────

export const L1_RATE = 0.03;           // 3% of total transfer to direct referrer
export const L1_RATE_AFTER_CAP = 0.02; // 2% after 50 active referrals (declining)
export const L1_CAP_THRESHOLD = 50;    // active referrals before rate drops
export const L2_RATE = 0.01;           // 1% of total transfer to L2 referrer
export const PLATFORM_BASE_RATE = 0.10; // 10% total platform fee
// Platform keeps: 6% min (L1 3% + L2 1%) to 10% (no referrals)

// Anti-gaming thresholds
export const MIN_TRANSFER_FOR_REFERRAL = 0.10;    // $0.10 — ignore micro-transactions
export const MAX_TRANSFERS_PER_HOUR = 100;         // per-org rate limit
export const MAX_VOLUME_PER_DAY_USD = 10_000;      // per-org daily volume cap
export const CIRCULAR_WINDOW_HOURS = 24;           // window for detecting circular transfers
export const CIRCULAR_RATIO_THRESHOLD = 0.8;       // flag if reverse flow >= 80% of forward flow
export const MIN_TASKS_FOR_ACTIVATION = 5;         // referred org must complete 5 tasks before referrer earns
export const MIN_VOLUME_FOR_ACTIVATION = 5.0;      // or $5 cumulative volume

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

// ── Anti-Gaming Guards ──────────────────────────────────────

/**
 * Check transfer rate limits for an org. Returns error string if exceeded.
 */
export async function checkTransferRateLimit(
  sql: Sql,
  orgId: string,
  amountUsd: number,
): Promise<string | null> {
  try {
    const now = new Date();
    const currentHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).toISOString();
    const today = now.toISOString().slice(0, 10);

    // Upsert rate limit row
    const [row] = await sql`
      INSERT INTO transfer_rate_limits (org_id, transfers_this_hour, hour_window, volume_today_usd, day_window, updated_at)
      VALUES (${orgId}, 1, ${currentHour}, ${amountUsd}, ${today}, NOW())
      ON CONFLICT (org_id) DO UPDATE SET
        transfers_this_hour = CASE
          WHEN transfer_rate_limits.hour_window = ${currentHour}
          THEN transfer_rate_limits.transfers_this_hour + 1
          ELSE 1
        END,
        hour_window = ${currentHour},
        volume_today_usd = CASE
          WHEN transfer_rate_limits.day_window = ${today}
          THEN transfer_rate_limits.volume_today_usd + ${amountUsd}
          ELSE ${amountUsd}
        END,
        day_window = ${today},
        updated_at = NOW()
      RETURNING transfers_this_hour, volume_today_usd
    `;

    if (Number(row.transfers_this_hour) > MAX_TRANSFERS_PER_HOUR) {
      return `Rate limit exceeded: max ${MAX_TRANSFERS_PER_HOUR} transfers per hour`;
    }
    if (Number(row.volume_today_usd) > MAX_VOLUME_PER_DAY_USD) {
      return `Daily volume limit exceeded: max $${MAX_VOLUME_PER_DAY_USD} per day`;
    }
    return null;
  } catch {
    return null; // fail open — don't block transfers on rate limit table errors
  }
}

/**
 * Detect circular transfers — flag if two orgs are ping-ponging money.
 * Records the transfer pair and checks reverse flow within the window.
 */
export async function checkCircularTransfer(
  sql: Sql,
  fromOrg: string,
  toOrg: string,
  amountUsd: number,
  transferId: string,
): Promise<{ blocked: boolean; reason?: string }> {
  try {
    // Record this transfer pair
    await sql`
      INSERT INTO transfer_pairs (from_org_id, to_org_id, amount_usd, transfer_id)
      VALUES (${fromOrg}, ${toOrg}, ${amountUsd}, ${transferId})
    `;

    // Check reverse flow in the window
    const windowStart = new Date(Date.now() - CIRCULAR_WINDOW_HOURS * 3600_000).toISOString();

    const [forward] = await sql`
      SELECT COALESCE(SUM(amount_usd), 0) as total
      FROM transfer_pairs
      WHERE from_org_id = ${fromOrg} AND to_org_id = ${toOrg} AND created_at > ${windowStart}
    `;
    const [reverse] = await sql`
      SELECT COALESCE(SUM(amount_usd), 0) as total
      FROM transfer_pairs
      WHERE from_org_id = ${toOrg} AND to_org_id = ${fromOrg} AND created_at > ${windowStart}
    `;

    const forwardTotal = Number(forward.total);
    const reverseTotal = Number(reverse.total);

    // If reverse flow is >= 80% of forward flow and above $1, flag as circular
    if (forwardTotal > 1 && reverseTotal > 1 && reverseTotal >= forwardTotal * CIRCULAR_RATIO_THRESHOLD) {
      return {
        blocked: true,
        reason: `Circular transfer detected: $${reverseTotal.toFixed(2)} reverse flow vs $${forwardTotal.toFixed(2)} forward flow between these orgs in ${CIRCULAR_WINDOW_HOURS}h window. Referral payouts suspended for this transfer.`,
      };
    }

    return { blocked: false };
  } catch {
    return { blocked: false }; // fail open
  }
}

/**
 * Check if a referral relationship is activated (referred org has enough real activity).
 * Updates activity counters and activates if thresholds met.
 */
export async function checkReferralActivation(
  sql: Sql,
  referredOrgId: string,
  transferAmount: number,
): Promise<boolean> {
  try {
    // Update counters and check activation
    const [ref] = await sql`
      UPDATE referrals
      SET referred_task_count = referred_task_count + 1,
          referred_volume_usd = referred_volume_usd + ${transferAmount},
          referral_activated = CASE
            WHEN referral_activated THEN true
            WHEN referred_task_count + 1 >= ${MIN_TASKS_FOR_ACTIVATION}
              OR referred_volume_usd + ${transferAmount} >= ${MIN_VOLUME_FOR_ACTIVATION}
            THEN true
            ELSE false
          END,
          activated_at = CASE
            WHEN referral_activated THEN activated_at
            WHEN referred_task_count + 1 >= ${MIN_TASKS_FOR_ACTIVATION}
              OR referred_volume_usd + ${transferAmount} >= ${MIN_VOLUME_FOR_ACTIVATION}
            THEN NOW()
            ELSE NULL
          END
      WHERE referred_org_id = ${referredOrgId} AND status = 'active'
      RETURNING referral_activated
    `;

    return ref?.referral_activated === true;
  } catch {
    return true; // fail open — don't block payouts on activation check errors
  }
}

// ── Distribute Referral Earnings (called from transferCredits) ─

/**
 * Calculate and distribute referral earnings from a platform fee.
 * Called after every A2A credit transfer.
 *
 * @param receiverOrgId - The org that EARNED (received payment for A2A task)
 * @param transferAmount - Total transfer amount (before platform fee)
 * @param transferId - For audit trail linkage
 * @param senderOrgId - The org that PAID (for circular detection)
 * @returns Total referral payouts made
 */
export async function distributeReferralEarnings(
  sql: Sql,
  receiverOrgId: string,
  transferAmount: number,
  transferId: string,
  senderOrgId?: string,
): Promise<{ l1_payout: number; l2_payout: number; total_payout: number; skipped_reason?: string }> {
  let l1Payout = 0;
  let l2Payout = 0;
  const now = new Date().toISOString();

  // Guard 1: Minimum transaction threshold — ignore micro-transactions
  if (transferAmount < MIN_TRANSFER_FOR_REFERRAL) {
    return { l1_payout: 0, l2_payout: 0, total_payout: 0, skipped_reason: "Below minimum transfer threshold" };
  }

  // Guard 2: Circular transfer detection
  if (senderOrgId) {
    const circular = await checkCircularTransfer(sql, senderOrgId, receiverOrgId, transferAmount, transferId);
    if (circular.blocked) {
      console.warn(`[referral] Circular transfer blocked: ${circular.reason}`);
      return { l1_payout: 0, l2_payout: 0, total_payout: 0, skipped_reason: circular.reason };
    }
  }

  // Guard 3: Minimum activity gate — referred org must have real usage
  const activated = await checkReferralActivation(sql, receiverOrgId, transferAmount);
  if (!activated) {
    return { l1_payout: 0, l2_payout: 0, total_payout: 0, skipped_reason: "Referred org has not reached minimum activity threshold" };
  }

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
    WHERE referred_org_id = ${receiverOrgId} AND status = 'active' AND referral_activated = true LIMIT 1
  `;

  if (l1Ref) {
    const l1OrgId = String(l1Ref.referrer_org_id);

    // Declining rate: check how many active referrals this referrer has
    const [refCount] = await sql`
      SELECT COUNT(*)::int as cnt FROM referrals WHERE referrer_org_id = ${l1OrgId} AND status = 'active'
    `.catch(() => [{ cnt: 0 }]);
    const activeReferrals = Number(refCount.cnt || 0);
    const effectiveL1Rate = activeReferrals > L1_CAP_THRESHOLD ? L1_RATE_AFTER_CAP : L1_RATE;

    l1Payout = Math.round(transferAmount * effectiveL1Rate * 1_000_000) / 1_000_000;

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
        VALUES (${l1OrgId}, ${receiverOrgId}, ${transferId}, 1, ${transferAmount * PLATFORM_BASE_RATE}, ${l1Payout}, ${effectiveL1Rate})
      `;

      const [l1Bal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${l1OrgId}`.catch(() => [{ balance_usd: 0 }]);
      await sql`
        INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
        VALUES (${l1OrgId}, 'bonus', ${l1Payout}, ${Number(l1Bal?.balance_usd ?? 0)}, ${'Referral earning L1: ' + receiverOrgId.slice(0, 8)}, ${transferId}, 'referral_l1', ${now})
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

          const [l2Bal] = await sql`SELECT balance_usd FROM org_credit_balance WHERE org_id = ${l2OrgId}`.catch(() => [{ balance_usd: 0 }]);
          await sql`
            INSERT INTO credit_transactions (org_id, type, amount_usd, balance_after_usd, description, reference_id, reference_type, created_at)
            VALUES (${l2OrgId}, 'bonus', ${l2Payout}, ${Number(l2Bal?.balance_usd ?? 0)}, ${'Referral earning L2: ' + receiverOrgId.slice(0, 8)}, ${transferId}, 'referral_l2', ${now})
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
