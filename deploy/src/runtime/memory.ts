/**
 * Edge Runtime — Memory System.
 *
 * Four memory tiers, all at the edge:
 *   1. Working  — session-scoped key/value (DO state, volatile)
 *   2. Episodic — past interaction summaries (Supabase via Hyperdrive)
 *   3. Procedural — learned tool sequences (Supabase via Hyperdrive)
 *   4. Semantic — factual knowledge (Vectorize + Supabase)
 *
 * Plus: async fact extraction (pattern-based, queued to Supabase).
 *
 * Memory is injected into the system prompt before each LLM call
 * via buildMemoryContext(). Episodes are stored after each turn.
 * Facts are extracted asynchronously (non-blocking).
 */

import type { RuntimeEnv } from "./types";

// ── Working Memory (session-scoped, in-memory) ───────────────

export interface WorkingMemory {
  entries: Map<string, { value: unknown; ttl?: number; createdAt: number }>;
  maxItems: number;
}

export function createWorkingMemory(maxItems = 100): WorkingMemory {
  return { entries: new Map(), maxItems };
}

export function wmSet(wm: WorkingMemory, key: string, value: unknown, ttl?: number): void {
  if (wm.entries.size >= wm.maxItems) {
    // Evict oldest
    const oldest = wm.entries.keys().next().value;
    if (oldest !== undefined) wm.entries.delete(oldest);
  }
  wm.entries.set(key, { value, ttl, createdAt: Date.now() });
}

export function wmGet(wm: WorkingMemory, key: string): unknown | null {
  const entry = wm.entries.get(key);
  if (!entry) return null;
  if (entry.ttl && Date.now() - entry.createdAt > entry.ttl * 1000) {
    wm.entries.delete(key);
    return null;
  }
  return entry.value;
}

export function wmSnapshot(wm: WorkingMemory): Record<string, unknown> {
  const now = Date.now();
  const snap: Record<string, unknown> = {};
  for (const [key, entry] of wm.entries) {
    if (entry.ttl && now - entry.createdAt > entry.ttl * 1000) continue;
    snap[key] = entry.value;
  }
  return snap;
}

// ── Episodic Memory (past interactions, Supabase) ─────────────

interface Episode {
  id: string;
  input: string;
  output: string;
  outcome: string;
  created_at: number;
}

/**
 * Search past episodes by keyword overlap.
 * Returns most relevant past interactions for context injection.
 */
export async function searchEpisodes(
  hyperdrive: Hyperdrive,
  query: string,
  opts: { agent_name?: string; org_id?: string; limit?: number },
): Promise<Episode[]> {
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);
  const limit = opts.limit || 3;

  // Use Postgres full-text search or ILIKE fallback
  const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 5);
  if (keywords.length === 0) return [];

  const pattern = keywords.map((k) => `%${k}%`).join("");

  // Search recent episodes matching any keyword
  let rows: any[] = [];
  try {
    rows = await sql`
      SELECT session_id as id, input_text as input, output_text as output,
             status as outcome, created_at
      FROM sessions
      WHERE agent_name = ${opts.agent_name || ""}
        AND (
          LOWER(input_text) LIKE ${`%${keywords[0]}%`}
          OR LOWER(output_text) LIKE ${`%${keywords[0]}%`}
        )
      ORDER BY session_id DESC
      LIMIT ${limit * 3}
    `;
  } catch {
    // Memory search is best-effort — don't block execution
    return [];
  }

  // Score by keyword overlap and return top N
  return rows
    .map((row: any) => {
      const text = `${row.input} ${row.output}`.toLowerCase();
      const score = keywords.filter((k) => text.includes(k)).length / keywords.length;
      return { ...row, _score: score };
    })
    .filter((r: any) => r._score > 0.2)
    .sort((a: any, b: any) => b._score - a._score)
    .slice(0, limit)
    .map((r: any) => ({
      id: r.id || "",
      input: r.input || "",
      output: (r.output || "").slice(0, 500),
      outcome: r.outcome || "",
      created_at: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
    }));
}

