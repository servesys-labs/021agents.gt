/**
 * Sub-graph support — modular composition for agent graphs.
 * 
 * Allows graphs to reference other graphs as nodes, enabling:
 * - Reusable components (research, analysis, generation)
 * - Recursive agent patterns
 * - Library of pre-built graph templates
 */

import type { GraphSpec, GraphAgentContext, LinearTraceEntry } from "./linear_declarative";
import type { RuntimeEnv } from "./types";

// ── Types ────────────────────────────────────────────────────────────

export interface SubgraphDefinition {
  subgraph_id: string;
  name: string;
  version: string;
  graph: GraphSpec;
  input_mapping: Record<string, string>; // Map parent vars → subgraph inputs
  output_mapping: Record<string, string>; // Map subgraph outputs → parent vars
  description?: string;
  org_id?: string;
  is_public?: boolean;
}

export interface SubgraphNodeConfig {
  kind: "subgraph";
  subgraph_id: string;
  version?: string; // Specific version or "latest"
  inputs: Record<string, string | { ref: string; path?: string }>; // Static or from parent state
  outputs?: Record<string, string>; // Map output names to parent state keys
  timeout_seconds?: number;
  max_turns?: number;
}

export interface SubgraphRegistry {
  get(id: string, version?: string): Promise<SubgraphDefinition | null>;
  load(id: string, env: RuntimeEnv, version?: string): Promise<SubgraphDefinition | null>;
  list(): Promise<SubgraphDefinition[]>;
  listFromDb(env: RuntimeEnv, orgId?: string): Promise<SubgraphDefinition[]>;
  register(def: SubgraphDefinition): Promise<void>;
  loadBuiltins?(): void;
}

// ── In-Memory Registry (for runtime) ────────────────────────────────

class MemorySubgraphRegistry implements SubgraphRegistry {
  private graphs = new Map<string, SubgraphDefinition>();
  
  async get(id: string, version?: string): Promise<SubgraphDefinition | null> {
    const key = version ? `${id}@${version}` : id;
    return this.graphs.get(key) || null;
  }
  
  async load(id: string, env: RuntimeEnv, version?: string): Promise<SubgraphDefinition | null> {
    // First try memory
    const fromMemory = await this.get(id, version);
    if (fromMemory) return fromMemory;
    
    // Then try database
    const fromDb = await this.loadFromDb(id, env, version);
    if (fromDb) {
      // Cache in memory
      await this.register(fromDb);
      return fromDb;
    }
    
    return null;
  }
  
  private async loadFromDb(id: string, env: RuntimeEnv, version?: string): Promise<SubgraphDefinition | null> {
    if (!env.HYPERDRIVE) return null;
    
    try {
      const pg = (await import("postgres")).default;
      const sql = pg(env.HYPERDRIVE.connectionString, {
        max: 1,
        fetch_types: false,
        prepare: false,
        idle_timeout: 2,
        connect_timeout: 3,
      });
      
      // Try by subgraph_id first, then by name
      let result;
      if (version) {
        result = await sql`
          SELECT subgraph_id, name, version, description, graph_json, 
                 input_schema, output_schema, org_id, is_public
          FROM subgraph_definitions
          WHERE (subgraph_id = ${id} OR name = ${id}) AND version = ${version}
          LIMIT 1
        `;
      } else {
        // Get latest version
        result = await sql`
          SELECT subgraph_id, name, version, description, graph_json, 
                 input_schema, output_schema, org_id, is_public
          FROM subgraph_definitions
          WHERE subgraph_id = ${id} OR name = ${id}
          ORDER BY version DESC
          LIMIT 1
        `;
      }
      
      if (result.length === 0) return null;
      
      const row = result[0];
      return {
        subgraph_id: row.subgraph_id,
        name: row.name,
        version: row.version,
        description: row.description,
        graph: row.graph_json as GraphSpec,
        input_mapping: (row.input_schema as Record<string, string>) || {},
        output_mapping: (row.output_schema as Record<string, string>) || {},
        org_id: row.org_id,
        is_public: row.is_public,
      };
    } catch (err) {
      console.error("[subgraph] Failed to load from DB:", err);
      return null;
    }
  }
  
