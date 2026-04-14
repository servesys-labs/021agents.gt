import type { Sql } from "../db/client";
import type { SeedEventType } from "../telemetry/events";

import { seedDefaultInternalAgents } from "./internal-agents";

const DEFAULT_SETTINGS = { onboarding_complete: false, default_connectors: [] as string[] };
const DEFAULT_LIMITS = { max_agents: 50, max_runs_per_month: 1000, max_seats: 1 };
const DEFAULT_FEATURES = ["basic_agents", "basic_observability"];
const DEFAULT_ENVIRONMENTS = ["development", "staging", "production"] as const;
const DEFAULT_EVENT_TYPES: { event_type: SeedEventType; category: string; description: string }[] = [
  { event_type: "agent.created", category: "agents", description: "Agent was created" },
  { event_type: "agent.updated", category: "agents", description: "Agent config was updated" },
  { event_type: "agent.deleted", category: "agents", description: "Agent was deleted" },
  { event_type: "session.started", category: "sessions", description: "Agent session started" },
  { event_type: "session.completed", category: "sessions", description: "Agent session completed" },
  { event_type: "session.failed", category: "sessions", description: "Agent session failed" },
  { event_type: "connector.token_stored", category: "connectors", description: "OAuth token stored" },
  { event_type: "connector.tool_call", category: "connectors", description: "Connector tool invoked" },
  { event_type: "retention.applied", category: "retention", description: "Retention policy applied" },
  { event_type: "config.update", category: "config", description: "Configuration changed" },
  { event_type: "member.invited", category: "orgs", description: "Member invited to org" },
  { event_type: "member.removed", category: "orgs", description: "Member removed from org" },
];

export interface BootstrapPersonalOrgInput {
  orgId: string;
  userId: string;
  email: string;
  displayName: string;
  orgName: string;
  orgSlug: string;
  nowIso?: string;
  plan?: string;
  starterCreditsUsd?: number;
  starterCreditDescription?: string;
  starterCreditReferenceId?: string;
  starterCreditReferenceType?: string;
  planType?: string;
  settings?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  features?: string[];
  projectSlug?: string;
  projectName?: string;
  projectDescription?: string;
  defaultEnv?: string;
  defaultPlan?: string;
  createProject?: boolean;
  createReferralCode?: boolean;
}

export interface BootstrapPersonalOrgResult {
  seededAgents: string[];
  creditsSeeded: boolean;
  projectId: string | null;
  referralCodeCreated: boolean;
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function sanitizeSlug(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 30);
}

