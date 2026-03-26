/**
 * Edge Runtime — tool executor.
 *
 * Dispatches tool calls to CF bindings directly (no HTTP hop to /cf/tool/exec).
 * Same tool set as the worker's /cf/tool/exec switch, but callable in-process.
 */

import { getSandbox } from "@cloudflare/sandbox";
import type { ToolCall, ToolResult, ToolDefinition, RuntimeEnv } from "./types";

/**
 * Tool cost model — combines per-invocation fees + duration-based compute.
 *
 * Two cost components:
 *   1. flat_usd — per-call cost (API fees, external services)
 *   2. per_ms_usd — duration-based cost (compute time)
 *
 * Total: flat_usd + (latency_ms * per_ms_usd)
 *
 * Pricing sources:
 *   - Brave Search: $5/1K requests
 *   - CF Browser Rendering: ~$0.005/page render
 *   - CF Sandbox containers: ~$0.000025/GB-s ≈ $0.0000125/s for 512MB
 *   - CF Dynamic Workers: ~$0.000012/ms CPU (Workers Paid)
 *   - Workers AI: per-token pricing (handled separately in LLM layer)
 *   - Vectorize: $0.01/1K queries, $0.005/1K mutations
 *   - R2: $0.0036/1K writes, $0.00036/1K reads
 */
interface ToolCostModel {
  flat_usd: number;    // Per-invocation fee
  per_ms_usd: number;  // Duration-based compute cost per millisecond
}

const TOOL_COSTS: Record<string, ToolCostModel> = {
  // Search & web (external API flat fees)
  "web-search":        { flat_usd: 0.005,    per_ms_usd: 0 },          // Brave: $5/1K
  "web-crawl":         { flat_usd: 0.005,    per_ms_usd: 0 },          // Browser Rendering
  "browser-render":    { flat_usd: 0.005,    per_ms_usd: 0 },          // Browser Rendering

  // Multimodal (Workers AI per-request)
  "image-generate":    { flat_usd: 0.001,    per_ms_usd: 0 },
  "text-to-speech":    { flat_usd: 0.001,    per_ms_usd: 0 },
  "speech-to-text":    { flat_usd: 0.001,    per_ms_usd: 0 },

  // Knowledge (embedding + vector ops)
  "knowledge-search":  { flat_usd: 0.0002,   per_ms_usd: 0 },          // Embedding + query
  "store-knowledge":   { flat_usd: 0.0002,   per_ms_usd: 0 },          // Embedding + upsert

  // R2 persistence
  "save-project":      { flat_usd: 0.001,    per_ms_usd: 0 },          // R2 PUTs
  "load-project":      { flat_usd: 0.0005,   per_ms_usd: 0 },          // R2 GET

  // Sandbox containers (duration-based compute)
  "bash":              { flat_usd: 0,         per_ms_usd: 0.0000125 },  // ~$0.0125/s container
  "python-exec":       { flat_usd: 0,         per_ms_usd: 0.0000125 },  // ~$0.0125/s container

  // V8 isolates (lighter compute)
  "dynamic-exec":      { flat_usd: 0,         per_ms_usd: 0.000012 },   // ~$0.012/s isolate
  "execute-code":      { flat_usd: 0,         per_ms_usd: 0.000012 },   // Codemode isolate

  // File ops (sandbox exec + R2 sync)
  "write-file":        { flat_usd: 0.0000045, per_ms_usd: 0 },          // R2 Class A PUT ($4.50/M)
  "edit-file":         { flat_usd: 0.0000045, per_ms_usd: 0 },          // R2 Class A PUT ($4.50/M)
  "read-file":         { flat_usd: 0,         per_ms_usd: 0 },          // Sandbox only
  "grep":              { flat_usd: 0,         per_ms_usd: 0.0000125 },  // Container exec
  "glob":              { flat_usd: 0,         per_ms_usd: 0.0000125 },  // Container exec
};

/** Calculate tool cost from flat fee + duration. */
function calculateToolCost(toolName: string, latencyMs: number): number {
  const model = TOOL_COSTS[toolName];
  if (!model) return 0;
  return model.flat_usd + (latencyMs * model.per_ms_usd);
}

/**
 * Infrastructure cost rates for CF primitives.
 * Used by the engine to calculate per-session overhead costs.
 *
 * These are NOT per-tool — they're per-session/per-query infrastructure costs
 * that accumulate during a run and get added to the session total.
 */