  async list(): Promise<SubgraphDefinition[]> {
    return Array.from(this.graphs.values());
  }
  
  async listFromDb(env: RuntimeEnv, orgId?: string): Promise<SubgraphDefinition[]> {
    if (!env.HYPERDRIVE) return [];
    
    try {
      const pg = (await import("postgres")).default;
      const sql = pg(env.HYPERDRIVE.connectionString, {
        max: 1,
        fetch_types: false,
        prepare: false,
        idle_timeout: 2,
        connect_timeout: 3,
      });
      
      const result = orgId 
        ? await sql`
            SELECT subgraph_id, name, version, description, graph_json, 
                   input_schema, output_schema, org_id, is_public
            FROM subgraph_definitions
            WHERE org_id = ${orgId} OR is_public = true
            ORDER BY name, version
          `
        : await sql`
            SELECT subgraph_id, name, version, description, graph_json, 
                   input_schema, output_schema, org_id, is_public
            FROM subgraph_definitions
            WHERE is_public = true
            ORDER BY name, version
          `;
      
      return result.map(row => ({
        subgraph_id: row.subgraph_id,
        name: row.name,
        version: row.version,
        description: row.description,
        graph: row.graph_json as GraphSpec,
        input_mapping: (row.input_schema as Record<string, string>) || {},
        output_mapping: (row.output_schema as Record<string, string>) || {},
        org_id: row.org_id,
        is_public: row.is_public,
      }));
    } catch (err) {
      console.error("[subgraph] Failed to list from DB:", err);
      return [];
    }
  }
  
  async register(def: SubgraphDefinition): Promise<void> {
    const key = `${def.subgraph_id}@${def.version}`;
    this.graphs.set(key, def);
    // Also register as "latest"
    this.graphs.set(def.subgraph_id, def);
  }
  
  loadBuiltins(): void {
    // Register built-in subgraphs
    this.register({
      subgraph_id: "web-research",
      name: "Web Research",
      version: "1.0.0",
      description: "Search web, crawl pages, synthesize findings",
      graph: {
        nodes: [
          { id: "search", type: "tool", config: { tool: "web_search", query: "{{inputs.query}}" } },
          { id: "crawl", type: "tool", config: { tool: "web_crawl", urls: "{{search.results}}" } },
          { id: "synthesize", type: "llm", config: { prompt: "Synthesize: {{crawl.content}}" } },
        ],
        edges: [
          { source: "search", target: "crawl" },
          { source: "crawl", target: "synthesize" },
        ],
      },
      input_mapping: { query: "search.query" },
      output_mapping: { summary: "synthesize.output", sources: "crawl.urls" },
    });
    
    this.register({
      subgraph_id: "code-review",
      name: "Code Review",
      version: "1.0.0",
      description: "Review code for bugs, style, security",
      graph: {
        nodes: [
          { id: "parse", type: "tool", config: { tool: "code_parse", code: "{{inputs.code}}" } },
          { id: "analyze", type: "llm", config: { prompt: "Review code: {{parse.ast}}" } },
          { id: "format", type: "output", config: { format: "json" } },
        ],
        edges: [
          { source: "parse", target: "analyze" },
          { source: "analyze", target: "format" },
        ],
      },
      input_mapping: { code: "parse.code", language: "parse.language" },
      output_mapping: { review: "format.output", issues: "analyze.issues" },
    });
  }
}

export const subgraphRegistry: SubgraphRegistry = new MemorySubgraphRegistry();

// Initialize built-ins
subgraphRegistry.loadBuiltins?.();

// ── Subgraph Resolution ─────────────────────────────────────────────

interface ResolveContext {
  parentState: Record<string, unknown>;
  agentContext: GraphAgentContext;
}

