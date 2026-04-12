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
  // Phase 4.4: Deduplicate episodes by session_id before returning
  const seenIds = new Set<string>();
  return rows
    .map((row: any) => {
      const text = `${row.input} ${row.output}`.toLowerCase();
      const score = keywords.filter((k) => text.includes(k)).length / keywords.length;
      return { ...row, _score: score };
    })
    .filter((r: any) => {
      if (r._score <= 0.2) return false;
      // Deduplicate by session ID
      const id = r.id || "";
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    })
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
  usage_count: number;
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
      SELECT name, description, steps, usage_count, success_rate, updated_at
      FROM procedures
      WHERE usage_count > 0
      ORDER BY success_rate DESC,
               updated_at DESC
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
    steps = typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps || [];
  } catch { steps = []; }
  return {
    name: row.name || "",
    description: row.description || "",
    steps: Array.isArray(steps) ? steps : [],
    success_rate: Number(row.success_rate) || 0,
    usage_count: Number(row.usage_count) || 0,
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
  const now = new Date().toISOString();
  try {
    if (success) {
      await sql`
        UPDATE procedures SET
          usage_count = usage_count + 1,
          success_rate = (success_rate * usage_count + 1.0) / (usage_count + 1),
          updated_at = ${now}
        WHERE name = ${name}
      `;
    } else {
      await sql`
        UPDATE procedures SET
          usage_count = usage_count + 1,
          success_rate = (success_rate * usage_count) / (usage_count + 1),
          updated_at = ${now}
        WHERE name = ${name}
      `;
    }
  } catch {
    // Table may not exist
  }
}

/**
 * Phase 4.2: Store a learned procedure (tool sequence) from a successful session.
 * Deduplicates by name — if a procedure with the same name exists, updates its
 * success rate as a rolling average.
 */
export async function storeProcedure(
  hyperdrive: Hyperdrive,
  procedure: {
    name: string;
    description: string;
    agent_name: string;
    org_id: string;
    steps: Array<{ tool: string; args_summary?: string }>;
    source_session_id: string;
  },
): Promise<void> {
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);
  try {
    const stepsJson = JSON.stringify(procedure.steps);
    const toolSeq = JSON.stringify(procedure.steps.map(s => s.tool));
    const now = new Date().toISOString();
    await sql`
      INSERT INTO procedures (org_id, agent_name, name, task_pattern, description, steps, tool_sequence, usage_count, success_rate, updated_at)
      VALUES (${procedure.org_id}, ${procedure.agent_name}, ${procedure.name}, ${procedure.name}, ${procedure.description}, ${stepsJson}::jsonb, ${toolSeq}::jsonb, 1, 1.0, ${now})
      ON CONFLICT (org_id, agent_name, task_pattern) DO UPDATE SET
        steps = ${stepsJson}::jsonb,
        tool_sequence = ${toolSeq}::jsonb,
        usage_count = procedures.usage_count + 1,
        description = CASE WHEN LENGTH(${procedure.description}) > LENGTH(procedures.description) THEN ${procedure.description} ELSE procedures.description END,
        updated_at = ${now}
    `;
  } catch {
    // Table may not exist — best effort
  }
}

/**
 * Export high-confidence procedures as human-readable markdown.
 * Used for publishing procedural memory into workspace docs.
 */
