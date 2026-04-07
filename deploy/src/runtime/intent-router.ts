/**
 * Intent-based multi-agent router.
 * Classifies user intent and routes to the best-matching agent.
 *
 * P1 fixes applied:
 * - Context-aware scoring (considers surrounding words, not just keyword match)
 * - Agent capability caching (60s TTL)
 * - "general" fallback with explicit confidence
 * - Weighted patterns (some keywords are stronger signals)
 */

export interface IntentClassification {
  intent: string;
  confidence: number;
  suggested_agent?: string;
  reasoning?: string;
  all_intents?: Array<{ intent: string; score: number }>;
}

export interface AgentCapability {
  agent_name: string;
  intents: string[];
  description: string;
  priority: number;
}

// Weighted intent patterns — weight > 1 means stronger signal
interface WeightedPattern {
  pattern: RegExp;
  weight: number;
  // Context patterns: if these appear nearby, boost/reduce score
  boost_context?: RegExp[];
  penalize_context?: RegExp[];
}

const INTENT_PATTERNS: Record<string, WeightedPattern[]> = {
  deploy: [
    { pattern: /\bdeploy\b/i, weight: 2.0 },
    { pattern: /\brelease\b/i, weight: 1.5 },
    { pattern: /\bpush.*prod/i, weight: 2.0 },
    { pattern: /\bpromote\b/i, weight: 1.5 },
    { pattern: /\brollback\b/i, weight: 2.0 },
    { pattern: /\bcanary\b/i, weight: 1.5 },
    { pattern: /\bstaging\b/i, weight: 1.0 },
  ],
  debug: [
    { pattern: /\bdebug\b/i, weight: 2.0 },
    { pattern: /\berror\b/i, weight: 1.5 },
    // "fix" is ambiguous — penalize if followed by deploy-like words
    { pattern: /\bfix\b/i, weight: 1.0, penalize_context: [/deploy/i, /release/i] },
    { pattern: /\btrace\b/i, weight: 1.5 },
    { pattern: /\blogs?\b/i, weight: 1.5, boost_context: [/show/i, /view/i, /check/i] },
    { pattern: /\bstack.?trace\b/i, weight: 2.0 },
    { pattern: /\bcrash\b/i, weight: 2.0 },
    { pattern: /\bbug\b/i, weight: 1.5 },
  ],
  research: [
    { pattern: /\bresearch\b/i, weight: 2.0 },
    { pattern: /\bfind.*information\b/i, weight: 1.5 },
    { pattern: /\blook.*up\b/i, weight: 1.5 },
    { pattern: /\bsearch\b/i, weight: 1.0, boost_context: [/web/i, /internet/i, /online/i] },
    { pattern: /\bsummarize\b/i, weight: 1.5 },
    { pattern: /\banalyze\b/i, weight: 1.0 },
  ],
  support: [
    { pattern: /\bhelp\b/i, weight: 1.0 },
    { pattern: /\bhow.*do\b/i, weight: 1.5 },
    { pattern: /\bwhat.*is\b/i, weight: 1.0 },
    { pattern: /\bexplain\b/i, weight: 1.5 },
    { pattern: /\bguide\b/i, weight: 1.5 },
    { pattern: /\btutorial\b/i, weight: 1.5 },
  ],
  code: [
    { pattern: /\bcode\b/i, weight: 1.0, boost_context: [/write/i, /review/i, /implement/i] },
    { pattern: /\bimplement\b/i, weight: 2.0 },
    { pattern: /\brefactor\b/i, weight: 2.0 },
    { pattern: /\breview\b/i, weight: 1.0, boost_context: [/code/i, /pr/i, /pull/i] },
    { pattern: /\bwrite.*function\b/i, weight: 2.0 },
    { pattern: /\bapi\b/i, weight: 0.5, boost_context: [/build/i, /create/i, /design/i] },
  ],
  data: [
    { pattern: /\bdata\b/i, weight: 1.0, boost_context: [/query/i, /analyze/i, /pipeline/i] },
    { pattern: /\bquery\b/i, weight: 1.5 },
    { pattern: /\bsql\b/i, weight: 2.0 },
    { pattern: /\bcsv\b/i, weight: 1.5 },
    { pattern: /\breport\b/i, weight: 1.0 },
    { pattern: /\bdashboard\b/i, weight: 1.5 },
    { pattern: /\banalytics\b/i, weight: 1.5 },
  ],
  security: [
    { pattern: /\bsecurity\b/i, weight: 2.0 },
    { pattern: /\bvulnerability\b/i, weight: 2.0 },
    { pattern: /\bscan\b/i, weight: 1.0, boost_context: [/security/i, /owasp/i] },
    { pattern: /\baudit\b/i, weight: 1.5 },
    { pattern: /\bcompliance\b/i, weight: 1.5 },
    { pattern: /\bpii\b/i, weight: 2.0 },
  ],
};