/**
 * Store an episode (session summary) after a turn.
 */
export async function storeEpisode(
  hyperdrive: Hyperdrive,
  episode: { session_id: string; input: string; output: string; agent_name: string },
): Promise<void> {
  // Session is already written by engine.ts writeSession — episodes are the sessions table.
  // This is a no-op for now since sessions table already captures input/output.
  // If you need a separate episodes table, add it here.
}

// ── Procedural Memory (learned tool sequences, Supabase) ──────

interface Procedure {
  name: string;
  description: string;
  steps: Array<{ tool: string; args_summary?: string }>;
  success_rate: number;
  success_count: number;
  failure_count: number;
}

/**
 * Find the best matching procedures for a task.
 * Scores by keyword overlap weighted by success rate.
 */
export async function findBestProcedures(
  hyperdrive: Hyperdrive,
  taskDescription: string,
  opts: { agent_name?: string; limit?: number },
): Promise<Procedure[]> {
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);
  const limit = opts.limit || 3;

  let rows: any[];
  try {
    rows = await sql`
      SELECT name, description, steps_json, success_count, failure_count, last_used
      FROM procedures
      WHERE success_count > 0
      ORDER BY (success_count::float / GREATEST(success_count + failure_count, 1)) DESC,
               last_used DESC
      LIMIT ${limit * 3}
    `;
  } catch {
    // Table may not exist yet
    return [];
  }

  const keywords = taskDescription.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (keywords.length === 0) return rows.slice(0, limit).map(mapProcedure);

  return rows
    .map((row: any) => {
      const text = `${row.name} ${row.description}`.toLowerCase();
      const overlap = keywords.filter((k) => text.includes(k)).length / keywords.length;
      const successRate = (row.success_count || 0) / Math.max(1, (row.success_count || 0) + (row.failure_count || 0));
      const score = overlap * (0.5 + 0.5 * successRate);
      return { ...row, _score: score };
    })
    .filter((r: any) => r._score > 0.1)
    .sort((a: any, b: any) => b._score - a._score)
    .slice(0, limit)
    .map(mapProcedure);
}

function mapProcedure(row: any): Procedure {
  let steps: any[] = [];
  try {
    steps = typeof row.steps_json === "string" ? JSON.parse(row.steps_json) : row.steps_json || [];
  } catch { steps = []; }
  const sc = Number(row.success_count) || 0;
  const fc = Number(row.failure_count) || 0;
  return {
    name: row.name || "",
    description: row.description || "",
    steps: Array.isArray(steps) ? steps : [],
    success_rate: sc / Math.max(1, sc + fc),
    success_count: sc,
    failure_count: fc,
  };
}

/**
 * Record the outcome of a procedure execution.
 */
export async function recordProcedureOutcome(
  hyperdrive: Hyperdrive,
  name: string,
  success: boolean,
): Promise<void> {
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);
  try {
    if (success) {
      await sql`
        UPDATE procedures SET success_count = success_count + 1, last_used = NOW()
        WHERE name = ${name}
      `;
    } else {
      await sql`
        UPDATE procedures SET failure_count = failure_count + 1, last_used = NOW()
        WHERE name = ${name}
      `;
    }
  } catch {
    // Table may not exist
  }
}

// ── Semantic Memory (facts, Vectorize + Supabase) ─────────────

interface MemoryFact {
  id: string;
  content: string;
  category: string;
  confidence: number;
  source: string;
}

/**
 * Search semantic facts using Vectorize (embedding similarity).
 * Falls back to keyword search if Vectorize unavailable.
 */