export const INFRA_COSTS = {
  // Durable Objects: $0.15/million requests + $12.50/million GB-s duration
  // Math: $12.50/1M GB-s × 0.256GB = $0.0000032/s = $0.0000000032/ms
  do_request_usd: 0.00000015,            // Per DO request ($0.15/million)
  do_duration_per_ms_usd: 0.0000000032,  // Per ms @ 256MB ($12.50/M GB-s)

  // Hyperdrive: $0.05/million queries (estimated, not officially published)
  hyperdrive_query_usd: 0.00000005,      // Per query

  // Queue: $0.40/million operations
  queue_message_usd: 0.0000004,          // Per message

  // DO SQLite: $0.001/million rows read, $1.00/million rows written
  do_sql_read_usd: 0.000000001,          // Per row read ($0.001/M)
  do_sql_write_usd: 0.000001,            // Per row written ($1.00/M) ← 1000x fix

  // Vectorize: $0.01/million queried dimensions, $0.05/100M stored dimensions
  // Per query with 768-dim embedding: $0.01/1M × 768 = $0.00000768
  vectorize_query_usd: 0.0000077,        // Per query (768-dim)
  vectorize_mutation_usd: 0.0000004,     // Per upsert (768 dims × $0.05/100M)

  // Supabase: Per-query amortized from Pro plan ($25/month base)
  supabase_query_usd: 0.00001,           // Per DB query
  supabase_write_usd: 0.00002,           // Per DB write

  // R2: $4.50/million Class A (writes), $0.36/million Class B (reads)
  r2_write_usd: 0.0000045,              // Per write ($4.50/M)
  r2_read_usd: 0.00000036,              // Per read ($0.36/M)
};

/**
 * Calculate infrastructure overhead cost for a completed session.
 *
 * This accounts for CF primitives that aren't per-tool:
 *   - DO wall clock time
 *   - Hyperdrive queries (config load, session/turn/event writes)
 *   - Queue messages (telemetry events)
 *   - DO SQLite operations (conversation history)
 *   - Supabase writes (session, turns, events, billing)
 *   - Vectorize queries (memory search per turn)
 */
export function calculateInfraCost(session: {
  wall_clock_ms: number;
  turns: number;
  tool_calls: number;
  events_count: number;
  had_memory_search: boolean;
  had_file_writes: boolean;
}): {
  total_usd: number;
  breakdown: Record<string, number>;
} {
  const c = INFRA_COSTS;

  // DO: 1 request + wall clock duration
  const doCost = c.do_request_usd + (session.wall_clock_ms * c.do_duration_per_ms_usd);

  // Hyperdrive: config load (1) + session write (1) + turn writes + event writes + billing (1)
  const dbQueries = 1; // config load
  const dbWrites = 1 + session.turns + session.events_count + 1; // session + turns + events + billing
  const hyperCost = (dbQueries * c.hyperdrive_query_usd) + (dbWrites * c.hyperdrive_query_usd);

  // Supabase: same queries via Hyperdrive
  const supabaseCost = (dbQueries * c.supabase_query_usd) + (dbWrites * c.supabase_write_usd);

  // Queue: 1 message per event
  const queueCost = session.events_count * c.queue_message_usd;

  // DO SQLite: conversation history reads/writes (2 per message — read history + write new)
  const sqlCost = (session.turns * 2 * c.do_sql_read_usd) + (session.turns * 2 * c.do_sql_write_usd);

  // Vectorize: memory search per turn (if enabled)
  const vecCost = session.had_memory_search
    ? session.turns * c.vectorize_query_usd
    : 0;

  // R2: per-file sync writes (if any file operations)
  const r2Cost = session.had_file_writes ? session.tool_calls * c.r2_write_usd : 0;

  const total = doCost + hyperCost + supabaseCost + queueCost + sqlCost + vecCost + r2Cost;

  return {
    total_usd: total,
    breakdown: {
      durable_object: doCost,
      hyperdrive: hyperCost,
      supabase: supabaseCost,
      queue: queueCost,
      do_sqlite: sqlCost,
      vectorize: vecCost,
      r2: r2Cost,
    },
  };
}

/**
 * Execute tool calls — parallel when safe, sequential for sandbox-stateful ops.
 */
export async function executeTools(
  env: RuntimeEnv,
  toolCalls: ToolCall[],
  sessionId: string,
  parallel: boolean = true,
): Promise<ToolResult[]> {
  if (parallel && toolCalls.length > 1) {
    return Promise.all(
      toolCalls.map((tc) => executeSingleTool(env, tc, sessionId)),
    );
  }
  const results: ToolResult[] = [];
  for (const tc of toolCalls) {
    results.push(await executeSingleTool(env, tc, sessionId));
  }
  return results;
}

async function executeSingleTool(
  env: RuntimeEnv,
  tc: ToolCall,
  sessionId: string,
): Promise<ToolResult> {
  const started = Date.now();
  let args: Record<string, any>;
  try {
    args = JSON.parse(tc.arguments || "{}");
  } catch {
    return {
      tool: tc.name,
      tool_call_id: tc.id,
      result: "",
      error: `Invalid JSON arguments: ${tc.arguments?.slice(0, 100)}`,
      latency_ms: Date.now() - started,
    };
  }

  try {
    const result = await dispatch(env, tc.name, args, sessionId);
    const latencyMs = Date.now() - started;
    return {
      tool: tc.name,
      tool_call_id: tc.id,
      result: typeof result === "string" ? result : JSON.stringify(result),
      latency_ms: latencyMs,
      cost_usd: calculateToolCost(tc.name, latencyMs),
    };
  } catch (err: any) {
    const latencyMs = Date.now() - started;
    return {
      tool: tc.name,
      tool_call_id: tc.id,
      result: "",
      error: err.message || String(err),
      latency_ms: latencyMs,
      cost_usd: calculateToolCost(tc.name, latencyMs), // Still charge for compute even on error
    };
  }
}

