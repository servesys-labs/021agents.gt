/**
 * Extensible Node Kinds Registry.
 * 
 * Allows registering custom node types without modifying core runtime.
 * Supports:
 * - Built-in node kinds (fresh_bootstrap, fresh_tools, etc.)
 * - Custom JavaScript handlers
 * - External service calls
 * - Subgraph references
 */

import type { GraphSpec, GraphAgentContext } from "./linear_declarative";
import type { RuntimeEnv } from "./types";

// ── Types ────────────────────────────────────────────────────────────

export type NodeHandlerResult = 
  | { next: string; state?: Record<string, unknown> }
  | { halt: true; output: string }
  | { error: string };

export interface NodeHandlerContext {
  env: RuntimeEnv;
  state: Record<string, unknown>;
  agentContext: GraphAgentContext;
  config: Record<string, unknown>;
  nodeId: string;
}

export type NodeHandler = (
  input: unknown,
  ctx: NodeHandlerContext
) => Promise<NodeHandlerResult> | NodeHandlerResult;

export interface NodeKindDefinition {
  kind: string;
  version: string;
  description: string;
  
  // Schema for validation
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
  
  // The handler function
  handler: NodeHandler;
  
  // Execution properties
  properties: {
    deterministic: boolean;      // Same input → same output?
    sideEffects: boolean;        // Modifies external state?
    async: boolean;             // Returns Promise?
    parallelizable: boolean;    // Can run in parallel?
    maxRetries?: number;        // Auto-retry on failure
    timeoutMs?: number;         // Execution timeout
  };
  
  // Cost model
  costModel?: {
    flat_usd: number;
    per_ms_usd: number;
    per_token_input?: number;
    per_token_output?: number;
  };
}

// ── Registry Implementation ─────────────────────────────────────────

class NodeKindRegistry {
  private handlers = new Map<string, NodeKindDefinition>();
  private aliases = new Map<string, string>(); // alias → canonical kind
  
  register(def: NodeKindDefinition): void {
    const key = `${def.kind}@${def.version}`;
    this.handlers.set(key, def);
    this.handlers.set(def.kind, def); // Also as "latest"
  }
  
  alias(aliasName: string, canonicalKind: string): void {
    this.aliases.set(aliasName, canonicalKind);
  }
  
  get(kind: string, version?: string): NodeKindDefinition | undefined {
    // Resolve alias
    const canonical = this.aliases.get(kind) || kind;
    
    if (version) {
      return this.handlers.get(`${canonical}@${version}`);
    }
    return this.handlers.get(canonical);
  }
  
  list(): NodeKindDefinition[] {
    const seen = new Set<string>();
    const result: NodeKindDefinition[] = [];
    
    for (const [key, def] of this.handlers.entries()) {
      if (!key.includes("@") && !seen.has(def.kind)) {
        seen.add(def.kind);
        result.push(def);
      }
    }
    
    return result;
  }
  