export async function bootstrapPersonalOrg(
  sql: Sql,
  input: BootstrapPersonalOrgInput,
): Promise<BootstrapPersonalOrgResult> {
  const nowIso = input.nowIso || new Date().toISOString();
  const plan = input.plan || "free";
  const planType = input.planType || plan;
  const settings = JSON.stringify(input.settings || DEFAULT_SETTINGS);
  const limits = JSON.stringify(input.limits || DEFAULT_LIMITS);
  const features = JSON.stringify(input.features || DEFAULT_FEATURES);

  await sql`
    INSERT INTO orgs (org_id, name, slug, owner_user_id, plan, created_at, updated_at)
    VALUES (${input.orgId}, ${input.orgName}, ${input.orgSlug}, ${input.userId}, ${plan}, ${nowIso}, ${nowIso})
    ON CONFLICT (org_id) DO UPDATE SET
      name = EXCLUDED.name,
      slug = EXCLUDED.slug,
      owner_user_id = EXCLUDED.owner_user_id,
      plan = EXCLUDED.plan,
      updated_at = EXCLUDED.updated_at
  `;

  await sql`
    INSERT INTO org_members (org_id, user_id, role, created_at)
    VALUES (${input.orgId}, ${input.userId}, ${"owner"}, ${nowIso})
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
  `;

  await sql`
    INSERT INTO org_settings (org_id, plan_type, settings, limits, features, created_at, updated_at)
    VALUES (${input.orgId}, ${planType}, ${settings}, ${limits}, ${features}, ${nowIso}, ${nowIso})
    ON CONFLICT (org_id) DO UPDATE SET
      plan_type = EXCLUDED.plan_type,
      settings = EXCLUDED.settings,
      limits = EXCLUDED.limits,
      features = EXCLUDED.features,
      updated_at = EXCLUDED.updated_at
  `;

  const seededAgents = await seedDefaultInternalAgents(sql, {
    orgId: input.orgId,
    userId: input.userId,
    displayName: input.displayName,
    nowIso,
  });

  let creditsSeeded = false;
  const starterCreditsUsd = input.starterCreditsUsd ?? 5;
  const [existingCredits] = await sql`
    SELECT 1
    FROM org_credit_balance
    WHERE org_id = ${input.orgId}
    LIMIT 1
  `;
  if (!existingCredits) {
    await sql`
      INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, lifetime_consumed_usd, updated_at)
      VALUES (${input.orgId}, ${starterCreditsUsd}, ${starterCreditsUsd}, ${0}, ${nowIso})
    `;
    await sql`
      INSERT INTO credit_transactions (
        org_id,
        type,
        amount_usd,
        balance_after_usd,
        description,
        reference_id,
        reference_type,
        created_at
      )
      VALUES (
        ${input.orgId},
        ${"bonus"},
        ${starterCreditsUsd},
        ${starterCreditsUsd},
        ${input.starterCreditDescription || "Welcome bonus — free tier credits"},
        ${input.starterCreditReferenceId || "signup"},
        ${input.starterCreditReferenceType || "signup_bonus"},
        ${nowIso}
      )
    `;
    creditsSeeded = true;
  }

  for (const eventType of DEFAULT_EVENT_TYPES) {
    await sql`
      INSERT INTO event_types (event_type, category, description)
      VALUES (${eventType.event_type}, ${eventType.category}, ${eventType.description})
      ON CONFLICT (event_type) DO NOTHING
    `;
  }

  let projectId: string | null = null;
  if (input.createProject !== false) {
    const projectSlug = sanitizeSlug(
      input.projectSlug || input.email.split("@")[0],
      "my-agents",
    );
    const projectName = input.projectName || `${projectSlug}'s project`;
    const projectDescription = input.projectDescription || "Default project";
    const defaultEnv = input.defaultEnv || "development";
    const defaultPlan = input.defaultPlan || "standard";

    const [existingProject] = await sql`
      SELECT project_id
      FROM projects
      WHERE org_id = ${input.orgId} AND slug = ${projectSlug}
      ORDER BY created_at ASC
      LIMIT 1
    `;

    if (existingProject) {
      projectId = String(existingProject.project_id);
      await sql`
        UPDATE projects
        SET
          name = ${projectName},
          description = ${projectDescription},
          default_env = ${defaultEnv},
          default_plan = ${defaultPlan},
          updated_at = ${nowIso}
        WHERE project_id = ${projectId}
      `;
    } else {
      projectId = generateId("proj");
      await sql`
        INSERT INTO projects (
          project_id,
          org_id,
          name,
          slug,
          description,
          default_env,
          default_plan,
          created_at,
          updated_at
        )
        VALUES (
          ${projectId},
          ${input.orgId},
          ${projectName},
          ${projectSlug},
          ${projectDescription},
          ${defaultEnv},
          ${defaultPlan},
          ${nowIso},
          ${nowIso}
        )
      `;
    }

    for (const envName of DEFAULT_ENVIRONMENTS) {
      const [existingEnvironment] = await sql`
        SELECT id
        FROM environments
        WHERE org_id = ${input.orgId} AND project_id = ${projectId} AND name = ${envName}
        LIMIT 1
      `;
      if (!existingEnvironment) {
        await sql`
          INSERT INTO environments (env_id, org_id, project_id, name, is_active, created_at)
          VALUES (${generateId("env")}, ${input.orgId}, ${projectId}, ${envName}, ${true}, ${nowIso})
        `;
      }
    }
  }

  let referralCodeCreated = false;
  if (input.createReferralCode !== false) {
    const [existingReferralCode] = await sql`
      SELECT code
      FROM referral_codes
      WHERE org_id = ${input.orgId}
      ORDER BY created_at ASC
      LIMIT 1
    `;
    if (!existingReferralCode) {
      const { createReferralCode } = await import("./referrals");
      await createReferralCode(sql, input.orgId, {
        label: "Your invite link",
        userId: input.userId,
        maxUses: 5,
      });
      referralCodeCreated = true;
    }
  }

  return {
    seededAgents,
    creditsSeeded,
    projectId,
    referralCodeCreated,
  };
}
