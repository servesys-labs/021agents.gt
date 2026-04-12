/**
 * Team Memory — shared knowledge across agents in an org.
 *
 * Three tiers:
 *   1. Shared Facts: org-wide knowledge (e.g., "deployment process uses GitHub Actions")
 *   2. Shared Procedures: proven tool sequences anyone can use
 *   3. Agent Observations: cross-agent notes (e.g., "code-reviewer found bug in auth module")
 *
 * Scoped by org_id. Stored in Supabase via Hyperdrive.
 * Agents read team memory at session start, write during execution.
 *
 * Inspired by Claude Code's TEAMMEM feature for memory sync across users.
 */

import type { RuntimeEnv } from "./types";

export interface TeamFact {
  id: string;
  org_id: string;
  author_agent: string;
  content: string;
  category: string; // "process", "architecture", "convention", "decision"
  score: number;
  created_at: string;
}

export interface TeamObservation {
  id: string;
  org_id: string;
  author_agent: string;
  target_agent?: string; // specific agent this observation is about
  content: string;
  created_at: string;
}

/**
 * Read team memory context for an agent. Returns a formatted string
 * to inject into the system prompt.
 */
export async function buildTeamMemoryContext(
  env: RuntimeEnv,
  orgId: string,
  agentName: string,
  maxChars: number = 2000,
): Promise<string> {
  if (!orgId) return "";

  try {
    const pg = (await import("postgres")).default;
    const sql = pg((env as any).HYPERDRIVE?.connectionString || "", { max: 1, prepare: false });

    // Fetch top team facts
    const facts = await sql`
      SELECT content, category, author_agent, score FROM facts
      WHERE org_id = ${orgId} AND score > 0.3
      ORDER BY score DESC LIMIT 10
    `.catch(() => []);

    // Fetch recent observations about this agent
    const observations = await sql`
      SELECT content, author_agent FROM facts
      WHERE org_id = ${orgId} AND (target_agent = ${agentName} OR target_agent IS NULL)
      ORDER BY created_at DESC LIMIT 5
    `.catch(() => []);

    await sql.end();

    if (facts.length === 0 && observations.length === 0) return "";

    const parts: string[] = ["## Team Knowledge"];
    let chars = 20;

    if (facts.length > 0) {
      parts.push("### Shared Facts");
      for (const f of facts) {
        const line = `- [${f.category}] ${f.content} (via ${f.author_agent})`;
        if (chars + line.length > maxChars) break;
        parts.push(line);
        chars += line.length;
      }
    }

    if (observations.length > 0) {
      parts.push("### Observations");
      for (const o of observations) {
        const line = `- ${o.content} (from ${o.author_agent})`;
        if (chars + line.length > maxChars) break;
        parts.push(line);
        chars += line.length;
      }
    }

    return parts.join("\n");
  } catch {
    return "";
  }
}

/**
 * Write a team fact. Called by agents when they learn something org-wide.
 */
export async function writeTeamFact(
  env: RuntimeEnv,
  orgId: string,
  agentName: string,
  content: string,
  category: string = "general",
): Promise<void> {
  try {
    const pg = (await import("postgres")).default;
    const sql = pg((env as any).HYPERDRIVE?.connectionString || "", { max: 1, prepare: false });

    await sql`
      INSERT INTO facts (org_id, author_agent, content, category, score, created_at)
      VALUES (${orgId}, ${agentName}, ${content.slice(0, 1000)}, ${category}, ${0.5}, NOW())
      ON CONFLICT (org_id, content) DO UPDATE SET score = facts.score + 0.1, updated_at = NOW()
    `.catch(() => {});

    await sql.end();
  } catch {}
}

/**
 * Write a team observation. Called when an agent notices something about another agent.
 */
export async function writeTeamObservation(
  env: RuntimeEnv,
  orgId: string,
  authorAgent: string,
  content: string,
  targetAgent?: string,
): Promise<void> {
  try {
    const pg = (await import("postgres")).default;
    const sql = pg((env as any).HYPERDRIVE?.connectionString || "", { max: 1, prepare: false });

    await sql`
      INSERT INTO facts (org_id, agent_name, scope, content, author_agent, category, created_at)
      VALUES (${orgId}, ${targetAgent || authorAgent}, 'team', ${content.slice(0, 1000)}, ${authorAgent}, ${targetAgent ? 'team_observation' : ''}, NOW())
    `.catch(() => {});

    await sql.end();
  } catch {}
}
