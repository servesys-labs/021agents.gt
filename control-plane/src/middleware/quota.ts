/**
 * Quota enforcement middleware for SaaS monetization.
 *
 * Enforces plan limits:
 * - Free: 3 agents, 1K runs/month
 * - Pro: 10 agents, 50K runs/month
 * - Team: Unlimited agents, 500K runs/month
 * - Enterprise: Custom limits
 */

import type { Context, Next } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";

export type PlanType = "free" | "pro" | "team" | "enterprise";

export interface QuotaLimits {
  maxAgents: number;
  maxRunsPerMonth: number;
  maxSeats: number;
  features: string[];
}

const PLAN_LIMITS: Record<PlanType, QuotaLimits> = {
  free: {
    maxAgents: 3,
    maxRunsPerMonth: 1000,
    maxSeats: 1,
    features: ["basic_agents", "basic_observability"],
  },
  pro: {
    maxAgents: 10,
    maxRunsPerMonth: 50000,
    maxSeats: 5,
    features: [
      "basic_agents",
      "advanced_agents",
      "basic_observability",
      "advanced_observability",
      "eval",
      "evolve",
      "voice",
    ],
  },
  team: {
    maxAgents: Infinity,
    maxRunsPerMonth: 500000,
    maxSeats: 20,
    features: [
      "basic_agents",
      "advanced_agents",
      "basic_observability",
      "advanced_observability",
      "eval",
      "evolve",
      "voice",
      "redteam",
      "a2a",
      "mcp",
      "pipelines",
    ],
  },
  enterprise: {
    maxAgents: Infinity,
    maxRunsPerMonth: Infinity,
    maxSeats: Infinity,
    features: ["*"], // All features
  },
};

/**
 * Get current quota usage for an org
 */
export async function getQuotaUsage(
  env: Env,
  orgId: string,
): Promise<{
  agentCount: number;
  runsThisMonth: number;
  seatCount: number;
  plan: PlanType;
}> {
  const sql = await getDbForOrg(env.HYPERDRIVE, orgId);

  // Get plan from org settings (default to free)
  const orgRow = await sql`
    SELECT plan_type FROM org_settings WHERE org_id = ${orgId} LIMIT 1
  `.catch(() => []);
  const plan = (orgRow[0]?.plan_type as PlanType) || "free";

  // Count agents
  const agentResult = await sql`
    SELECT COUNT(*) as count FROM agents WHERE org_id = ${orgId}
  `;
  const agentCount = Number(agentResult[0]?.count || 0);

  // Count runs this month
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthStartTs = monthStart.getTime() / 1000;

  const runsResult = await sql`
    SELECT COUNT(*) as count FROM billing_records 
    WHERE org_id = ${orgId} AND created_at >= ${monthStartTs}
  `;
  const runsThisMonth = Number(runsResult[0]?.count || 0);

  // Count seats (users in org)
  const seatsResult = await sql`
    SELECT COUNT(*) as count FROM org_members WHERE org_id = ${orgId}
  `.catch(() => [{ count: 1 }]);
  const seatCount = Number(seatsResult[0]?.count || 1);

  return { agentCount, runsThisMonth, seatCount, plan };
}

/**
 * Check if org has available quota
 */
export async function checkQuota(
  env: Env,
  orgId: string,
  resource: "agents" | "runs" | "seats",
): Promise<{ allowed: boolean; limit: number; current: number; plan: PlanType }> {
  const usage = await getQuotaUsage(env, orgId);
  const limits = PLAN_LIMITS[usage.plan];

  let limit: number;
  let current: number;

  switch (resource) {
    case "agents":
      limit = limits.maxAgents;
      current = usage.agentCount;
      break;
    case "runs":
      limit = limits.maxRunsPerMonth;
      current = usage.runsThisMonth;
      break;
    case "seats":
      limit = limits.maxSeats;
      current = usage.seatCount;
      break;
  }

  return {
    allowed: current < limit,
    limit,
    current,
    plan: usage.plan,
  };
}

/**
 * Middleware to enforce agent creation quota
 */