/**
 * Resolve input values for a subgraph from parent context.
 */
export function resolveSubgraphInputs(
  config: SubgraphNodeConfig,
  ctx: ResolveContext
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(config.inputs)) {
    if (typeof value === "string") {
      // Static value or template
      inputs[key] = interpolateTemplate(value, ctx.parentState);
    } else if (value && typeof value === "object" && "ref" in value) {
      // Reference to parent state
      const ref = value as { ref: string; path?: string };
      let val = ctx.parentState[ref.ref];
      
      if (ref.path && val !== undefined) {
        val = getPath(val, ref.path);
      }
      
      inputs[key] = val;
    }
  }
  
  return inputs;
}

/**
 * Map subgraph outputs back to parent state.
 */
export function mapSubgraphOutputs(
  config: SubgraphNodeConfig,
  subgraphOutputs: Record<string, unknown>
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  const mapping = config.outputs || {};
  
  for (const [parentKey, subgraphKey] of Object.entries(mapping)) {
    outputs[parentKey] = subgraphOutputs[subgraphKey];
  }
  
  return outputs;
}

/**
 * Expand a graph inline, replacing subgraph nodes with their definitions.
 * Returns a flattened graph with namespaced node IDs.
 * 
 * Supports recursive expansion up to maxDepth levels.
 */
export async function expandSubgraphs(
  graph: GraphSpec,
  env?: RuntimeEnv,
  registry: SubgraphRegistry = subgraphRegistry,
  currentDepth: number = 0,
  maxDepth: number = 3
): Promise<GraphSpec> {
  if (currentDepth >= maxDepth) {
    console.warn(`[subgraph] Maximum expansion depth (${maxDepth}) reached`);
    return graph;
  }
  
  const expanded: GraphSpec = { nodes: [], edges: [] };
  const subgraphInstances: Array<{
    instanceId: string;
    subgraph: SubgraphDefinition;
    originalNodeId: string;
  }> = [];
  
  // First pass: collect subgraph nodes
  for (const node of graph.nodes) {
    const hasSubgraphId = node.config && typeof (node.config as Record<string, unknown>).subgraph_id === "string";
    if (node.type === "subgraph" || hasSubgraphId) {
      const config = (node.config as unknown as SubgraphNodeConfig) || { kind: "subgraph", subgraph_id: node.id, inputs: {} };
      // Try to load from DB if env provided, otherwise from memory
      const subgraph = env 
        ? await registry.load(config.subgraph_id, env, config.version)
        : await registry.get(config.subgraph_id, config.version);
      
      if (!subgraph) {
        throw new Error(`Subgraph not found: ${config.subgraph_id}@${config.version || "latest"}`);
      }
      
      // Recursively expand the subgraph itself
      const nestedExpanded = await expandSubgraphs(
        subgraph.graph,
        env,
        registry,
        currentDepth + 1,
        maxDepth
      );
      
      subgraphInstances.push({
        instanceId: node.id,
        subgraph: { ...subgraph, graph: nestedExpanded },
        originalNodeId: node.id,
      });
    }
  }
  
  // Second pass: expand nodes
  for (const node of graph.nodes) {
    const isSubgraph = subgraphInstances.some(si => si.originalNodeId === node.id);
    
    if (isSubgraph) {
      // Replace with subgraph nodes (namespaced)
      const instance = subgraphInstances.find(si => si.originalNodeId === node.id)!;
      const prefix = `${instance.originalNodeId}::`;
      
      for (const subNode of instance.subgraph.graph.nodes) {
        expanded.nodes.push({
          ...subNode,
          id: `${prefix}${subNode.id}`,
          // Merge config with any overrides from parent
          config: { ...subNode.config, ...(node.config || {}) },
        });
      }
      
      // Add edges (namespaced)
      for (const subEdge of instance.subgraph.graph.edges) {
        expanded.edges.push({
          ...subEdge,
          source: `${prefix}${(subEdge as any).source || (subEdge as any).from}`,
          target: `${prefix}${(subEdge as any).target || (subEdge as any).to}`,
        });
      }
    } else {
      // Regular node, copy as-is
      expanded.nodes.push(node);
    }
  }
  
  // Third pass: rewrite edges that connect to/from subgraphs
  for (const edge of graph.edges) {
    const source = String((edge as any).source || (edge as any).from || "");
    const target = String((edge as any).target || (edge as any).to || "");
    
    const sourceInstance = subgraphInstances.find(si => si.originalNodeId === source);
    const targetInstance = subgraphInstances.find(si => si.originalNodeId === target);
    
    if (!sourceInstance && !targetInstance) {
      // Regular edge
      expanded.edges.push(edge);
    } else if (sourceInstance && !targetInstance) {
      // Edge from subgraph to regular node - connect to subgraph's final node(s)
      const finalNodes = findFinalNodes(sourceInstance.subgraph.graph);
      for (const finalId of finalNodes) {
        expanded.edges.push({
          ...edge,
          source: `${sourceInstance.originalNodeId}::${finalId}`,
          target,
        });
      }
    } else if (!sourceInstance && targetInstance) {
      // Edge from regular node to subgraph - connect to subgraph's entry node(s)
      const entryNodes = findEntryNodes(targetInstance.subgraph.graph);
      for (const entryId of entryNodes) {
        expanded.edges.push({
          ...edge,
          source,
          target: `${targetInstance.originalNodeId}::${entryId}`,
        });
      }
    }
    // If both are subgraphs, the internal edges handle it
  }
  
  return expanded;
}