async function dispatch(
  env: RuntimeEnv,
  tool: string,
  args: Record<string, any>,
  sessionId: string,
): Promise<string> {
  switch (tool) {
    case "web-search":
      return braveSearch(env, args);

    case "browse":
      return browse(args);

    case "http-request":
      return httpRequest(args);

    case "bash":
      return sandboxExec(env, args.command || "", sessionId, args.timeout_seconds);

    case "python-exec": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const tmpFile = `/tmp/exec_${Date.now()}.py`;
      await sandbox.writeFile(tmpFile, args.code || "");
      const r = await sandbox.exec(`python3 ${tmpFile}`, {
        timeout: Math.min(args.timeout_seconds || 30, 120),
      });
      return JSON.stringify({ stdout: r.stdout || "", stderr: r.stderr || "", exit_code: r.exitCode ?? 0 });
    }

    case "read-file": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      let readPath = args.path || "";
      if (readPath && !readPath.startsWith("/")) readPath = `/workspace/${readPath}`;
      const r = await sandbox.exec(`cat -n "${readPath}" 2>&1 | head -2000`, { timeout: 10 });
      return r.stdout || r.stderr || "File not found or empty";
    }

    case "write-file": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      // Enforce safe default path — always resolve to /workspace/
      let filePath = args.path || "output.txt";
      if (!filePath.startsWith("/")) filePath = `/workspace/${filePath}`;
      if (!filePath.startsWith("/workspace") && !filePath.startsWith("/tmp")) filePath = `/workspace/${filePath.replace(/^\/+/, "")}`;
      // Ensure parent dir exists
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      if (dir) await sandbox.exec(`mkdir -p "${dir}"`, { timeout: 5 }).catch(() => {});
      await sandbox.writeFile(filePath, args.content || "");

      // Per-file sync to R2 for durability (non-blocking)
      if (filePath.startsWith("/workspace/") && env.STORAGE) {
        import("./workspace").then(({ syncFileToR2 }) =>
          syncFileToR2(env.STORAGE, args.org_id || "default", args.agent_name || "agent", filePath, args.content || "", sessionId),
        ).catch(() => {});
      }

      return `Written ${(args.content || "").length} bytes to ${filePath}`;
    }

    case "edit-file": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const read = await sandbox.exec(`cat "${args.path}"`, { timeout: 10 });
      const content = read.stdout || "";
      const oldText = args.old_text || args.old_string || "";
      if (!content.includes(oldText)) return `Error: old_text not found in ${args.path}`;
      const newContent = content.replace(oldText, args.new_text || args.new_string || "");
      await sandbox.writeFile(args.path, newContent);

      // Sync edited file to R2 (non-blocking)
      const editPath = args.path || "";
      if (editPath.startsWith("/workspace/") && env.STORAGE) {
        import("./workspace").then(({ syncFileToR2 }) =>
          syncFileToR2(env.STORAGE, args.org_id || "default", args.agent_name || "agent", editPath, newContent, sessionId),
        ).catch(() => {});
      }

      return `Edited ${args.path}: replaced ${oldText.length} chars`;
    }

    case "grep": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const r = await sandbox.exec(
        `grep -rn "${(args.pattern || "").replace(/"/g, '\\"')}" "${args.path || "."}" | head -${args.max_results || 20}`,
        { timeout: 15 },
      );
      return r.stdout || "No matches found";
    }

    case "glob": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const r = await sandbox.exec(
        `find "${args.path || "."}" -name "${(args.pattern || "*").replace(/"/g, '\\"')}" -type f | head -50`,
        { timeout: 10 },
      );
      return r.stdout || "No files found";
    }

    case "knowledge-search":
      return knowledgeSearch(env, args);

    case "store-knowledge":
      return storeKnowledge(env, args);

    case "image-generate":
      return imageGenerate(env, args);

    case "text-to-speech":
      return textToSpeech(env, args);

    case "speech-to-text":
      return speechToText(env, args, sessionId);

    case "sandbox_exec":
    case "sandbox-exec":
      return sandboxExec(env, args.command || "", sessionId, args.timeout);

    case "sandbox_file_write":
    case "sandbox-file-write": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      await sandbox.writeFile(args.path || "/tmp/file", args.content || "");
      return `Written to ${args.path}`;
    }

    case "sandbox_file_read":
    case "sandbox-file-read": {
      const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
      const r = await sandbox.exec(`cat "${args.path || "/tmp/file"}"`, { timeout: 10 });
      return r.stdout || "";
    }

    case "dynamic-exec":
      return dynamicExec(env, args, sessionId);

    case "web-crawl":
      return webCrawl(env, args);

    case "browser-render":
      return browserRender(env, args);

    case "a2a-send": {
      const targetUrl = args.url || "";
      const task = args.task || args.message || "";
      const resp = await fetch(`${targetUrl}/tasks/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "tasks/send", id: crypto.randomUUID(),
          params: { message: { role: "user", parts: [{ type: "text", text: task }] } },
        }),
      });
      return await resp.text();
    }

    case "save-project":
      return saveProject(env, args, sessionId);

    case "load-project":
      return loadProject(env, args, sessionId);

    case "list-project-versions":
      return listProjectVersions(env, args);

    case "todo":
      return todoTool(env, args, sessionId);

    case "connector": {
      // Connector tool — reads OAuth tokens from Supabase, calls Pipedream API
      const { executeConnector } = await import("./connectors");
      const connectorName = args.connector_name || args.tool_name || "";
      const orgId = args.org_id || "";
      if (!connectorName) return "connector requires connector_name";
      return executeConnector(
        (env as any).HYPERDRIVE, orgId, connectorName,
        args.tool_name || connectorName, args.arguments || args,
      );
    }

    case "discover-api": {
      // Returns TypeScript type definitions for all available tools
      const { getToolTypeDefinitions } = await import("./codemode");
      const allTools = getToolDefinitions([]);
      return getToolTypeDefinitions(allTools);
    }

    case "execute-code": {
      // Run LLM-generated JS in sandboxed Dynamic Worker with tool access via RPC
      const { executeCode } = await import("./codemode");
      const allTools = getToolDefinitions([]);
      // Filter out discover-api and execute-code to prevent recursion
      const executableTools = allTools.filter(
        (t) => t.function.name !== "discover-api" && t.function.name !== "execute-code",
      );
      const result = await executeCode(env, args.code || "", executableTools, sessionId);
      if (result.error) return JSON.stringify({ error: result.error, logs: result.logs });
      return typeof result.result === "string"
        ? result.result
        : JSON.stringify({ result: result.result, logs: result.logs });
    }

    default:
      throw new Error(`Tool '${tool}' not available on edge runtime`);
  }
}

// ── Web Search (Brave Search via AI Gateway) ─────────────────
//
// Route: Worker → AI Gateway (custom-brave) → Brave Search API
// Auth: X-Subscription-Token from worker secret, cf-aig-authorization for gateway
// Gateway provides: logging, caching, rate limiting, analytics

async function braveSearch(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const query = args.query || "";
  const maxResults = args.max_results || 5;
  const braveKey = (env as any).BRAVE_SEARCH_KEY || "";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  const gatewayId = env.AI_GATEWAY_ID || "";

  if (!braveKey) {
    // Fallback to DuckDuckGo if no Brave key
    return duckDuckGoSearch(query, maxResults);
  }

  // Route through AI Gateway for logging/caching
  const baseUrl = accountId && gatewayId
    ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/custom-brave`
    : "https://api.search.brave.com";

  const headers: Record<string, string> = {
    "X-Subscription-Token": braveKey,
    "Accept": "application/json",
  };
  if (accountId && gatewayId && env.AI_GATEWAY_TOKEN) {
    headers["cf-aig-authorization"] = `Bearer ${env.AI_GATEWAY_TOKEN}`;
  }

  try {
    const resp = await fetch(
      `${baseUrl}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
      { headers },
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[web-search] Brave failed ${resp.status}: ${errText.slice(0, 100)}`);
      return duckDuckGoSearch(query, maxResults);
    }

    const data = await resp.json() as any;
    const results = data.web?.results || [];

    if (results.length === 0) return `No results found for: ${query}`;

    return results.slice(0, maxResults).map((r: any, i: number) =>
      `${i + 1}. ${r.title || "Untitled"}\n   ${r.url || ""}\n   ${(r.description || "").replace(/<[^>]+>/g, "").slice(0, 200)}`,
    ).join("\n\n");
  } catch (err: any) {
    console.error(`[web-search] Brave error: ${err.message}`);
    return duckDuckGoSearch(query, maxResults);
  }
}

