/**
 * Graph dev tooling routes — validate, lint, autofix, contracts, gate-pack, linear-run, dag-run.
 * Ported from agentos/api/routers/graphs.py.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import {
  validateGraphDefinition,
  validateLinearDeclarativeGraph,
  validateBoundedDagDeclarativeGraph,
} from "../logic/graph-validate";
import { lintGraphDesign, lintPayloadFromResult, summarizeGraphContracts } from "../logic/graph-lint";
import { lintAndAutofixGraph } from "../logic/graph-autofix";
import { latestEvalGate } from "../logic/gate-pack";
import { visualizeGraph, type VizFormat } from "../logic/graph-visualize";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const graphRoutes = new Hono<R>();

// ── Zod schemas ──────────────────────────────────────────────────────

const GraphValidateSchema = z.object({
  graph: z.record(z.unknown()),
});

const GraphLintSchema = z.object({
  graph: z.record(z.unknown()),
  strict: z.boolean().default(false),
});

const GraphAutoFixSchema = z.object({
  graph: z.record(z.unknown()),
  strict: z.boolean().default(false),
  apply: z.boolean().default(true),
});

const GraphContractsValidateSchema = z.object({
  graph: z.record(z.unknown()),
  strict: z.boolean().default(true),
});

const GraphGatePackSchema = z.object({
  agent_name: z.string().min(1),
  graph: z.record(z.unknown()).nullable().optional().default(null),
  strict_graph_lint: z.boolean().default(true),
  eval_file: z.string().nullable().optional().default(null),
  trials: z.number().int().min(1).max(20).default(3),
  min_eval_pass_rate: z.number().min(0).max(1).default(0.85),
  min_eval_trials: z.number().int().min(1).max(1000).default(3),
  target_channel: z.string().min(1).default("staging"),
});

const GraphAgentContextSchema = z.object({
  agent_name: z.string().min(1),
  org_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  channel_user_id: z.string().nullable().optional(),
});

const GraphLinearRunSchema = z
  .object({
    graph: z.record(z.unknown()),
    task: z.string().nullable().optional(),
    input: z.string().nullable().optional(),
    agent_context: GraphAgentContextSchema,
    initial_state: z.record(z.unknown()).default({}),
  })
  .refine((data) => (data.task?.trim() || data.input?.trim()), {
    message: "task or input is required",
  });

const GraphDagRunSchema = z
  .object({
    graph: z.record(z.unknown()),
    task: z.string().nullable().optional(),
    input: z.string().nullable().optional(),
    agent_context: GraphAgentContextSchema,
    initial_state: z.record(z.unknown()).default({}),
    max_branching: z.number().int().min(1).max(8).default(4),
    max_fanin: z.number().int().min(1).max(8).default(4),
  })
  .refine((data) => (data.task?.trim() || data.input?.trim()), {
    message: "task or input is required",
  });

// ── Helpers ──────────────────────────────────────────────────────────

function resolvedTask(body: { task?: string | null; input?: string | null }): string {
  const t = (body.task ?? "").trim();
  if (t) return t;
  return (body.input ?? "").trim();
}

async function loadAgentGraph(
  sql: Awaited<ReturnType<typeof getDbForOrg>>,
  agentName: string,
  orgId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const rows = await sql`
      SELECT config_json FROM agents
      WHERE name = ${agentName} AND org_id = ${orgId}
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    let config: Record<string, unknown>;
    const raw = (rows[0] as Record<string, unknown>).config_json;
    if (typeof raw === "string") {
      config = JSON.parse(raw);
    } else if (typeof raw === "object" && raw !== null) {
      config = raw as Record<string, unknown>;
    } else {
      return null;
    }
    const harness = config.harness;
    if (typeof harness === "object" && harness !== null && !Array.isArray(harness)) {
      const h = harness as Record<string, unknown>;
      for (const key of ["declarative_graph", "graph"]) {
        const g = h[key];
        if (typeof g === "object" && g !== null && !Array.isArray(g)) {
          return g as Record<string, unknown>;
        }
      }
    }
  } catch {
    // non-critical
  }
  return null;
}

// ── POST /graphs/validate ────────────────────────────────────────────

graphRoutes.post("/validate", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphValidateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const result = validateGraphDefinition(parsed.data.graph);
  return c.json({
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    summary: result.summary,
  });
});

// ── POST /graphs/lint ────────────────────────────────────────────────

graphRoutes.post("/lint", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphLintSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const result = lintGraphDesign(parsed.data.graph, { strict: parsed.data.strict });
  return c.json({
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    summary: result.summary,
  });
});

// ── POST /graphs/autofix ─────────────────────────────────────────────

graphRoutes.post("/autofix", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphAutoFixSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const result = lintAndAutofixGraph(parsed.data.graph, {
    strict: parsed.data.strict,
    apply: parsed.data.apply,
  });
  return c.json(result);
});

// ── POST /graphs/contracts/validate ──────────────────────────────────

graphRoutes.post("/contracts/validate", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphContractsValidateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const result = lintGraphDesign(parsed.data.graph, { strict: parsed.data.strict });
  const summary: Record<string, unknown> = { ...(result.summary ?? {}) };
  summary.contracts = summarizeGraphContracts(parsed.data.graph);

  return c.json({
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    summary,
  });
});

// ── POST /graphs/gate-pack ───────────────────────────────────────────

graphRoutes.post("/gate-pack", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphGatePackSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const req = parsed.data;
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify org ownership when agent_name is provided (even with inline graph,
  // the eval gate query uses agent_name — prevent cross-org data leakage)
  if (req.agent_name) {
    const ownerCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${req.agent_name} AND org_id = ${user.org_id} AND is_active = 1
    `.catch(() => []);
    if (ownerCheck.length === 0) {
      return c.json({ error: "Agent not found or not owned by your organization" }, 404);
    }
  }

  // Resolve graph: from body or from agent config
  let graph = req.graph;
  if (!graph) {
    graph = await loadAgentGraph(sql, req.agent_name, user.org_id);
  }
  if (!graph) {
    return c.json(
      {
        error:
          "No declarative graph found for agent (provide graph or store harness.declarative_graph).",
      },
      404,
    );
  }

  // Lint
  const lintResult = lintGraphDesign(graph, { strict: req.strict_graph_lint });
  const lintPayload = lintPayloadFromResult(lintResult);

  // Eval gate
  const evalGate = await latestEvalGate(sql, req.agent_name, {
    minEvalPassRate: req.min_eval_pass_rate,
    minEvalTrials: req.min_eval_trials,
    orgId: user.org_id,
  });

  // Rollout recommendation
  const rollout: Record<string, unknown> = {
    decision: "hold",
    target_channel: req.target_channel,
    reason: "",
    recommended_action: "",
    release_endpoint: `/api/v1/releases/${req.agent_name}/promote?from_channel=draft&to_channel=${req.target_channel}`,
  };

  if (!lintPayload.valid) {
    rollout.reason = "Graph lint failed.";
    rollout.recommended_action = "Run /api/v1/graphs/autofix then re-lint.";
  } else if (evalGate.latest_eval_run === null) {
    rollout.reason = "No eval run found for agent.";
    rollout.recommended_action = req.eval_file
      ? "Run /api/v1/eval/run before promotion."
      : "Provide eval_file and run /api/v1/eval/run before promotion.";
  } else if (!evalGate.passed) {
    const passRate = Number(evalGate.latest_eval_run.pass_rate ?? 0);
    const totalTrials = Number(evalGate.latest_eval_run.total_trials ?? 0);
    rollout.reason = `Eval gate failed (pass_rate=${passRate.toFixed(2)}, trials=${totalTrials}).`;
    rollout.recommended_action =
      "Run targeted eval/experiments and iterate before promotion.";
  } else {
    rollout.decision = "promote_candidate";
    rollout.reason = "Lint and eval gates passed.";
    rollout.recommended_action =
      "Promote to target channel and optionally start canary.";
  }

  return c.json({
    agent_name: req.agent_name,
    graph_lint: lintPayload,
    eval_gate: {
      latest_eval_run: evalGate.latest_eval_run,
      min_eval_pass_rate: req.min_eval_pass_rate,
      min_eval_trials: req.min_eval_trials,
      passed: evalGate.passed,
      eval_run_endpoint: req.eval_file
        ? `/api/v1/eval/run?agent_name=${req.agent_name}&eval_file=${req.eval_file}&trials=${req.trials}`
        : "/api/v1/eval/run",
    },
    rollout,
  });
});

// ── POST /graphs/breakpoints — Set breakpoints on graph nodes ────────

graphRoutes.post("/breakpoints", requireScope("graphs:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const agentName = String(body.agent_name || "").trim();
  const nodeIds = Array.isArray(body.node_ids) ? body.node_ids.map(String) : [];

  if (!agentName) return c.json({ error: "agent_name is required" }, 400);
  if (nodeIds.length === 0) return c.json({ error: "node_ids array is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Load current config
  const rows = await sql`
    SELECT config_json FROM agents
    WHERE name = ${agentName} AND org_id = ${user.org_id} AND is_active = 1
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "Agent not found" }, 404);

  let config: Record<string, unknown>;
  const raw = (rows[0] as Record<string, unknown>).config_json;
  if (typeof raw === "string") {
    try { config = JSON.parse(raw); } catch { config = {}; }
  } else if (typeof raw === "object" && raw !== null) {
    config = raw as Record<string, unknown>;
  } else {
    config = {};
  }

  // Navigate to harness.declarative_graph or declarative_graph
  const harness = (config.harness ?? config) as Record<string, unknown>;
  const graph = (harness.declarative_graph ?? harness.graph ?? {}) as Record<string, unknown>;
  const nodes = (graph.nodes ?? {}) as Record<string, Record<string, unknown>>;

  // Set breakpoint on specified nodes
  const breakpointsSet: string[] = [];
  for (const nodeId of nodeIds) {
    if (nodes[nodeId]) {
      nodes[nodeId].breakpoint = true;
      breakpointsSet.push(nodeId);
    }
  }

  if (breakpointsSet.length === 0) {
    return c.json({ error: "No matching nodes found in graph", provided: nodeIds }, 404);
  }

  // Write back
  if (graph.nodes !== undefined) {
    (graph as Record<string, unknown>).nodes = nodes;
  }
  const configJson = JSON.stringify(config);
  await sql`
    UPDATE agents SET config_json = ${configJson}
    WHERE name = ${agentName} AND org_id = ${user.org_id} AND is_active = 1
  `;

  return c.json({ agent_name: agentName, breakpoints_set: breakpointsSet });
});

// ── DELETE /graphs/breakpoints — Remove all breakpoints ──────────────

graphRoutes.delete("/breakpoints", requireScope("graphs:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const agentName = String(body.agent_name || "").trim();

  if (!agentName) return c.json({ error: "agent_name is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT config_json FROM agents
    WHERE name = ${agentName} AND org_id = ${user.org_id} AND is_active = 1
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "Agent not found" }, 404);

  let config: Record<string, unknown>;
  const raw = (rows[0] as Record<string, unknown>).config_json;
  if (typeof raw === "string") {
    try { config = JSON.parse(raw); } catch { config = {}; }
  } else if (typeof raw === "object" && raw !== null) {
    config = raw as Record<string, unknown>;
  } else {
    config = {};
  }

  const harness = (config.harness ?? config) as Record<string, unknown>;
  const graph = (harness.declarative_graph ?? harness.graph ?? {}) as Record<string, unknown>;
  const nodes = (graph.nodes ?? {}) as Record<string, Record<string, unknown>>;

  let removed = 0;
  for (const nodeId of Object.keys(nodes)) {
    if (nodes[nodeId]?.breakpoint) {
      delete nodes[nodeId].breakpoint;
      removed++;
    }
  }

  if (graph.nodes !== undefined) {
    (graph as Record<string, unknown>).nodes = nodes;
  }
  const configJson = JSON.stringify(config);
  await sql`
    UPDATE agents SET config_json = ${configJson}
    WHERE name = ${agentName} AND org_id = ${user.org_id} AND is_active = 1
  `;

  return c.json({ agent_name: agentName, breakpoints_removed: removed });
});

// ── POST /graphs/linear-run — validate + proxy to runtime worker ─────

graphRoutes.post("/linear-run", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphLinearRunSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const req = parsed.data;

  // Validate linear graph
  let vr;
  try {
    vr = validateLinearDeclarativeGraph(req.graph);
  } catch (err) {
    return c.json({ error: `Graph validation error: ${err}` }, 400);
  }

  if (!vr.valid) {
    return c.json(
      {
        message: "Graph is not a valid linear declarative graph",
        errors: vr.errors,
        warnings: vr.warnings,
      },
      422,
    );
  }

  const summary = (vr.summary ?? {}) as Record<string, unknown>;
  const linearPath = summary.linear_path;
  if (!Array.isArray(linearPath)) {
    return c.json({ error: "Linear validation missing linear_path in summary" }, 500);
  }

  // Forward to runtime worker via service binding
  const forwardPayload = {
    graph: req.graph,
    task: resolvedTask(req),
    agent_context: req.agent_context,
    initial_state: req.initial_state,
    validation: {
      linear_path: linearPath,
      graph_id: summary.graph_id ?? null,
    },
  };

  try {
    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/api/v1/graphs/linear-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forwardPayload),
      }),
    );

    if (resp.status >= 400) {
      let detail: unknown;
      try {
        detail = await resp.json();
      } catch {
        detail = (await resp.text()).slice(0, 2000) || resp.statusText;
      }
      return c.json(detail as Record<string, unknown>, resp.status as 400);
    }

    const result = await resp.json();
    return c.json(result as Record<string, unknown>);
  } catch (err) {
    return c.json({ error: `Edge graph proxy failed: ${err}` }, 502);
  }
});

// ── POST /graphs/validate — Validate graph with optional subgraph expansion ─

const GraphValidateExtendedSchema = z.object({
  graph: z.record(z.unknown()),
  expand_subgraphs: z.boolean().default(true),
  max_branching: z.number().default(4),
  max_fanin: z.number().default(4),
});

graphRoutes.post("/validate", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphValidateExtendedSchema.safeParse(body);
  
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  
  const req = parsed.data;
  
  // Forward to runtime for full validation with subgraph expansion
  try {
    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/api/v1/graphs/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          graph: req.graph,
          expand_subgraphs: req.expand_subgraphs,
          max_branching: req.max_branching,
          max_fanin: req.max_fanin,
        }),
      }),
    );
    
    const result = await resp.json();
    return c.json(result as Record<string, unknown>);
  } catch (err) {
    // Fallback to local validation if runtime unavailable
    const localResult = validateBoundedDagDeclarativeGraph(req.graph, {
      maxBranching: req.max_branching,
      maxFanin: req.max_fanin,
    });
    
    return c.json({
      valid: localResult.valid,
      errors: localResult.errors,
      warnings: [],
      execution_order: (localResult as any).execution_order ?? [],
      expanded_graph: req.expand_subgraphs ? null : undefined,
      from_cache: false,
      runtime_error: String(err),
    });
  }
});

// ── POST /graphs/execute — Execute graph with full runtime ─────────────

const GraphExecuteSchema = z.object({
  graph: z.record(z.unknown()),
  input: z.string(),
  agent_name: z.string().optional(),
  org_id: z.string().optional(),
  max_turns: z.number().default(50),
});

graphRoutes.post("/execute", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphExecuteSchema.safeParse(body);
  
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  
  const req = parsed.data;
  const user = c.get("user");
  
  // Forward to runtime worker
  try {
    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/api/v1/graphs/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          graph: req.graph,
          input: req.input,
          agent_name: req.agent_name,
          org_id: req.org_id || user.org_id,
          max_turns: req.max_turns,
        }),
      }),
    );
    
    if (resp.status >= 400) {
      const detail = await resp.json().catch(() => ({ error: resp.statusText }));
      return c.json(detail as Record<string, unknown>, resp.status as 400);
    }
    
    const result = await resp.json();
    return c.json(result as Record<string, unknown>);
  } catch (err) {
    return c.json({ error: `Execution failed: ${err}` }, 502);
  }
});

// ── POST /graphs/stream — Stream execute graph ─────────────────────────

const GraphStreamSchema = z.object({
  graph: z.record(z.unknown()),
  input: z.string(),
  agent_name: z.string().optional(),
  org_id: z.string().optional(),
});

graphRoutes.post("/stream", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphStreamSchema.safeParse(body);
  
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  
  const req = parsed.data;
  const user = c.get("user");
  
  // Forward to runtime worker for SSE streaming
  try {
    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/api/v1/graphs/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          graph: req.graph,
          input: req.input,
          agent_name: req.agent_name,
          org_id: req.org_id || user.org_id,
        }),
      }),
    );
    
    // Pass through the streaming response
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        "Content-Type": resp.headers.get("Content-Type") || "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (err) {
    return c.json({ error: `Streaming failed: ${err}` }, 502);
  }
});

// ── POST /graphs/export/mermaid — Export graph to Mermaid ──────────────

const GraphExportSchema = z.object({
  graph: z.record(z.unknown()),
  direction: z.enum(["TD", "LR", "BT", "RL"]).default("TD"),
  show_labels: z.boolean().default(true),
});

graphRoutes.post("/export/mermaid", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphExportSchema.safeParse(body);
  
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  
  const req = parsed.data;
  
  // Generate Mermaid diagram locally
  const graphSpec = {
    nodes: Array.isArray(req.graph.nodes) ? req.graph.nodes : [],
    edges: Array.isArray(req.graph.edges) ? req.graph.edges : [],
  };
  
  try {
    const dir = req.direction === "TD" ? "TB" : req.direction;
    const { content } = visualizeGraph(graphSpec, "mermaid", {
      direction: dir as "TB" | "LR" | "BT" | "RL",
      showConfig: req.show_labels,
    });
    
    return c.json({ mermaid: content });
  } catch (e: any) {
    return c.json({ error: `Export failed: ${e.message}` }, 500);
  }
});

// ── POST /graphs/visualize ───────────────────────────────────────────

const GraphVisualizeSchema = z.object({
  graph: z.record(z.unknown()),
  format: z.enum(["mermaid", "dot", "svg"]).default("mermaid"),
  direction: z.enum(["TB", "LR", "BT", "RL"]).default("TB"),
  show_config: z.boolean().default(false),
  highlight_path: z.array(z.string()).optional(),
  theme: z.enum(["default", "dark"]).default("default"),
});

graphRoutes.post("/visualize", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphVisualizeSchema.safeParse(body);
  
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  
  const req = parsed.data;
  
  // Normalize graph structure
  const graphSpec = {
    nodes: Array.isArray(req.graph.nodes) ? req.graph.nodes : [],
    edges: Array.isArray(req.graph.edges) ? req.graph.edges : [],
  };
  
  try {
    const { content, contentType } = visualizeGraph(
      graphSpec,
      req.format as VizFormat,
      {
        direction: req.direction,
        showConfig: req.show_config,
        highlightPath: req.highlight_path || [],
        theme: req.theme,
      }
    );
    
    return new Response(content, {
      headers: { "Content-Type": contentType },
    });
  } catch (e: any) {
    return c.json({ error: `Visualization failed: ${e.message}` }, 500);
  }
});

// ── POST /graphs/dag-run — validate + proxy to runtime worker ────────

graphRoutes.post("/dag-run", requireScope("graphs:write"), async (c) => {
  const body = await c.req.json();
  const parsed = GraphDagRunSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const req = parsed.data;

  // Validate bounded DAG
  let vr;
  try {
    vr = validateBoundedDagDeclarativeGraph(req.graph, {
      maxBranching: req.max_branching,
      maxFanin: req.max_fanin,
    });
  } catch (err) {
    return c.json({ error: `Graph validation error: ${err}` }, 400);
  }

  if (!vr.valid) {
    return c.json(
      {
        message: "Graph is not a valid bounded DAG",
        errors: vr.errors,
        warnings: vr.warnings,
      },
      422,
    );
  }

  const summary = (vr.summary ?? {}) as Record<string, unknown>;
  const executionOrder = summary.execution_order;
  if (!Array.isArray(executionOrder)) {
    return c.json({ error: "DAG validation missing execution_order in summary" }, 500);
  }

  // Forward to runtime worker via service binding
  const forwardPayload = {
    graph: req.graph,
    task: resolvedTask(req),
    agent_context: req.agent_context,
    initial_state: req.initial_state,
    max_branching: req.max_branching,
    max_fanin: req.max_fanin,
    validation: {
      execution_order: executionOrder,
      graph_id: summary.graph_id ?? null,
    },
  };

  try {
    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/api/v1/graphs/dag-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forwardPayload),
      }),
    );

    if (resp.status >= 400) {
      let detail: unknown;
      try {
        detail = await resp.json();
      } catch {
        detail = (await resp.text()).slice(0, 2000) || resp.statusText;
      }
      return c.json(detail as Record<string, unknown>, resp.status as 400);
    }

    const result = await resp.json();
    return c.json(result as Record<string, unknown>);
  } catch (err) {
    return c.json({ error: `Edge graph proxy failed: ${err}` }, 502);
  }
});