// ── Helpers ─────────────────────────────────────────────────────────

function interpolateTemplate(template: string, state: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = state[key];
    return val !== undefined ? String(val) : match;
  });
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function findEntryNodes(graph: GraphSpec): string[] {
  const allTargets = new Set<string>();
  for (const e of graph.edges) {
    allTargets.add(String((e as any).target || (e as any).to));
  }
  
  const entries: string[] = [];
  for (const n of graph.nodes) {
    if (!allTargets.has(n.id)) {
      entries.push(n.id);
    }
  }
  return entries.length > 0 ? entries : [graph.nodes[0]?.id].filter(Boolean);
}

function findFinalNodes(graph: GraphSpec): string[] {
  const allSources = new Set<string>();
  for (const e of graph.edges) {
    allSources.add(String((e as any).source || (e as any).from));
  }
  
  const finals: string[] = [];
  for (const n of graph.nodes) {
    if (!allSources.has(n.id)) {
      finals.push(n.id);
    }
  }
  return finals.length > 0 ? finals : [graph.nodes[graph.nodes.length - 1]?.id].filter(Boolean);
}

// ── Validation ──────────────────────────────────────────────────────

export interface SubgraphValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSubgraphNode(
  config: SubgraphNodeConfig,
  subgraph: SubgraphDefinition | null
): SubgraphValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  if (!subgraph) {
    errors.push(`Subgraph not found: ${config.subgraph_id}@${config.version || "latest"}`);
    return { valid: false, errors, warnings };
  }
  
  // Check required inputs
  for (const required of Object.keys(subgraph.input_mapping)) {
    if (!(required in config.inputs)) {
      errors.push(`Missing required input: ${required}`);
    }
  }
  
  // Warn about extra inputs
  for (const provided of Object.keys(config.inputs)) {
    if (!(provided in subgraph.input_mapping)) {
      warnings.push(`Unrecognized input: ${provided}`);
    }
  }
  
  // Check outputs if specified
  if (config.outputs) {
    const availableOutputs = new Set(Object.keys(subgraph.output_mapping));
    for (const [parentKey, subgraphKey] of Object.entries(config.outputs)) {
      if (!availableOutputs.has(subgraphKey)) {
        errors.push(`Invalid output mapping: ${parentKey} -> ${subgraphKey} (not in subgraph outputs)`);
      }
    }
  }
  
  return { valid: errors.length === 0, errors, warnings };
}