  async execute(
    kind: string,
    input: unknown,
    ctx: NodeHandlerContext
  ): Promise<NodeHandlerResult> {
    const def = this.get(kind);
    if (!def) {
      return { error: `Unknown node kind: ${kind}` };
    }
    
    // Apply timeout if configured
    if (def.properties.timeoutMs && def.properties.async) {
      return Promise.race([
        def.handler(input, ctx),
        new Promise<NodeHandlerResult>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Node ${kind} timed out after ${def.properties.timeoutMs}ms`)),
            def.properties.timeoutMs
          )
        ),
      ]);
    }
    
    return def.handler(input, ctx);
  }
}

export const nodeRegistry = new NodeKindRegistry();

// ── Built-in Node Kinds ─────────────────────────────────────────────

nodeRegistry.register({
  kind: "fresh_bootstrap",
  version: "1.0.0",
  description: "Initialize agent context and state",
  handler: (input, ctx) => {
    return {
      next: "fresh_turn_budget",
      state: {
        ...ctx.state,
        initialized: true,
        startTime: Date.now(),
      },
    };
  },
  properties: {
    deterministic: true,
    sideEffects: false,
    async: false,
    parallelizable: false,
  },
});

nodeRegistry.register({
  kind: "fresh_turn_budget",
  version: "1.0.0",
  description: "Check if budget exceeded",
  handler: (input, ctx) => {
    const cost = (ctx.state.cumulativeCost || 0) as number;
    const budget = (ctx.state.config as { budget_limit_usd?: number })?.budget_limit_usd ?? 10;
    
    if (cost >= budget) {
      return { halt: true, output: "Budget exhausted" };
    }
    
    return { next: "fresh_summarize" };
  },
  properties: {
    deterministic: true,
    sideEffects: false,
    async: false,
    parallelizable: false,
  },
});

nodeRegistry.register({
  kind: "fresh_summarize",
  version: "1.0.0",
  description: "Summarize conversation if needed",
  handler: async (input, ctx) => {
    // Simplified - real implementation would check token count
    const messages = (ctx.state.messages || []) as unknown[];
    if (messages.length > 20) {
      // Would trigger summarization
      ctx.state.summary = "[Conversation summarized]";
    }
    return { next: "fresh_route_llm" };
  },
  properties: {
    deterministic: false,
    sideEffects: false,
    async: true,
    parallelizable: false,
  },
});

nodeRegistry.register({
  kind: "fresh_route_llm",
  version: "1.0.0",
  description: "Route to appropriate LLM based on complexity",
  handler: async (input, ctx) => {
    // This is a placeholder - real implementation calls LLM
    return { next: "fresh_post_llm" };
  },
  properties: {
    deterministic: false,
    sideEffects: false,
    async: true,
    parallelizable: false,
  },
  costModel: {
    flat_usd: 0,
    per_ms_usd: 0,
    per_token_input: 0.000001,
    per_token_output: 0.000002,
  },
});

nodeRegistry.register({
  kind: "fresh_tools",
  version: "1.0.0",
  description: "Execute tool calls",
  handler: async (input, ctx) => {
    // Handled by actual tool executor
    return { next: "fresh_after_tools" };
  },
  properties: {
    deterministic: false,
    sideEffects: true,
    async: true,
    parallelizable: true,
  },
});

nodeRegistry.register({
  kind: "fresh_loop_detect",
  version: "1.0.0",
  description: "Detect and prevent infinite loops",
  handler: (input, ctx) => {
    const turnCount = ((ctx.state.turnCount || 0) as number) + 1;
    ctx.state.turnCount = turnCount;
    
    if (turnCount > 50) {
      return { halt: true, output: "Max turns exceeded" };
    }
    
    return { next: "fresh_turn_budget" };
  },
  properties: {
    deterministic: true,
    sideEffects: false,
    async: false,
    parallelizable: false,
  },
});

nodeRegistry.register({
  kind: "fresh_final_answer",
  version: "1.0.0",
  description: "Produce final response",
  handler: (input, ctx) => {
    const output = (ctx.state.lastResponse || "") as string;
    return { halt: true, output };
  },
  properties: {
    deterministic: true,
    sideEffects: false,
    async: false,
    parallelizable: false,
  },
});

// ── Codemode Node Kinds ──────────────────────────────────────────────
// These are handled by executeCodemodeNode in declarative-executor.ts.
// Registering them here makes them discoverable via listAvailableNodes()
// and validates config via validateNodeConfig().

nodeRegistry.register({
  kind: "codemode",
  version: "1.0.0",
  description: "Execute user-defined JavaScript in a sandboxed V8 isolate. Supports tool calls via RPC.",
  configSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "JavaScript code to execute" },
      snippet_id: { type: "string", description: "ID of a stored codemode snippet (alternative to inline code)" },
      scope: { type: "string", enum: ["agent", "graph_node", "transform", "validator", "webhook", "middleware", "orchestrator", "observability", "test", "mcp_generator"] },
      scope_config: { type: "object", description: "Override scope defaults (allowedTools, timeoutMs, etc.)" },
      globals: { type: "object", description: "Extra variables injected into sandbox" },
    },
  },
  handler: async (input, ctx) => {
    // Actual execution is in declarative-executor.ts executeCodemodeNode
    // This handler is only used if called via nodeRegistry.execute() directly
    return { next: ctx.config.on_success as string || "default", state: { codemodeResult: input } };
  },
  properties: {
    deterministic: false,
    sideEffects: true,
    async: true,
    parallelizable: true,
    timeoutMs: 60_000,
  },
  costModel: {
    flat_usd: 0,
    per_ms_usd: 0.000012, // $0.012/s V8 isolate compute
  },
});

nodeRegistry.register({
  kind: "codemode_transform",
  version: "1.0.0",
  description: "Data transformation via sandboxed JavaScript. Input available as `input`, returns transformed data.",
  configSchema: {
    type: "object",
    properties: {
      code: { type: "string" },
      snippet_id: { type: "string" },
      scope_config: { type: "object" },
    },
  },
  handler: async (input, ctx) => {
    return { next: ctx.config.on_success as string || "default", state: { transformResult: input } };
  },
  properties: {
    deterministic: false,
    sideEffects: false,
    async: true,
    parallelizable: true,
    timeoutMs: 30_000,
  },
  costModel: {
    flat_usd: 0,
    per_ms_usd: 0.000012,
  },
});

nodeRegistry.register({
  kind: "codemode_validator",
  version: "1.0.0",
  description: "Custom validation via sandboxed JavaScript. Returns {valid: boolean, errors: string[]}.",
  configSchema: {
    type: "object",
    properties: {
      code: { type: "string" },
      snippet_id: { type: "string" },
      scope_config: { type: "object" },
    },
  },
  handler: async (input, ctx) => {
    return { next: ctx.config.on_success as string || "default", state: { validationResult: input } };
  },
  properties: {
    deterministic: false,
    sideEffects: false,
    async: true,
    parallelizable: true,
    timeoutMs: 10_000,
  },
  costModel: {
    flat_usd: 0,
    per_ms_usd: 0.000012,
  },
});

nodeRegistry.register({
  kind: "codemode_middleware",
  version: "1.0.0",
  description: "Pluggable middleware hook. Returns {action: 'continue'|'interrupt'|'modify'|'summarize'|'redirect', ...}.",
  configSchema: {
    type: "object",
    properties: {
      code: { type: "string" },
      snippet_id: { type: "string" },
      hook_point: { type: "string", enum: ["pre_llm", "post_llm", "pre_tool", "post_tool", "pre_output"] },
      scope_config: { type: "object" },
    },
  },
  handler: async (input, ctx) => {
    return { next: ctx.config.on_success as string || "default", state: { middlewareResult: input } };
  },
  properties: {
    deterministic: false,
    sideEffects: false,
    async: true,
    parallelizable: false,
    timeoutMs: 5_000,
  },
  costModel: {
    flat_usd: 0,
    per_ms_usd: 0.000012,
  },
});

// ── Custom Node Registration API ────────────────────────────────────

/**
 * Register a custom node kind at runtime.
 * 
 * Example:
 * ```typescript
 * registerCustomNode({
 *   kind: "my_custom_filter",
 *   version: "1.0.0",
 *   description: "Filter inappropriate content",
 *   handler: async (input, ctx) => {
 *     const text = String(input);
 *     if (await isInappropriate(text)) {
 *       return { error: "Content flagged" };
 *     }
 *     return { next: ctx.config.on_success || "default" };
 *   },
 *   properties: { deterministic: false, sideEffects: true, async: true, parallelizable: false },
 * });
 * ```
 */
export function registerCustomNode(def: NodeKindDefinition): void {
  // Validate handler is provided
  if (!def.handler) {
    throw new Error(`Node kind ${def.kind} must have a handler`);
  }
  
  // Set defaults - merge with provided properties
  def.properties = {
    deterministic: def.properties?.deterministic ?? true,
    sideEffects: def.properties?.sideEffects ?? false,
    async: def.properties?.async ?? false,
    parallelizable: def.properties?.parallelizable ?? false,
    maxRetries: def.properties?.maxRetries ?? 0,
    timeoutMs: def.properties?.timeoutMs ?? 30000,
  };
  
  nodeRegistry.register(def);
}

/**
 * Create a node kind that calls an external service.
 */
export function createExternalServiceNode(
  spec: {
    kind: string;
    endpoint: string;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    timeoutMs?: number;
    retries?: number;
  }
): NodeKindDefinition {
  return {
    kind: spec.kind,
    version: "1.0.0",
    description: `External service: ${spec.endpoint}`,
    handler: async (input, ctx) => {
      const url = spec.endpoint.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return String((ctx.state as any)[key] || match);
      });
      
      const response = await fetch(url, {
        method: spec.method || "POST",
        headers: {
          "Content-Type": "application/json",
          ...spec.headers,
        },
        body: JSON.stringify(input),
      });
      
      if (!response.ok) {
        return { error: `External service failed: ${response.status}` };
      }
      
      const result = await response.json();
      return {
        next: ctx.config.on_success as string || "default",
        state: { ...ctx.state, externalResult: result },
      };
    },
    properties: {
      deterministic: false,
      sideEffects: true,
      async: true,
      parallelizable: false,
      maxRetries: spec.retries || 3,
      timeoutMs: spec.timeoutMs || 30000,
    },
  };
}

// ── Node Discovery ──────────────────────────────────────────────────

export interface NodeKindInfo {
  kind: string;
  version: string;
  description: string;
  properties: NodeKindDefinition["properties"];
  hasCostModel: boolean;
}

export function listAvailableNodes(): NodeKindInfo[] {
  return nodeRegistry.list().map(def => ({
    kind: def.kind,
    version: def.version,
    description: def.description,
    properties: def.properties,
    hasCostModel: !!def.costModel,
  }));
}

// ── Validation ──────────────────────────────────────────────────────

export interface NodeValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateNodeConfig(
  kind: string,
  config: Record<string, unknown>
): NodeValidationResult {
  const def = nodeRegistry.get(kind);
  if (!def) {
    return { valid: false, errors: [`Unknown node kind: ${kind}`] };
  }
  
  const errors: string[] = [];
  
  // Check required config fields
  if (def.configSchema?.required) {
    for (const req of def.configSchema.required as string[]) {
      if (!(req in config)) {
        errors.push(`Missing required config: ${req}`);
      }
    }
  }
  
  // Validate config types (simplified)
  if (def.configSchema?.properties) {
    for (const [key, schema] of Object.entries(def.configSchema.properties)) {
      if (key in config) {
        const expectedType = (schema as any).type;
        const actualType = typeof config[key];
        if (expectedType && actualType !== expectedType) {
          errors.push(`Config ${key} should be ${expectedType}, got ${actualType}`);
        }
      }
    }
  }
  
  return { valid: errors.length === 0, errors };
}