export function classifyIntent(
  input: string,
  availableAgents?: AgentCapability[],
): IntentClassification {
  const lower = input.toLowerCase();
  const scores: Record<string, number> = {};
  const maxWeights: Record<string, number> = {};

  // Score each intent with weighted patterns + context
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    let score = 0;
    let maxWeight = 0;
    for (const wp of patterns) {
      maxWeight += wp.weight;
      if (!wp.pattern.test(lower)) continue;

      let adjustedWeight = wp.weight;

      // Context boosts
      if (wp.boost_context) {
        for (const ctx of wp.boost_context) {
          if (ctx.test(lower)) { adjustedWeight *= 1.5; break; }
        }
      }
      // Context penalties
      if (wp.penalize_context) {
        for (const ctx of wp.penalize_context) {
          if (ctx.test(lower)) { adjustedWeight *= 0.3; break; }
        }
      }

      score += adjustedWeight;
    }
    if (score > 0) {
      scores[intent] = score;
      maxWeights[intent] = maxWeight;
    }
  }

  // Sort by score
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) {
    return {
      intent: "general",
      confidence: 0.3,
      reasoning: "No specific intent patterns detected",
      all_intents: [],
    };
  }

  const [bestIntent, bestScore] = sorted[0];
  const maxWeight = maxWeights[bestIntent] || 1;
  const confidence = Math.min(0.95, 0.2 + (bestScore / maxWeight) * 0.75);

  // Match to available agent
  let suggestedAgent: string | undefined;
  if (availableAgents) {
    const matching = availableAgents
      .filter((a) => a.intents.includes(bestIntent))
      .sort((a, b) => b.priority - a.priority);
    if (matching.length > 0) {
      suggestedAgent = matching[0].agent_name;
    }
    // Fallback: if no agent matches intent, try matching by description keyword
    if (!suggestedAgent) {
      const descMatch = availableAgents.find((a) =>
        a.description.toLowerCase().includes(bestIntent),
      );
      if (descMatch) suggestedAgent = descMatch.agent_name;
    }
  }

  return {
    intent: bestIntent,
    confidence,
    suggested_agent: suggestedAgent,
    reasoning: `Matched ${bestIntent} intent (score=${bestScore.toFixed(1)}, max=${maxWeight.toFixed(1)})`,
    all_intents: sorted.map(([intent, score]) => ({ intent, score: Math.round(score * 100) / 100 })),
  };
}

/**
 * Multi-intent decomposition — splits compound requests into sub-tasks.
 */
export function decomposeIntents(
  input: string,
): Array<{ intent: string; subtask: string; confidence: number }> {
  const parts = input.split(/\band\b|\bthen\b|\balso\b|,\s+/i).map((s) => s.trim()).filter(Boolean);

  if (parts.length <= 1) {
    const cls = classifyIntent(input);
    return [{ intent: cls.intent, subtask: input, confidence: cls.confidence }];
  }

  return parts.map((part) => {
    const cls = classifyIntent(part);
    return { intent: cls.intent, subtask: part, confidence: cls.confidence };
  });
}

// ── P1 Fix: Agent capability cache ────────────────────────────────────

const AGENT_CACHE_TTL = 60_000; // 60 seconds
let agentCache: { agents: AgentCapability[]; orgId: string; timestamp: number } | null = null;

/**
 * Get agent capabilities with caching to avoid DB query on every route-to-agent call.
 */
export async function getAgentCapabilitiesCached(
  hyperdrive: Hyperdrive,
  orgId: string,
): Promise<AgentCapability[]> {
  // Return cached if fresh and same org
  if (agentCache && agentCache.orgId === orgId && Date.now() - agentCache.timestamp < AGENT_CACHE_TTL) {
    return agentCache.agents;
  }

  try {
    const pg = (await import("postgres")).default;
    const sql = pg(hyperdrive.connectionString, {
      max: 1, fetch_types: false, prepare: false, idle_timeout: 5, connect_timeout: 3,
    });

    const rows = await sql`
      SELECT name, description, config FROM agents
      WHERE org_id = ${orgId} AND is_active = true
    `;

    const capabilities = rows.map((a: any) => {
      let config: Record<string, unknown> = {};
      try { config = typeof a.config === "string" ? JSON.parse(a.config) : (a.config || {}); } catch {}
      return {
        agent_name: a.name,
        intents: Array.isArray(config.intents) ? config.intents : (Array.isArray(config.tags) ? config.tags : []),
        description: String(a.description || config.description || ""),
        priority: Number(config.routing_priority ?? 1),
      };
    });

    agentCache = { agents: capabilities, orgId, timestamp: Date.now() };
    return capabilities;
  } catch {
    return agentCache?.agents || [];
  }
}