// DuckDuckGo fallback (no API key needed)
async function duckDuckGoSearch(query: string, maxResults: number): Promise<string> {
  const resp = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "AgentOS/0.2.0" },
    body: `q=${encodeURIComponent(query)}`,
  });
  const html = await resp.text();
  const linkRe = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.*?)<\/a>/g;
  const snippetRe = /<a class="result__snippet"[^>]*>(.*?)<\/a>/gs;
  const links: [string, string][] = [];
  let m;
  while ((m = linkRe.exec(html)) && links.length < maxResults) {
    links.push([m[1], m[2].replace(/<[^>]+>/g, "").trim()]);
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) && snippets.length < maxResults) {
    snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
  }
  return links.map(([url, title], i) =>
    `${i + 1}. ${title}\n   ${url}\n   ${snippets[i] || ""}`,
  ).join("\n\n") || `No results found for: ${query}`;
}

// ── Browse (simple HTTP fetch) ────────────────────────────────

async function browse(args: Record<string, any>): Promise<string> {
  const resp = await fetch(args.url || "", {
    headers: { "User-Agent": "AgentOS/0.2.0" },
    redirect: "follow",
  });
  const html = await resp.text();
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10000) || "Empty page";
}

// ── HTTP Request ──────────────────────────────────────────────