export async function exportProceduresMarkdown(
  hyperdrive: Hyperdrive,
  opts: { agent_name: string; org_id: string; limit?: number },
): Promise<{ markdown: string; count: number }> {
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
  let rows: any[] = [];
  try {
    // Newer schema shape
    rows = await sql`
      SELECT
        name,
        description,
        steps,
        tool_sequence,
        success_rate,
        usage_count,
        success_count,
        failure_count,
        updated_at,
        last_used
      FROM procedures
      WHERE agent_name = ${opts.agent_name}
        AND org_id = ${opts.org_id}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
  } catch {
    try {
      // Backward-compatible fallback query
      rows = await sql`
        SELECT name, description, steps, usage_count, success_rate, updated_at
        FROM procedures
        WHERE agent_name = ${opts.agent_name}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
    } catch {
      return { markdown: "", count: 0 };
    }
  }
  if (!rows.length) return { markdown: "", count: 0 };

  const renderSteps = (row: any): string[] => {
    let arr: any[] = [];
    const candidates = [row.steps, row.tool_sequence];
    for (const raw of candidates) {
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed) && parsed.length > 0) {
          arr = parsed;
          break;
        }
      } catch {}
    }
    if (!Array.isArray(arr) || arr.length === 0) return [];
    return arr.slice(0, 12).map((step: any, i: number) => {
      const tool = String(step?.tool || step?.name || step || "").trim();
      const args = String(step?.args_summary || step?.args || "").trim();
      return `${i + 1}. ${tool || "step"}${args ? ` — ${args}` : ""}`;
    });
  };

  const out: string[] = [];
  out.push(`# PROCEDURES (procedural memory)`);
  out.push("");
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push(`Agent: ${opts.agent_name}`);
  out.push("");

  for (const r of rows) {
    const sc = Number(r.success_count || 0);
    const fc = Number(r.failure_count || 0);
    const sr = Number.isFinite(Number(r.success_rate))
      ? Number(r.success_rate)
      : sc / Math.max(1, sc + fc);
    const usage = Number(r.usage_count || sc + fc || 0);
    const steps = renderSteps(r);
    out.push(`## ${String(r.name || "Unnamed procedure")}`);
    out.push(`- Success rate: ${Math.round(sr * 100)}%`);
    out.push(`- Usage: ${usage}`);
    if (r.description) out.push(`- Notes: ${String(r.description).trim()}`);
    if (steps.length > 0) {
      out.push("");
      out.push(`### Steps`);
      out.push(...steps);
    }
    out.push("");
  }

  return { markdown: out.join("\n").trim() + "\n", count: rows.length };
}

// ── Semantic Memory (facts, Vectorize + Supabase) ─────────────

interface MemoryFact {
  id: string;
  content: string;
  category: string;
  confidence: number;
  source: string;
  /** Unix ms when known (DB / curated facts); Vectorize hits may omit */
  created_at?: number;
  /** Unix ms — last time this fact was reinforced by a session. Defaults to created_at. */
  last_reinforced_at?: number;
  /** Session IDs that contributed to or reinforced this fact. */
  source_session_ids?: string[];
  /** Normalized entity names this fact relates to (people, projects, services). */
  entities?: string[];
}

/**
 * Compute effective confidence after time-based decay.
 * Pure function — no DB writes. Used by buildMemoryContext for ranking
 * and by the /memory-consolidate skill for archival decisions.
 */
export function effectiveConfidence(confidence: number, lastReinforcedAtMs: number): number {
  const days = Math.max(0, (Date.now() - lastReinforcedAtMs) / 86_400_000);
  if (days <= 7) return confidence;
  if (days <= 30) return confidence * 0.9;
  if (days <= 90) return confidence * 0.7;
  if (days <= 180) return confidence * 0.5;
  return 0; // archive threshold
}

/** Staleness hint for injected memories (>1 day old), Claude Code–style. */
export function memoryFreshnessNote(createdAtMs: number): string {
  const dayMs = 86_400_000;
  const ageDays = Math.max(0, Math.floor((Date.now() - createdAtMs) / dayMs));
  if (ageDays <= 1) return "";
  return ` (memory is ~${ageDays} days old — verify against current state before treating as live fact)`;
}

/**
 * Curated facts from `semantic_facts` (memory-save tool). These were not previously
 * merged into prompt injection; we combine them with Vectorize/keyword facts.
 */
async function fetchCuratedSemanticFacts(
  hyperdrive: Hyperdrive,
  query: string,
  opts: { agent_name?: string; org_id?: string; limit?: number },
): Promise<MemoryFact[]> {
  const { getDb } = await import("./db");
  const sql = await getDb(hyperdrive);
  const limit = Math.min(20, Math.max(1, opts.limit || 12));
  const agent = opts.agent_name || "";
  const org = opts.org_id || "";
  const q = query.trim();
  const kw = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 4);
  try {
    let rows: any[] = [];
    if (kw.length > 0) {
      const p0 = `%${kw[0]}%`;
      rows = await sql`
        SELECT key, value, category, created_at, last_reinforced_at, source_session_ids, entities
        FROM facts
        WHERE agent_name = ${agent} AND org_id = ${org}
          AND (LOWER(key) LIKE ${p0} OR LOWER(value) LIKE ${p0})
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    }
    if (rows.length === 0) {
      rows = await sql`
        SELECT key, value, category, created_at, last_reinforced_at, source_session_ids, entities
        FROM facts
        WHERE agent_name = ${agent} AND org_id = ${org}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    }
    return rows.map((r: any) => {
      const ts = r.created_at ? new Date(r.created_at).getTime() : Date.now();
      const reinforcedTs = r.last_reinforced_at ? new Date(r.last_reinforced_at).getTime() : ts;
      const line = `${r.key || "fact"}: ${r.value || ""}`.trim();
      return {
        id: `semantic-${r.key || ts}`,
        content: line,
        category: r.category || "reference",
        confidence: 0.95,
        source: "facts",
        created_at: ts,
        last_reinforced_at: reinforcedTs,
        source_session_ids: r.source_session_ids || [],
        entities: r.entities || [],
      };
    });
  } catch {
    return [];
  }
}