export async function searchFacts(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  query: string,
  opts: { agent_name?: string; org_id?: string; limit?: number },
): Promise<MemoryFact[]> {
  const limit = opts.limit || 5;

  // Try Vectorize first (embedding similarity)
  if (env.VECTORIZE && env.AI) {
    try {
      const embedResult = await env.AI.run("@cf/baai/bge-base-en-v1.5" as any, {
        text: [query],
      }) as any;
      const queryVec = embedResult.data?.[0];
      if (queryVec) {
        const filter: Record<string, string> = {};
        if (opts.agent_name) filter.agent_name = opts.agent_name;
        if (opts.org_id) filter.org_id = opts.org_id;

        const matches = await env.VECTORIZE.query(queryVec, {
          topK: limit,
          returnMetadata: "all",
          ...(Object.keys(filter).length > 0 ? { filter } : {}),
        });

        return (matches.matches || []).map((m: any) => ({
          id: m.id || "",
          content: m.metadata?.text || m.metadata?.content || "",
          category: m.metadata?.category || "knowledge",
          confidence: m.score || 0.5,
          source: m.metadata?.source || "",
        }));
      }
    } catch {
      // Vectorize failed, fall through to DB
    }
  }

  // Fallback: keyword search in memory_facts table
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);
  const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 3);
  if (keywords.length === 0) return [];

  try {
    const rows = await sql`
      SELECT id, content, category, confidence, source
      FROM memory_facts
      WHERE LOWER(content) LIKE ${`%${keywords[0]}%`}
        AND confidence >= 0.7
      ORDER BY confidence DESC, created_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r: any) => ({
      id: r.id || "",
      content: r.content || "",
      category: r.category || "context",
      confidence: Number(r.confidence) || 0.5,
      source: r.source || "",
    }));
  } catch {
    return [];
  }
}

/**
 * Store a fact in semantic memory (Vectorize + Supabase).
 */
export async function storeFact(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  fact: { content: string; category: string; confidence: number; source: string; agent_name?: string; org_id?: string },
): Promise<void> {
  const id = `fact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Store in Vectorize for embedding search
  if (env.VECTORIZE && env.AI) {
    try {
      const embedResult = await env.AI.run("@cf/baai/bge-base-en-v1.5" as any, {
        text: [fact.content],
      }) as any;
      const vec = embedResult.data?.[0];
      if (vec) {
        await env.VECTORIZE.upsert([{
          id,
          values: vec,
          metadata: {
            text: fact.content,
            category: fact.category,
            source: fact.source,
            agent_name: fact.agent_name || "",
            org_id: fact.org_id || "",
          },
        }]);
      }
    } catch {
      // Vectorize failed, still persist to DB
    }
  }

  // Store in Supabase for keyword search fallback
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);
  const contentHash = await hashContent(fact.content);
  try {
    await sql`
      INSERT INTO memory_facts (id, content, content_hash, category, confidence, source, created_at)
      VALUES (${id}, ${fact.content}, ${contentHash}, ${fact.category}, ${fact.confidence}, ${fact.source}, NOW())
      ON CONFLICT (content_hash) DO UPDATE SET
        confidence = GREATEST(memory_facts.confidence, EXCLUDED.confidence),
        source = EXCLUDED.source
    `;
  } catch {
    // Table may not exist yet — non-fatal
  }
}

// ── Async Fact Extraction (pattern-based) ─────────────────────