async function httpRequest(args: Record<string, any>): Promise<string> {
  const method = (args.method || "GET").toUpperCase();
  const timeout = args.timeout_seconds || 30;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const resp = await fetch(args.url || "", {
      method,
      headers: args.headers || {},
      ...(method !== "GET" && method !== "HEAD" && args.body ? { body: args.body } : {}),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await resp.text();
    return JSON.stringify({
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      body: body.slice(0, 10000),
    });
  } catch (err: any) {
    clearTimeout(timer);
    return JSON.stringify({ error: err.message });
  }
}

// ── Sandbox Exec ──────────────────────────────────────────────

async function sandboxExec(
  env: RuntimeEnv,
  command: string,
  sessionId: string,
  timeoutSeconds?: number,
): Promise<string> {
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
  const r = await sandbox.exec(command, {
    timeout: Math.min(timeoutSeconds || 30, 120),
  });
  return JSON.stringify({
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    exit_code: r.exitCode ?? 0,
  });
}

// ── Knowledge Search (Vectorize) ──────────────────────────────

async function knowledgeSearch(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const query = args.query || "";
  const topK = args.top_k || 5;
  const embedResult = (await env.AI.run("@cf/baai/bge-base-en-v1.5" as keyof AiModels, {
    text: [query],
  })) as any;
  const queryVec = embedResult.data?.[0];
  if (!queryVec) return "Embedding failed";
  const matches = await env.VECTORIZE.query(queryVec, {
    topK,
    returnMetadata: "all",
    ...(args.agent_name ? { filter: { agent_name: args.agent_name } } : {}),
  });
  const results = (matches.matches || []).map((m: any) => ({
    score: m.score,
    text: m.metadata?.text || "",
    source: m.metadata?.source || "",
  }));
  return results.length > 0
    ? results.map((r: any, i: number) => `${i + 1}. [${r.source}] ${r.text.slice(0, 200)}`).join("\n\n")
    : `No relevant knowledge found for: ${query}`;
}

// ── Store Knowledge (Vectorize + R2) ──────────────────────────

async function storeKnowledge(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const text = args.content || args.text || "";
  const key = args.key || "knowledge";
  const embedResult = (await env.AI.run("@cf/baai/bge-base-en-v1.5" as keyof AiModels, {
    text: [text],
  })) as any;
  const vec = embedResult.data?.[0];
  if (vec) {
    await env.VECTORIZE.upsert([
      {
        id: `knowledge-${Date.now()}`,
        values: vec,
        metadata: {
          text,
          source: key,
          agent_name: args.agent_name || "",
          org_id: args.org_id || "",
        },
      },
    ]);
  }
  return `Stored knowledge: '${key}' (${text.length} chars)`;
}

// ── Image Generate (Workers AI FLUX) ──────────────────────────

async function imageGenerate(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const prompt = args.prompt || "";
  const aiResult = (await env.AI.run("@cf/bfl/flux-2-klein-4b" as keyof AiModels, { prompt })) as
    | ReadableStream
    | ArrayBuffer;
  const buf =
    aiResult instanceof ArrayBuffer ? aiResult : await new Response(aiResult).arrayBuffer();
  const key = `images/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  await env.STORAGE.put(key, buf, { customMetadata: { prompt } });
  return JSON.stringify({
    image_key: key,
    format: "png",
    size_bytes: buf.byteLength,
    model: "@cf/bfl/flux-2-klein-4b",
  });
}

// ── TTS (Workers AI Deepgram) ─────────────────────────────────

async function textToSpeech(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const text = args.text || "";
  const audioRaw = await env.AI.run("@cf/deepgram/aura-2-en" as keyof AiModels, { text }) as
    | ArrayBuffer
    | Uint8Array
    | ReadableStream
    | string;
  const audioBuffer = audioRaw instanceof ArrayBuffer
    ? audioRaw
    : audioRaw instanceof Uint8Array
      ? audioRaw.buffer.slice(audioRaw.byteOffset, audioRaw.byteOffset + audioRaw.byteLength)
      : await new Response(audioRaw as BodyInit).arrayBuffer();
  const audioResult = new Uint8Array(audioBuffer);
  const key = `audio/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
  await env.STORAGE.put(key, audioResult, {
    customMetadata: { text: text.slice(0, 200) },
  });
  return JSON.stringify({
    audio_key: key,
    size_bytes: audioResult.byteLength,
    model: "@cf/deepgram/aura-2-en",
  });
}

// ── Speech-to-Text (Workers AI Whisper) ───────────────────────

async function speechToText(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const audioPath = args.audio_path || args.path || "";
  if (!audioPath) return "speech-to-text requires audio_path";
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
  const catResult = await sandbox.exec(`base64 "${audioPath}"`, { timeout: 10 });
  if (catResult.exitCode !== 0) return `Could not read audio file: ${catResult.stderr}`;
  const audioBytes = Uint8Array.from(atob(catResult.stdout.trim()), (c) => c.charCodeAt(0));
  const whisperResult = (await env.AI.run("@cf/openai/whisper" as keyof AiModels, {
    audio: [...audioBytes],
  })) as any;
  return JSON.stringify({ text: whisperResult.text || "", language: whisperResult.language || "" });
}

// ── Dynamic Exec (JS in sandboxed V8 isolate) ────────────────
//
// Security model (per CF Dynamic Workers API reference):
//   - globalOutbound: null → completely blocks network (fetch/connect throw)
//   - env: {} → zero bindings, isolate cannot access secrets, DB, storage
//   - Code runs in a fresh V8 isolate with millisecond startup
//
// For network access, agents should use the `http-request` tool instead,
// which runs in the parent worker with full observability and control.
// dynamic-exec is for pure computation only.

async function dynamicExec(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const code = args.code || "";
  const language = args.language || "javascript";
  const timeout = args.timeout_ms || 10000;
  if (language === "javascript" || language === "python") {
    const workerCode = `const __o=[],__e=[];console.log=(...a)=>__o.push(a.map(String).join(" "));console.error=(...a)=>__e.push(a.map(String).join(" "));export default{async fetch(){try{${code};return Response.json({stdout:__o.join("\\n"),stderr:__e.join("\\n"),exit_code:0})}catch(e){return Response.json({stdout:__o.join("\\n"),stderr:e.message||String(e),exit_code:1})}}}`;

    // Sandboxed: no bindings, no network access
    const loaded = await env.LOADER.load({
      compatibilityDate: "2026-03-01",
      mainModule: "agent.js",
      modules: { "agent.js": workerCode },
      env: {},              // Zero bindings — no HYPERDRIVE, STORAGE, VECTORIZE, secrets
      globalOutbound: null, // Fully blocked — fetch() and connect() throw in isolate
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const execResp = await loaded.fetch("http://internal/run", { signal: controller.signal });
    clearTimeout(timer);
    return JSON.stringify(await execResp.json());
  }
  // bash/shell
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
  const r = await sandbox.exec(code, { timeout: Math.ceil(timeout / 1000) });
  return JSON.stringify({ stdout: r.stdout || "", stderr: r.stderr || "", exit_code: r.exitCode ?? 0 });
}

// ── Web Crawl (CF Browser Rendering) ─────────────────────────

async function webCrawl(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const brBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering`;
  const brAuth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
  const startResp = await fetch(`${brBase}/crawl`, {
    method: "POST",
    headers: brAuth,
    body: JSON.stringify({
      url: args.url || "",
      limit: args.max_pages || 10,
      depth: args.max_depth || 2,
      formats: ["markdown"],
      render: true,
    }),
  });
  const startData = (await startResp.json()) as any;
  const jobId = startData.result;
  if (!jobId) return JSON.stringify(startData);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollResp = await fetch(`${brBase}/crawl/${jobId}?limit=100`, { headers: brAuth });
    const pollData = (await pollResp.json()) as any;
    const status = pollData.result?.status;
    if (status === "completed" || status === "errored" || status?.startsWith("cancelled")) {
      return JSON.stringify(pollData);
    }
  }
  const finalResp = await fetch(`${brBase}/crawl/${jobId}?limit=100`, { headers: brAuth });
  return JSON.stringify(await finalResp.json());
}

// ── Browser Render (CF Browser Rendering) ────────────────────

async function browserRender(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const brBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering`;
  const brAuth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
  const actionMap: Record<string, string> = { markdown: "markdown", text: "markdown", html: "content", links: "links", screenshot: "screenshot" };
  const endpoint = actionMap[args.action || "markdown"] || "markdown";
  const payload: Record<string, any> = { url: args.url || "" };
  if (args.wait_for) payload.waitForSelector = args.wait_for;
  const resp = await fetch(`${brBase}/${endpoint}`, { method: "POST", headers: brAuth, body: JSON.stringify(payload) });
  if (endpoint === "screenshot") {
    const buf = await resp.arrayBuffer();
    return JSON.stringify({ screenshot_base64: btoa(String.fromCharCode(...new Uint8Array(buf))), url: args.url });
  }
  return JSON.stringify(await resp.json());
}

// ── Save/Load Project (Sandbox <-> R2) ───────────────────────

async function saveProject(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const workspace = args.workspace || "/workspace";
  // Default org_id and agent_name from session context — agent shouldn't need to specify these
  const orgId = args.org_id || "default";
  const agentName = args.agent_name || sessionId.split("-")[0] || "agent";
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
  const tarResult = await sandbox.exec(`cd ${workspace} 2>/dev/null && tar czf /tmp/workspace.tar.gz . 2>/dev/null || echo "__EMPTY__"`, { timeout: 30 });
  if (tarResult.stdout?.includes("__EMPTY__")) return `No files found in ${workspace}`;
  const b64Result = await sandbox.exec(`base64 /tmp/workspace.tar.gz`, { timeout: 30 });
  const b64Data = b64Result.stdout?.trim() || "";
  if (!b64Data) return "Failed to read workspace archive";
  const projectId = args.project_id || "default";
  const r2Key = `workspaces/${orgId}/${projectId}/${agentName}/latest.tar.gz`;
  const versionKey = `workspaces/${orgId}/${projectId}/${agentName}/v${Date.now()}.tar.gz`;
  const bytes = Uint8Array.from(atob(b64Data), (c) => c.charCodeAt(0));
  await env.STORAGE.put(r2Key, bytes, { customMetadata: { org_id: orgId, agent_name: agentName, saved_at: new Date().toISOString() } });
  await env.STORAGE.put(versionKey, bytes, { customMetadata: { org_id: orgId, agent_name: agentName, saved_at: new Date().toISOString() } });
  const countResult = await sandbox.exec(`find ${workspace} -type f | wc -l`, { timeout: 5 });
  return JSON.stringify({ saved: true, r2_key: r2Key, version_key: versionKey, files: parseInt(countResult.stdout?.trim() || "0"), size_bytes: bytes.byteLength });
}

async function loadProject(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const workspace = args.workspace || "/workspace";
  const orgId = args.org_id || "default";
  const agentName = args.agent_name || sessionId.split("-")[0] || "agent";
  const version = args.version || "latest";
  const projectId = args.project_id || "default";
  const r2Key = version === "latest"
    ? `workspaces/${orgId}/${projectId}/${agentName}/latest.tar.gz`
    : `workspaces/${orgId}/${projectId}/${agentName}/${version}.tar.gz`;
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
  const obj = await env.STORAGE.get(r2Key);
  if (!obj) return JSON.stringify({ loaded: false, reason: "No saved workspace found." });
  const buf = await obj.arrayBuffer();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  await sandbox.writeFile("/tmp/workspace.tar.gz.b64", b64);
  await sandbox.exec(`mkdir -p ${workspace}`, { timeout: 5 });
  await sandbox.exec(`base64 -d /tmp/workspace.tar.gz.b64 > /tmp/workspace.tar.gz && cd ${workspace} && tar xzf /tmp/workspace.tar.gz`, { timeout: 30 });
  const countResult = await sandbox.exec(`find ${workspace} -type f | wc -l`, { timeout: 5 });
  return JSON.stringify({ loaded: true, r2_key: r2Key, files: parseInt(countResult.stdout?.trim() || "0"), size_bytes: buf.byteLength });
}

async function listProjectVersions(env: RuntimeEnv, args: Record<string, any>): Promise<string> {
  const orgId = args.org_id || "";
  const agentName = args.agent_name || "";
  if (!orgId || !agentName) return "list-project-versions requires org_id and agent_name";
  const prefix = `workspaces/${orgId}/${args.project_id || "default"}/${agentName}/`;
  const listed = await env.STORAGE.list({ prefix, limit: 50 });
  const versions = listed.objects.map((o: any) => ({ key: o.key.replace(prefix, ""), size: o.size, uploaded: o.uploaded }));
  return JSON.stringify({ versions, count: versions.length });
}

// ── Todo (session-scoped) ────────────────────────────────────

async function todoTool(env: RuntimeEnv, args: Record<string, any>, sessionId: string): Promise<string> {
  const action = args.action || "list";
  const sandbox = getSandbox(env.SANDBOX, `session-${sessionId}`);
  const todoFile = "/tmp/todos.json";
  let todos: any[] = [];
  try {
    const readResult = await sandbox.exec(`cat ${todoFile} 2>/dev/null || echo "[]"`, { timeout: 5 });
    todos = JSON.parse(readResult.stdout || "[]");
  } catch { todos = []; }
  if (action === "add") {
    todos.push({ id: todos.length + 1, text: args.text || "", done: false });
    await sandbox.writeFile(todoFile, JSON.stringify(todos));
    return `Added todo #${todos.length}: ${args.text}`;
  } else if (action === "complete") {
    const id = args.id || args.todo_id;
    const t = todos.find((t: any) => t.id == id);
    if (t) { t.done = true; await sandbox.writeFile(todoFile, JSON.stringify(todos)); return `Completed todo #${id}`; }
    return `Todo #${id} not found`;
  }
  return todos.length > 0
    ? todos.map((t: any) => `${t.done ? "done" : "open"} #${t.id}: ${t.text}`).join("\n")
    : "No todos yet. Use action='add' with text to create one.";
}

// ── Tool Definitions (for LLM function calling) ───────────────

/** Meta-tools always available regardless of agent config. */
const ALWAYS_AVAILABLE = new Set(["discover-api", "execute-code"]);

export function getToolDefinitions(enabledTools: string[]): ToolDefinition[] {
  const all = TOOL_CATALOG;
  if (enabledTools.length === 0) return all;
  return all.filter(
    (t) => enabledTools.includes(t.function.name) || ALWAYS_AVAILABLE.has(t.function.name),
  );
}

const TOOL_CATALOG: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "web-search",
      description: "Search the web for current information using Brave Search",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse",
      description: "Fetch and read a web page as clean text",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to browse" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http-request",
      description: "Make an HTTP request to any URL",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target URL" },
          method: { type: "string", description: "HTTP method (default GET)" },
          headers: { type: "object", description: "Request headers" },
          body: { type: "string", description: "Request body" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a bash command in a sandboxed container",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          timeout_seconds: { type: "number", description: "Timeout (default 30, max 120)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "python-exec",
      description: "Execute Python code in a sandboxed container",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python code to execute" },
          timeout_seconds: { type: "number", description: "Timeout (default 30, max 120)" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read-file",
      description: "Read a file from the sandbox filesystem",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write-file",
      description: "Write content to a file in the sandbox",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit-file",
      description: "Edit a file by replacing old text with new text",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          old_text: { type: "string", description: "Text to find" },
          new_text: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "knowledge-search",
      description: "Search the agent's knowledge base for relevant information",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          top_k: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "store-knowledge",
      description: "Store information in the knowledge base for future retrieval",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Content to store" },
          key: { type: "string", description: "Label/key for the knowledge" },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "image-generate",
      description: "Generate an image from a text prompt",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Image description prompt" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "text-to-speech",
      description: "Convert text to audio speech",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to speak" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search for patterns in files using grep",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern" },
          path: { type: "string", description: "Directory to search (default .)" },
          max_results: { type: "number", description: "Max results (default 20)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. *.py)" },
          path: { type: "string", description: "Directory to search (default .)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dynamic-exec",
      description: "Execute code in a sandboxed V8 isolate (JS) or container (bash/python)",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Code to execute" },
          language: { type: "string", description: "Language: javascript, python, or bash" },
          timeout_ms: { type: "number", description: "Timeout in ms (default 10000)" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web-crawl",
      description: "Crawl a website and extract content as markdown",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to crawl" },
          max_pages: { type: "number", description: "Max pages (default 10)" },
          max_depth: { type: "number", description: "Max link depth (default 2)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser-render",
      description: "Render a web page using a headless browser (JS rendering)",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to render" },
          action: { type: "string", description: "Action: markdown, html, links, screenshot" },
          wait_for: { type: "string", description: "CSS selector to wait for" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "a2a-send",
      description: "Send a task to another agent via A2A protocol",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target agent A2A endpoint URL" },
          task: { type: "string", description: "Task message to send" },
        },
        required: ["url", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save-project",
      description: "Save the current workspace to persistent storage",
      parameters: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace path (default /workspace)" },
          org_id: { type: "string", description: "Organization ID" },
          agent_name: { type: "string", description: "Agent name" },
          project_id: { type: "string", description: "Project ID" },
        },
        required: ["org_id", "agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load-project",
      description: "Load a saved workspace from persistent storage",
      parameters: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace path (default /workspace)" },
          org_id: { type: "string", description: "Organization ID" },
          agent_name: { type: "string", description: "Agent name" },
          project_id: { type: "string", description: "Project ID" },
          version: { type: "string", description: "Version to load (default latest)" },
        },
        required: ["org_id", "agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo",
      description: "Manage a session-scoped todo list (add, complete, list)",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: list, add, complete" },
          text: { type: "string", description: "Todo text (for add)" },
          id: { type: "number", description: "Todo ID (for complete)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discover-api",
      description:
        "Discover what APIs and tools are available. Returns TypeScript type definitions " +
        "describing all callable functions. Use this before execute-code to understand " +
        "what operations you can compose together.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute-code",
      description:
        "Write and execute JavaScript code that orchestrates multiple tool calls in a single turn. " +
        "The code runs in an isolated sandbox. All tools are available as typed async functions on " +
        "the `codemode` object. Example: " +
        "`const data = await codemode.webSearch({query: 'weather NYC'}); " +
        "const summary = data.slice(0, 200); return summary;` " +
        "Use discover-api first to see what functions are available.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "JavaScript async function body. Access tools via `codemode.toolName(args)`. " +
              "Must return a value. Example: `const r = await codemode.webSearch({query:'...'}); return r;`",
          },
        },
        required: ["code"],
      },
    },
  },
];