export function requireAgentQuota() {
  return async (c: Context<{ Bindings: Env; Variables: { user: CurrentUser } }>, next: Next) => {
    const user = c.get("user");
    const check = await checkQuota(c.env, user.org_id, "agents");

    if (!check.allowed) {
      return c.json(
        {
          error: "Agent quota exceeded",
          message: `Your ${check.plan} plan allows ${check.limit} agents. You currently have ${check.current}.`,
          upgrade_url: "/billing/upgrade",
          current: check.current,
          limit: check.limit,
          plan: check.plan,
        },
        403,
      );
    }

    await next();
  };
}

/**
 * Middleware to enforce run quota (usage-based)
 */
export function requireRunQuota() {
  return async (c: Context<{ Bindings: Env; Variables: { user: CurrentUser } }>, next: Next) => {
    const user = c.get("user");
    const check = await checkQuota(c.env, user.org_id, "runs");

    if (!check.allowed) {
      return c.json(
        {
          error: "Monthly run quota exceeded",
          message: `Your ${check.plan} plan allows ${check.limit.toLocaleString()} runs per month. You've used ${check.current.toLocaleString()}.`,
          upgrade_url: "/billing/upgrade",
          current: check.current,
          limit: check.limit,
          plan: check.plan,
          reset_date: getNextMonthDate(),
        },
        403,
      );
    }

    await next();
  };
}

/**
 * Middleware to check feature availability
 */
export function requireFeature(feature: string) {
  return async (c: Context<{ Bindings: Env; Variables: { user: CurrentUser } }>, next: Next) => {
    const user = c.get("user");
    const usage = await getQuotaUsage(c.env, user.org_id);
    const limits = PLAN_LIMITS[usage.plan];

    const hasFeature =
      limits.features.includes("*") || limits.features.includes(feature);

    if (!hasFeature) {
      return c.json(
        {
          error: "Feature not available",
          message: `The '${feature}' feature is not available on your ${usage.plan} plan.`,
          upgrade_url: "/billing/upgrade",
          required_feature: feature,
          available_on: getPlansWithFeature(feature),
        },
        403,
      );
    }

    await next();
  };
}

/**
 * Get quota status for UI display
 */
export async function getQuotaStatus(
  env: Env,
  orgId: string,
): Promise<{
  plan: PlanType;
  agents: { used: number; limit: number; percentage: number };
  runs: { used: number; limit: number; percentage: number; reset_date: string };
  seats: { used: number; limit: number; percentage: number };
  features: string[];
}> {
  const usage = await getQuotaUsage(env, orgId);
  const limits = PLAN_LIMITS[usage.plan];

  const agentsPct =
    limits.maxAgents === Infinity
      ? 0
      : Math.round((usage.agentCount / limits.maxAgents) * 100);

  const runsPct =
    limits.maxRunsPerMonth === Infinity
      ? 0
      : Math.round((usage.runsThisMonth / limits.maxRunsPerMonth) * 100);

  const seatsPct =
    limits.maxSeats === Infinity
      ? 0
      : Math.round((usage.seatCount / limits.maxSeats) * 100);

  return {
    plan: usage.plan,
    agents: {
      used: usage.agentCount,
      limit: limits.maxAgents,
      percentage: agentsPct,
    },
    runs: {
      used: usage.runsThisMonth,
      limit: limits.maxRunsPerMonth,
      percentage: runsPct,
      reset_date: getNextMonthDate(),
    },
    seats: {
      used: usage.seatCount,
      limit: limits.maxSeats,
      percentage: seatsPct,
    },
    features: limits.features,
  };
}

// Helper functions
function getNextMonthDate(): string {
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  nextMonth.setDate(1);
  return nextMonth.toISOString().split("T")[0];
}

function getPlansWithFeature(feature: string): PlanType[] {
  return (Object.keys(PLAN_LIMITS) as PlanType[]).filter(
    (plan) =>
      PLAN_LIMITS[plan].features.includes("*") ||
      PLAN_LIMITS[plan].features.includes(feature),
  );
}