function mergeMemoryFacts(primary: MemoryFact[], secondary: MemoryFact[]): MemoryFact[] {
  const seen = new Set<string>();
  const out: MemoryFact[] = [];
  const norm = (f: MemoryFact) => f.content.toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  for (const f of [...primary, ...secondary]) {
    const k = norm(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
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
  if (env.VECTORIZE) {
    try {
      const { embedForQuery } = await import("./embeddings");
      const embResult = await embedForQuery(query, env);
      const queryVec = embResult.vector;
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
          created_at: undefined,
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
      SELECT id, content, category, confidence, source, created_at
      FROM facts
      WHERE LOWER(content) LIKE ${`%${keywords[0]}%`}
        AND confidence >= 0.7
      ORDER BY confidence DESC, created_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r: any) => ({
      id: String(r.id || ""),
      content: r.content || "",
      category: r.category || "context",
      confidence: Number(r.confidence) || 0.5,
      source: r.source || "",
      created_at: r.created_at ? new Date(r.created_at).getTime() : undefined,
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
  if (env.VECTORIZE) {
    try {
      const { embedSingle } = await import("./embeddings");
      const embResult = await embedSingle(fact.content, env);
      const vec = embResult.vector;
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
  const now = new Date().toISOString();
  try {
    await sql`
      INSERT INTO facts (id, org_id, agent_name, content, category, confidence, source, created_at, updated_at)
      VALUES (${id}, ${fact.org_id || ""}, ${fact.agent_name || ""}, ${fact.content}, ${fact.category}, ${fact.confidence}, ${fact.source}, ${now}, ${now})
      ON CONFLICT (org_id, content) WHERE scope = 'team' DO UPDATE SET
        confidence = GREATEST(facts.confidence, EXCLUDED.confidence),
        source = EXCLUDED.source,
        updated_at = ${now}
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

/**
 * Deterministic session note (episodic) after substantive runs — no extra LLM.
 * Mirrors Claude Code “session memory” in spirit: future recall can find this session.
 */
export function queueSessionEpisodicNote(
  hyperdrive: Hyperdrive | undefined,
  p: {
    sessionId: string;
    agentName: string;
    orgId: string;
    userInput: string;
    assistantOutput: string;
    toolNames: string[];
    turnsUsed: number;
    toolCallCount: number;
  },
): void {
  if (!hyperdrive || !p.assistantOutput.trim()) return;
  if (p.toolCallCount < 3 && p.turnsUsed < 3) return;

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const uniqTools = [...new Set(p.toolNames)].slice(0, 25);
  const content =
    `[Session summary] ${new Date().toISOString().slice(0, 10)} — ` +
    `User request: ${p.userInput.slice(0, 280)}${p.userInput.length > 280 ? "…" : ""} | ` +
    `Tools: ${uniqTools.join(", ") || "(none)"} | ` +
    `Outcome: ${p.assistantOutput.slice(0, 450)}${p.assistantOutput.length > 450 ? "…" : ""}`;

  void (async () => {
    try {
      const { getDb } = await import("./db");
      const sql = await getDb(hyperdrive);
      const now = new Date().toISOString();
      await sql`
        INSERT INTO episodes (id, agent_name, org_id, content, source, metadata, created_at)
        VALUES (${id}, ${p.agentName}, ${p.orgId || ""}, ${content}, 'session_auto', ${JSON.stringify({ session_id: p.sessionId })}, ${now})
      `;
    } catch {
      /* non-fatal */
    }
  })();
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
/**
 * Build memory context for injection into system prompt.
 *
 * Phase 4.3: Token budgeting — each section gets a proportional allocation
 * of the maxChars budget. Prevents memory from overflowing the context window.
 *
 * Budget allocation:
 *   Working memory: 20% (most recent, highest priority)
 *   Facts: 30% (factual knowledge)
 *   Episodes: 30% (past interactions)
 *   Procedures: 20% (learned sequences)
 */
export async function buildMemoryContext(
  env: RuntimeEnv,
  hyperdrive: Hyperdrive,
  query: string,
  workingMemory: WorkingMemory,
  opts: { agent_name?: string; org_id?: string; maxChars?: number },
): Promise<string> {
  const maxChars = opts.maxChars || 4000;
  const sections: string[] = [];
  let remaining = maxChars;

  // Helper: truncate section to budget, preserving complete lines
  function truncateSection(text: string, budget: number): string {
    if (text.length <= budget) return text;
    const truncated = text.slice(0, budget);
    const lastNewline = truncated.lastIndexOf("\n");
    return (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) + "\n[...truncated]";
  }

  // 1. Working memory (20% budget)
  const wmBudget = Math.floor(maxChars * 0.2);
  const snapshot = wmSnapshot(workingMemory);
  const wmKeys = Object.keys(snapshot);
  if (wmKeys.length > 0) {
    const wmLines = wmKeys.slice(0, 10).map((k) => `- ${k}: ${JSON.stringify(snapshot[k])}`);
    const wmSection = `[Working Memory]\n${wmLines.join("\n")}`;
    const truncated = truncateSection(wmSection, wmBudget);
    sections.push(truncated);
    remaining -= truncated.length;
  }

  // 2-4: Fetch from Supabase/Vectorize + curated semantic_facts in parallel
  const [rawFacts, curatedFacts, episodes, procedures] = await Promise.all([
    searchFacts(env, hyperdrive, query, { agent_name: opts.agent_name, org_id: opts.org_id, limit: 5 }).catch(() => []),
    fetchCuratedSemanticFacts(hyperdrive, query, {
      agent_name: opts.agent_name,
      org_id: opts.org_id,
      limit: 12,
    }).catch(() => []),
    searchEpisodes(hyperdrive, query, { agent_name: opts.agent_name, limit: 3 }).catch(() => []),
    findBestProcedures(hyperdrive, query, { agent_name: opts.agent_name, limit: 3 }).catch(() => []),
  ]);
  const mergedFacts = mergeMemoryFacts(rawFacts, curatedFacts);

  // Rank by effective confidence BEFORE truncation so high-quality facts aren't hidden
  const facts = mergedFacts
    .map(f => ({ ...f, effConf: effectiveConfidence(f.confidence, f.last_reinforced_at ?? f.created_at ?? Date.now()) }))
    .filter(f => f.effConf > 0.1)
    .sort((a, b) => b.effConf - a.effConf)
    .slice(0, 8);

  // Redistribute remaining budget across non-empty sections
  const activeSections = [facts.length > 0, episodes.length > 0, procedures.length > 0].filter(Boolean).length;
  const perSectionBudget = activeSections > 0 ? Math.floor(remaining / activeSections) : 0;

  // 2. Semantic facts
  if (facts.length > 0) {
    const factLines = facts.map((f) => {
      const age = f.created_at != null ? memoryFreshnessNote(f.created_at) : "";
      return `- [${f.category}] ${f.content}${age}`;
    });
    const factSection = `[Known Facts]\n${factLines.join("\n")}`;
    sections.push(truncateSection(factSection, perSectionBudget));
  }

  // 3. Episodic memory
  if (episodes.length > 0) {
    const epLines = episodes.map((ep) => {
      const age = memoryFreshnessNote(ep.created_at);
      return `- User asked: "${ep.input.slice(0, 100)}..." → Agent: "${ep.output.slice(0, 150)}..."${age}`;
    });
    const epSection = `[Past Interactions]\n${epLines.join("\n")}`;
    sections.push(truncateSection(epSection, perSectionBudget));
  }

  // 4. Procedural memory
  if (procedures.length > 0) {
    const procLines = procedures.map((p) => {
      const stepsStr = p.steps.slice(0, 5).map((s) => s.tool || "?").join(" → ");
      return `- ${p.name} (${Math.round(p.success_rate * 100)}% success): ${stepsStr}`;
    });
    const procSection = `[Learned Procedures]\n${procLines.join("\n")}`;
    sections.push(truncateSection(procSection, perSectionBudget));
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