const FACT_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  // Preferences
  { pattern: /\bi (?:prefer|like|want|need|love|hate|dislike)\b/i, category: "preference" },
  { pattern: /\bmy (?:favorite|preferred)\b/i, category: "preference" },
  // Knowledge / identity
  { pattern: /\bmy name is\b/i, category: "knowledge" },
  { pattern: /\bi (?:work|am|live|study) (?:at|in|as)\b/i, category: "knowledge" },
  { pattern: /\bmy (?:email|phone|address|company|job|role|team)\b/i, category: "knowledge" },
  // Goals
  { pattern: /\bi(?:'m| am) (?:trying|working|looking|planning) to\b/i, category: "goal" },
  { pattern: /\bmy goal is\b/i, category: "goal" },
  { pattern: /\bi need to\b/i, category: "goal" },
  // Behavior
  { pattern: /\bi (?:usually|always|never|often|sometimes)\b/i, category: "behavior" },
];

/**
 * Extract facts from a user message using pattern matching.
 * Returns facts with category and confidence.
 * No LLM call required — fast, deterministic.
 */
export function extractFacts(
  userInput: string,
): Array<{ content: string; category: string; confidence: number }> {
  const facts: Array<{ content: string; category: string; confidence: number }> = [];
  const sentences = userInput.split(/[.!?\n]+/).filter((s) => s.trim().length > 5);

  for (const sentence of sentences) {
    for (const { pattern, category } of FACT_PATTERNS) {
      if (pattern.test(sentence)) {
        facts.push({
          content: sentence.trim(),
          category,
          confidence: 0.8,
        });
        break; // One category per sentence
      }
    }
  }

  return facts;
}

/**
 * Queue fact extraction + storage (non-blocking).
 * Called after each turn with the user's input.
 */
export function queueFactExtraction(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  userInput: string,
  sessionId: string,
  agentName: string,
  orgId: string,
): void {
  const facts = extractFacts(userInput);
  if (facts.length === 0) return;

  // Fire-and-forget: store each fact
  for (const fact of facts) {
    storeFact(env, hyperdrive, {
      content: fact.content,
      category: fact.category,
      confidence: fact.confidence,
      source: sessionId,
      agent_name: agentName,
      org_id: orgId,
    }).catch(() => {});
  }
}

// ── Build Memory Context (injected into system prompt) ────────

/**
 * Build the full memory context string for system prompt injection.
 * Called before every LLM call in the turn loop.
 *
 * Sections (in priority order):
 *   1. Working memory snapshot (current session state)
 *   2. Semantic facts (extracted knowledge)
 *   3. Episodic memory (relevant past interactions)
 *   4. Procedural memory (learned tool sequences)
 */
export async function buildMemoryContext(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  query: string,
  workingMemory: WorkingMemory,
  opts: { agent_name?: string; org_id?: string },
): Promise<string> {
  const sections: string[] = [];

  // 1. Working memory
  const snapshot = wmSnapshot(workingMemory);
  const wmKeys = Object.keys(snapshot);
  if (wmKeys.length > 0) {
    const wmLines = wmKeys.slice(0, 10).map((k) => `- ${k}: ${JSON.stringify(snapshot[k])}`);
    sections.push(`[Working Memory]\n${wmLines.join("\n")}`);
  }

  // 2-4: Fetch from Supabase/Vectorize in parallel
  const [facts, episodes, procedures] = await Promise.all([
    searchFacts(env, hyperdrive, query, { agent_name: opts.agent_name, org_id: opts.org_id, limit: 5 }).catch(() => []),
    searchEpisodes(hyperdrive, query, { agent_name: opts.agent_name, limit: 3 }).catch(() => []),
    findBestProcedures(hyperdrive, query, { agent_name: opts.agent_name, limit: 3 }).catch(() => []),
  ]);

  // 2. Semantic facts
  if (facts.length > 0) {
    const factLines = facts.map((f) => `- [${f.category}] ${f.content}`);
    sections.push(`[Known Facts]\n${factLines.join("\n")}`);
  }

  // 3. Episodic memory
  if (episodes.length > 0) {
    const epLines = episodes.map(
      (ep) => `- User asked: "${ep.input.slice(0, 100)}..." → Agent: "${ep.output.slice(0, 150)}..."`,
    );
    sections.push(`[Past Interactions]\n${epLines.join("\n")}`);
  }

  // 4. Procedural memory
  if (procedures.length > 0) {
    const procLines = procedures.map((p) => {
      const stepsStr = p.steps.slice(0, 5).map((s) => s.tool || "?").join(" → ");
      return `- ${p.name} (${Math.round(p.success_rate * 100)}% success): ${stepsStr}`;
    });
    sections.push(`[Learned Procedures]\n${procLines.join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : "";
}

// ── Helpers ───────────────────────────────────────────────────

async function hashContent(content: string): Promise<string> {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
